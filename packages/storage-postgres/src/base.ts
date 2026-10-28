import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import {
  MeshError,
  sessionSchema,
  type RemoteHandle,
  type SessionSnapshot,
  type StoredEvent,
  type StoredHeader,
} from '../../protocol/src/index.js'
import { migrate, assertDurability } from './migration.js'

export interface Row {
  id: string
  adapter: 'deepseek'
  header: string
  incarnation: string
  inherited_count: string
  next_seq: string
  generation: string
  materialized: boolean
  creator_instance: string
  epoch: string
  active_handle: string | null
  lease_valid: boolean
  recovery_required: boolean
  active_handoff: string | null
}
interface HandleRow {
  id: string
  session_id: string
  incarnation: string
  access: 'read' | 'write'
  epoch: string
  closed: boolean
}
export interface StoreOptions {
  connectionString: string
  leaseMs?: number
  nodeTimeoutMs?: number
}
export class BasePostgresStore {
  readonly pool: Pool
  readonly leaseMs: number
  readonly nodeTimeoutMs: number
  constructor(options: StoreOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: 10,
      statement_timeout: 10000,
    })
    this.pool.on('error', () => {
      /* Queries report availability; prevent an idle socket error from terminating the process. */
    })
    this.nodeTimeoutMs = options.nodeTimeoutMs ?? 45000
    if (!Number.isSafeInteger(this.nodeTimeoutMs) || this.nodeTimeoutMs < 1000)
      throw new Error('nodeTimeoutMs must be at least 1000')
    this.leaseMs = options.leaseMs ?? 60000
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1000)
      throw new Error('leaseMs must be at least 1000')
  }
  async init(): Promise<void> {
    await assertDurability(this.pool)
    await migrate(this.pool)
  }
  async stop(): Promise<void> {
    await this.pool.end()
  }
  protected snapshot(row: Row): SessionSnapshot {
    try {
      return sessionSchema.parse({
        id: row.id,
        incarnation: row.incarnation,
        adapter: row.adapter,
        header: JSON.parse(row.header),
        inheritedEventCount: Number(row.inherited_count),
        nextSeq: Number(row.next_seq),
        generation: Number(row.generation),
        materialized: row.materialized,
      })
    } catch (error) {
      throw new MeshError(
        'CORRUPTION',
        'stored session metadata is invalid',
        422,
      )
    }
  }
  protected decode(text: string): unknown {
    try {
      return JSON.parse(text)
    } catch {
      throw new MeshError('CORRUPTION', 'stored JSON payload is invalid', 422)
    }
  }
  protected async tx<T>(body: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect()
    try {
      await db.query('BEGIN')
      await db.query("SET LOCAL synchronous_commit = 'on'")
      const result = await body(db)
      await db.query('COMMIT')
      return result
    } catch (error) {
      await db.query('ROLLBACK')
      throw error
    } finally {
      db.release()
    }
  }
  protected async operation<T>(
    ns: string,
    id: string,
    payload: unknown,
    body: (db: PoolClient) => Promise<T>,
  ): Promise<T> {
    const digest = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex')
    return this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${ns}:${id}`,
      ])
      const prior = (
        await db.query(
          'SELECT digest,result FROM cm_operations WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
      ).rows[0]
      if (prior) {
        if (prior.digest !== digest)
          throw new MeshError(
            'IDEMPOTENCY_CONFLICT',
            'operationId already used with different request',
          )
        return JSON.parse(prior.result) as T
      }
      const result = await body(db)
      await db.query(
        'INSERT INTO cm_operations(namespace,id,digest,result) VALUES($1,$2,$3,$4)',
        [ns, id, digest, JSON.stringify(result)],
      )
      return result
    })
  }
  protected async session(
    db: PoolClient,
    ns: string,
    id: string,
  ): Promise<Row> {
    const row = (
      await db.query<Row>(
        'SELECT *, lease_until > clock_timestamp() AS lease_valid FROM cm_sessions WHERE namespace=$1 AND id=$2 FOR UPDATE',
        [ns, id],
      )
    ).rows[0]
    if (!row) throw new MeshError('NOT_FOUND', `session "${id}" not found`, 404)
    return row
  }
  protected async handle(
    db: PoolClient,
    ns: string,
    id: string,
    epoch: number,
    allowClosed = false,
  ): Promise<{ session: Row; handle: HandleRow }> {
    const ref = (
      await db.query('SELECT * FROM cm_handles WHERE namespace=$1 AND id=$2', [
        ns,
        id,
      ])
    ).rows[0]
    if (!ref)
      throw new MeshError('HANDLE_CLOSED', 'unknown or closed handle', 410)
    const session = await this.session(db, ns, ref.session_id)
    const handle = (
      await db.query<HandleRow>(
        'SELECT * FROM cm_handles WHERE namespace=$1 AND id=$2 FOR UPDATE',
        [ns, id],
      )
    ).rows[0]!
    if (handle.incarnation !== session.incarnation)
      throw new MeshError(
        'HANDLE_CLOSED',
        'session incarnation no longer exists',
        410,
      )
    if (handle.closed && !allowClosed)
      throw new MeshError('HANDLE_CLOSED', 'closed handle', 410)
    if (Number(handle.epoch) !== epoch)
      throw new MeshError('OWNERSHIP_LOST', 'write ownership was lost')
    return { session, handle }
  }
  protected assertWriter(session: Row, handle: HandleRow): void {
    if (handle.access !== 'write')
      throw new MeshError('READ_ONLY', 'handle is read-only', 403)
    if (
      session.active_handle !== handle.id ||
      Number(session.epoch) !== Number(handle.epoch) ||
      !session.lease_valid ||
      session.recovery_required
    ) {
      throw new MeshError(
        'OWNERSHIP_LOST',
        'write ownership was lost; explicit recovery is required',
      )
    }
  }
  protected async makeHandle(
    db: PoolClient,
    ns: string,
    row: Row,
    instance: string,
    access: 'read' | 'write',
    epoch: number,
  ): Promise<RemoteHandle> {
    const id = randomUUID()
    await db.query(
      'INSERT INTO cm_handles(namespace,id,session_id,instance_id,access,epoch,incarnation) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [ns, id, row.id, instance, access, epoch, row.incarnation],
    )
    if (access === 'write')
      await db.query(
        "UPDATE cm_sessions SET active_handle=$3,epoch=$4,lease_until=clock_timestamp()+($5::double precision * interval '1 millisecond') WHERE namespace=$1 AND id=$2",
        [ns, row.id, id, epoch, this.leaseMs],
      )
    return { handleId: id, session: this.snapshot(row), access, epoch }
  }
  async create(
    ns: string,
    request: {
      operationId: string
      instanceId: string
      adapter: 'deepseek'
      header: StoredHeader
      inheritedEventCount: number
    },
  ): Promise<RemoteHandle> {
    return this.operation(
      ns,
      request.operationId,
      ['create', request],
      async (db) => {
        if (!request.header.isSeeded && request.inheritedEventCount !== 0) {
          throw new MeshError(
            'INVALID_ARGUMENT',
            'inheritedEventCount does not match isSeeded',
            400,
          )
        }
        const result = await db.query(
          'INSERT INTO cm_sessions(namespace,id,adapter,header,inherited_count,creator_instance,incarnation) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *',
          [
            ns,
            request.header.id,
            request.adapter,
            JSON.stringify(request.header),
            request.inheritedEventCount,
            request.instanceId,
            randomUUID(),
          ],
        )
        if (!result.rows[0])
          throw new MeshError(
            'ALREADY_EXISTS',
            `session "${request.header.id}" already exists`,
          )
        return this.makeHandle(
          db,
          ns,
          result.rows[0],
          request.instanceId,
          'write',
          1,
        )
      },
    )
  }
  async open(
    ns: string,
    id: string,
    request: {
      operationId: string
      instanceId: string
      access: 'read' | 'write'
    },
  ): Promise<RemoteHandle> {
    return this.operation(
      ns,
      request.operationId,
      ['open', id, request],
      async (db) => {
        const row = await this.session(db, ns, id)
        if (!row.materialized && row.creator_instance !== request.instanceId)
          throw new MeshError('NOT_FOUND', `session "${id}" not found`, 404)
        if (request.access === 'write') {
          if (row.active_handoff)
            throw new MeshError(
              'HANDOFF_IN_PROGRESS',
              'session is reserved for handoff',
            )
          if (row.recovery_required || (row.active_handle && !row.lease_valid))
            throw new MeshError(
              'RECOVERY_REQUIRED',
              'previous writer must be confirmed stopped',
            )
          if (row.active_handle)
            throw new MeshError(
              'ALREADY_OWNED',
              `session "${id}" is already owned`,
            )
        }
        return this.makeHandle(
          db,
          ns,
          row,
          request.instanceId,
          request.access,
          Number(row.epoch) + (request.access === 'write' ? 1 : 0),
        )
      },
    )
  }
  async stat(
    ns: string,
    id: string,
    instance: string,
  ): Promise<SessionSnapshot | null> {
    const row = (
      await this.pool.query(
        'SELECT * FROM cm_sessions WHERE namespace=$1 AND id=$2 AND (materialized OR creator_instance=$3)',
        [ns, id, instance],
      )
    ).rows[0]
    return row ? this.snapshot(row) : null
  }
  async list(
    ns: string,
    instance: string,
    after = '',
    limit = 100,
  ): Promise<{ sessions: SessionSnapshot[]; cursor: string | null }> {
    const rows = (
      await this.pool.query(
        'SELECT * FROM cm_sessions WHERE namespace=$1 AND (materialized OR creator_instance=$2) AND id COLLATE "C" > $3 COLLATE "C" ORDER BY id COLLATE "C" LIMIT $4',
        [ns, instance, after, limit + 1],
      )
    ).rows
    return {
      sessions: rows.slice(0, limit).map((row) => this.snapshot(row)),
      cursor: rows.length > limit ? rows[limit - 1].id : null,
    }
  }
  async read(
    ns: string,
    id: string,
    offset: number,
    length: number,
    end?: number,
  ) {
    const handle = (
      await this.pool.query(
        'SELECT * FROM cm_handles WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
    ).rows[0]
    if (!handle || handle.closed)
      throw new MeshError('HANDLE_CLOSED', 'closed handle', 410)
    const row = (
      await this.pool.query(
        'SELECT * FROM cm_sessions WHERE namespace=$1 AND id=$2',
        [ns, handle.session_id],
      )
    ).rows[0]
    if (!row) throw new MeshError('NOT_FOUND', 'session no longer exists', 404)
    if (row.incarnation !== handle.incarnation)
      throw new MeshError(
        'HANDLE_CLOSED',
        'session incarnation no longer exists',
        410,
      )
    const snapshot = this.snapshot(row)
    const cut =
      end === undefined ? snapshot.nextSeq : Math.min(end, snapshot.nextSeq)
    const count = Math.max(0, Math.min(length, cut - offset))
    const events = (
      await this.pool.query(
        'SELECT event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND seq >= $3 AND seq < $4 ORDER BY seq',
        [ns, row.id, offset, offset + count],
      )
    ).rows.map((row) => this.decode(row.event))
    if (events.length !== count)
      throw new MeshError(
        'CORRUPTION',
        'stored event log is not contiguous',
        422,
      )
    return {
      session: snapshot,
      events,
      end: cut,
      nextOffset: offset + events.length,
    }
  }
  async append(
    ns: string,
    id: string,
    r: {
      operationId: string
      epoch: number
      expectedNextSeq: number
      events: StoredEvent[]
    },
  ) {
    return this.operation(ns, r.operationId, ['append', id, r], async (db) => {
      const { session: s, handle: h } = await this.handle(db, ns, id, r.epoch)
      this.assertWriter(s, h)
      if (Number(s.next_seq) !== r.expectedNextSeq)
        throw new MeshError('SEQ_CONFLICT', `expected ${s.next_seq}`)
      for (const [i, event] of r.events.entries())
        if (event.seq !== r.expectedNextSeq + i)
          throw new MeshError(
            'SEQ_CONFLICT',
            `expected ${r.expectedNextSeq + i}`,
          )
      if (r.events.length) {
        await db.query(
          'INSERT INTO cm_events(namespace,session_id,seq,event) SELECT $1,$2,seq,event FROM unnest($3::bigint[],$4::text[]) AS batch(seq,event)',
          [
            ns,
            s.id,
            r.events.map((e) => e.seq),
            r.events.map((e) => JSON.stringify(e)),
          ],
        )
        await db.query(
          'UPDATE cm_sessions SET next_seq=next_seq+$3,generation=generation+1,materialized=true WHERE namespace=$1 AND id=$2',
          [ns, s.id, r.events.length],
        )
      }
      return { nextSeq: r.expectedNextSeq + r.events.length }
    })
  }
  async flush(
    ns: string,
    id: string,
    r: { operationId: string; epoch: number },
  ) {
    return this.operation(ns, r.operationId, ['flush', id, r], async (db) => {
      const { session: s, handle: h } = await this.handle(db, ns, id, r.epoch)
      this.assertWriter(s, h)
      await db.query(
        'UPDATE cm_sessions SET materialized=true WHERE namespace=$1 AND id=$2',
        [ns, s.id],
      )
      return { nextSeq: Number(s.next_seq) }
    })
  }
  async renew(ns: string, id: string, epoch: number) {
    return this.tx(async (db) => {
      const { session: s, handle: h } = await this.handle(db, ns, id, epoch)
      this.assertWriter(s, h)
      await db.query(
        "UPDATE cm_sessions SET lease_until=clock_timestamp()+($3::double precision * interval '1 millisecond') WHERE namespace=$1 AND id=$2",
        [ns, s.id, this.leaseMs],
      )
      return { renewed: true }
    })
  }
  async close(
    ns: string,
    id: string,
    r: { operationId: string; epoch: number; failed?: boolean },
  ) {
    return this.operation(ns, r.operationId, ['close', id, r], async (db) => {
      const h = (
        await db.query(
          'SELECT * FROM cm_handles WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
      ).rows[0]
      if (!h || h.closed) return { closed: true }
      const s = await this.session(db, ns, h.session_id)
      if (h.incarnation !== s.incarnation) {
        await db.query(
          'UPDATE cm_handles SET closed=true WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
        return { closed: true }
      }
      if (Number(h.epoch) !== r.epoch)
        throw new MeshError('OWNERSHIP_LOST', 'wrong handle epoch')
      await db.query(
        'UPDATE cm_handles SET closed=true,close_failed=$3 WHERE namespace=$1 AND id=$2',
        [ns, id, Boolean(r.failed)],
      )
      if (
        h.access === 'write' &&
        s.active_handle === id &&
        Number(s.epoch) === r.epoch
      ) {
        if (!s.materialized)
          await db.query(
            'DELETE FROM cm_sessions WHERE namespace=$1 AND id=$2',
            [ns, s.id],
          )
        else
          await db.query(
            'UPDATE cm_sessions SET active_handle=NULL,lease_until=NULL,recovery_required=$3 WHERE namespace=$1 AND id=$2',
            [ns, s.id, Boolean(r.failed) || !s.lease_valid],
          )
      }
      return { closed: true }
    })
  }
  async recover(ns: string, id: string, operationId: string) {
    return this.operation(ns, operationId, ['recover', id], async (db) => {
      const s = await this.session(db, ns, id)
      if (s.active_handoff)
        throw new MeshError(
          'HANDOFF_IN_PROGRESS',
          'resolve the active handoff explicitly before recovery',
        )
      if (s.active_handle && s.lease_valid)
        throw new MeshError(
          'ALREADY_OWNED',
          'writer lease is still active; stop it or wait for expiry',
        )
      await db.query(
        "UPDATE cm_handles SET closed=true WHERE namespace=$1 AND session_id=$2 AND access='write'",
        [ns, id],
      )
      if (!s.materialized)
        await db.query('DELETE FROM cm_sessions WHERE namespace=$1 AND id=$2', [
          ns,
          id,
        ])
      else
        await db.query(
          'UPDATE cm_sessions SET active_handle=NULL,lease_until=NULL,recovery_required=false,epoch=epoch+1 WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
      return { recovered: true }
    })
  }
  async operationResult(ns: string, id: string) {
    const row = (
      await this.pool.query(
        'SELECT result FROM cm_operations WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
    ).rows[0]
    if (!row)
      throw new MeshError('NOT_FOUND', 'operation has not committed', 404)
    return JSON.parse(row.result)
  }
}
