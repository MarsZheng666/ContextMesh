import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { ArchivePostgresStore } from './archives.js'
import { MeshError } from '../../protocol/src/index.js'
import {
  archiveBlockBytes,
  archiveSha256,
} from '../../protocol/src/archives.js'
import {
  sharedInfo,
  sharedCreate,
  sharedAppend,
  sharedActivity,
  sharedDshItem,
  type SharedInfo,
  type SharedItem,
} from '../../protocol/src/shared.js'

const hash = (value: string) => createHash('sha256').update(value).digest('hex')

export class SharedPostgresStore extends ArchivePostgresStore {
  private info(row: any): SharedInfo {
    return sharedInfo.parse({
      id: row.id,
      title: row.title,
      scope: row.scope,
      source: {
        adapter: row.source_adapter,
        id: row.source_id,
        incarnation: row.incarnation,
      },
      generation: Number(row.generation),
      nextSeq: Number(row.next_seq),
      activity: row.activity,
      reservation: row.reservation,
    })
  }
  private async shared(db: PoolClient, ns: string, id: string) {
    const row = (
      await db.query(
        'SELECT * FROM cm_shared_sessions WHERE namespace=$1 AND id=$2 FOR UPDATE',
        [ns, id],
      )
    ).rows[0]
    if (!row)
      throw new MeshError('NOT_FOUND', 'Shared conversation not found', 404)
    return row
  }
  async createShared(
    ns: string,
    publisher: string,
    input: z.infer<typeof sharedCreate>,
  ) {
    return this.tx(async (db) => {
      const source = input.source
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        ns + ':share:' + source.adapter + ':' + source.id,
      ])
      const old = (
        await db.query(
          'SELECT share_id FROM cm_shared_bindings WHERE namespace=$1 AND adapter=$2 AND source_id=$3 AND incarnation=$4',
          [ns, source.adapter, source.id, source.incarnation],
        )
      ).rows[0]
      if (old) {
        const row = await this.shared(db, ns, old.share_id)
        if (
          source.adapter === 'codex' &&
          row.writer_hash !== hash(input.writerToken)
        )
          throw new MeshError(
            'ALREADY_SHARED',
            'This conversation already has a publisher. Follow its existing shared conversation.',
          )
        return this.info(row)
      }
      if (source.adapter === 'deepseek') {
        const native = await this.session(db, ns, source.id)
        if (
          native.adapter !== 'deepseek' ||
          native.incarnation !== source.incarnation ||
          !native.materialized
        )
          throw new MeshError(
            'SOURCE_CHANGED',
            'Open the current conversation before sharing',
          )
      }
      const row = (
        await db.query(
          `INSERT INTO cm_shared_sessions(namespace,id,title,scope,source_adapter,source_id,incarnation,writer_hash,publisher)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [
            ns,
            input.id,
            input.title,
            input.scope,
            source.adapter,
            source.id,
            source.incarnation,
            hash(input.writerToken),
            publisher,
          ],
        )
      ).rows[0]
      await db.query(
        'INSERT INTO cm_shared_bindings VALUES($1,$2,$3,$4,$5,0)',
        [ns, source.adapter, source.id, source.incarnation, input.id],
      )
      return this.info(row)
    })
  }
  async listShared(ns: string) {
    return (
      await this.pool.query(
        'SELECT * FROM cm_shared_sessions WHERE namespace=$1 ORDER BY id',
        [ns],
      )
    ).rows.map((row) => this.info(row))
  }
  async findShared(ns: string, adapter: string, id: string) {
    const row = (
      await this.pool.query(
        `SELECT s.* FROM cm_shared_sessions s JOIN cm_shared_bindings b ON b.namespace=s.namespace AND b.share_id=s.id
      WHERE b.namespace=$1 AND b.adapter=$2 AND b.source_id=$3 ORDER BY b.generation DESC LIMIT 1`,
        [ns, adapter, id],
      )
    ).rows[0]
    return row ? this.info(row) : null
  }
  private async sharedRecord(
    db: PoolClient,
    ns: string,
    row: any,
    eventId: string,
    item: SharedItem,
    content: unknown,
    bytes: number,
  ) {
    const prior = (
      await db.query(
        'SELECT seq,item,content FROM cm_shared_events WHERE namespace=$1 AND share_id=$2 AND event_id=$3',
        [ns, row.id, eventId],
      )
    ).rows[0]
    if (prior) {
      // JSONB reorders object keys. Compare canonical JSONB values in the database.
      const equal = (
        await db.query(
          'SELECT $1::jsonb=$2::jsonb AND $3::jsonb=$4::jsonb AS same',
          [
            JSON.stringify(prior.item),
            JSON.stringify(item),
            JSON.stringify(prior.content),
            JSON.stringify(content),
          ],
        )
      ).rows[0].same
      if (!equal)
        throw new MeshError(
          'EVENT_CONFLICT',
          'The event identity was already used for different data',
        )
      return Number(prior.seq)
    }
    if (item.status === 'running') {
      const latest = (
        await db.query(
          "SELECT seq,item FROM cm_shared_events WHERE namespace=$1 AND share_id=$2 AND item->>'key'=$3 ORDER BY seq DESC LIMIT 1",
          [ns, row.id, item.key],
        )
      ).rows[0]
      if (
        latest &&
        ['completed', 'failed', 'declined'].includes(latest.item.status)
      )
        return Number(latest.seq)
    }
    const seq = Number(row.next_seq)
    await db.query(
      'INSERT INTO cm_shared_events VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        ns,
        row.id,
        seq,
        eventId,
        JSON.stringify(item),
        JSON.stringify(content),
        bytes,
      ],
    )
    row.next_seq = seq + 1
    await db.query(
      'UPDATE cm_shared_sessions SET next_seq=$3 WHERE namespace=$1 AND id=$2',
      [ns, row.id, row.next_seq],
    )
    return seq
  }
  private async projectDsh(db: PoolClient, ns: string, row: any) {
    if (row.source_adapter !== 'deepseek') return false
    const native = (
      await db.query(
        'SELECT next_seq,incarnation FROM cm_sessions WHERE namespace=$1 AND id=$2',
        [ns, row.source_id],
      )
    ).rows[0]
    if (!native || native.incarnation !== row.incarnation)
      throw new MeshError(
        'SOURCE_CHANGED',
        'The source history changed; review this shared conversation',
      )
    const offset = Number(row.source_offset)
    const events = (
      await db.query(
        'SELECT seq,event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND seq >= $3 ORDER BY seq LIMIT 200',
        [ns, row.source_id, offset],
      )
    ).rows
    for (const stored of events) {
      const event = JSON.parse(stored.event)
      const item = sharedDshItem(event, row.scope)
      if (item) {
        const { text, ...metadata } = item
        await this.sharedRecord(
          db,
          ns,
          row,
          `dsh:${row.generation}:${stored.seq}`,
          {
            ...metadata,
            key: `${row.generation}:${item.key}`,
            preview: text.slice(0, 240),
          },
          {
            native: {
              id: row.source_id,
              incarnation: row.incarnation,
              seq: Number(stored.seq),
            },
          },
          Buffer.byteLength(text),
        )
      }
      row.source_offset = Number(stored.seq) + 1
    }
    await db.query(
      'UPDATE cm_shared_sessions SET source_offset=$3 WHERE namespace=$1 AND id=$2',
      [ns, row.id, row.source_offset],
    )
    return Number(row.source_offset) < Number(native.next_seq)
  }
  async pullShared(ns: string, id: string, after: number) {
    return this.tx(async (db) => {
      const row = await this.shared(db, ns, id)
      const pending = await this.projectDsh(db, ns, row)
      if (after > Number(row.next_seq))
        throw new MeshError(
          'CURSOR_INVALID',
          'The saved position is ahead of the shared history',
        )
      const events = (
        await db.query(
          'SELECT seq,item,bytes FROM cm_shared_events WHERE namespace=$1 AND share_id=$2 AND seq >= $3 ORDER BY seq LIMIT 200',
          [ns, id, after],
        )
      ).rows.map((value) => ({
        ...value.item,
        seq: Number(value.seq),
        bytes: Number(value.bytes),
      }))
      const next = after + events.length
      return {
        share: this.info(row),
        events,
        next,
        more: pending || next < Number(row.next_seq),
      }
    })
  }
  private authorize(
    row: any,
    publisher: string,
    request: { generation: number; writerToken: string },
  ) {
    if (
      row.publisher !== publisher ||
      row.writer_hash !== hash(request.writerToken) ||
      Number(row.generation) !== request.generation ||
      row.activity === 'reserved'
    )
      throw new MeshError(
        'OWNERSHIP_LOST',
        'This conversation is now followed here. Open its current device to continue.',
      )
  }
  async appendShared(
    ns: string,
    publisher: string,
    id: string,
    input: z.infer<typeof sharedAppend>,
  ) {
    return this.tx(async (db) => {
      const row = await this.shared(db, ns, id)
      this.authorize(row, publisher, input)
      if (row.source_adapter !== 'codex')
        throw new MeshError(
          'ADAPTER_MISMATCH',
          'DSH records are collected from the persisted native log',
        )
      if (row.scope === 'text' && input.item.role === 'reference')
        throw new MeshError(
          'SHARING_SCOPE',
          'This conversation shares text only',
        )
      const { content, ...item } = input.item
      let bytes = 0
      for (const digest of content.blocks) {
        const block = (
          await db.query(
            'SELECT octet_length(data) AS bytes FROM cm_shared_blocks WHERE namespace=$1 AND digest=$2',
            [ns, digest],
          )
        ).rows[0]
        if (!block)
          throw new MeshError(
            'CONTENT_PENDING',
            'Upload all content blocks before publishing the record',
          )
        bytes += block.bytes
      }
      if (bytes !== content.bytes)
        throw new MeshError(
          'CONTENT_INVALID',
          'Content length does not match its blocks',
        )
      const seq = await this.sharedRecord(
        db,
        ns,
        row,
        `${row.generation}:${input.eventId}`,
        { ...item, key: `${row.generation}:${item.key}` },
        content,
        bytes,
      )
      return { seq, share: this.info(row) }
    })
  }
  async sharedActivity(
    ns: string,
    publisher: string,
    id: string,
    input: z.infer<typeof sharedActivity>,
  ) {
    return this.tx(async (db) => {
      const row = await this.shared(db, ns, id)
      this.authorize(row, publisher, input)
      if (row.active_turn && row.active_turn !== input.turn) {
        // A delayed Stop must never mark a newer prompt idle or block its outbox.
        if (input.state === 'idle') return { accepted: false }
        if (row.active_tools.length)
          throw new MeshError(
            'TURN_CHANGED',
            'Wait for the previous tools to finish',
          )
      }
      const tools = new Set<string>(row.active_tools)
      if (input.tool) {
        if (input.state === 'busy') tools.add(input.tool)
        else tools.delete(input.tool)
      }
      const stopped = input.tool
        ? row.active_turn === input.turn && row.stop_requested
        : input.state === 'idle'
      const activity = stopped && !tools.size ? 'idle' : 'busy'
      await db.query(
        'UPDATE cm_shared_sessions SET activity=$3,active_turn=$4,active_tools=$5,stop_requested=$6 WHERE namespace=$1 AND id=$2',
        [ns, id, activity, input.turn, [...tools], stopped],
      )
      return { accepted: true }
    })
  }
  async adoptSharedCodex(
    ns: string,
    publisher: string,
    id: string,
    input: {
      generation: number
      targetSessionId: string
      threadId: string
      writerToken: string
    },
  ) {
    return this.tx(async (db) => {
      const row = await this.shared(db, ns, id)
      if (
        row.source_adapter === 'codex' &&
        row.source_id === input.threadId &&
        row.writer_hash === hash(input.writerToken)
      )
        return this.info(row)
      if (
        Number(row.generation) !== input.generation ||
        row.source_adapter !== 'deepseek'
      )
        throw new MeshError('OWNERSHIP_LOST', 'The shared source changed')
      const source = await this.session(db, ns, row.source_id)
      const target = await this.session(db, ns, input.targetSessionId)
      const header = JSON.parse(target.header)
      if (
        source.successor_session !== target.id ||
        target.adapter !== 'codex' ||
        header.nativeThreadId !== input.threadId
      )
        throw new MeshError(
          'HANDOFF_PENDING',
          'Wait for the confirmed ownership transfer',
        )
      while (await this.projectDsh(db, ns, row)) {}
      await db.query(
        `UPDATE cm_shared_sessions SET source_adapter='codex',source_id=$3::text,incarnation=$3::text::uuid,generation=generation+1,
        writer_hash=$4,publisher=$5,activity='unknown',source_offset=0,active_turn=NULL,active_tools='{}',stop_requested=false WHERE namespace=$1 AND id=$2`,
        [ns, id, input.threadId, hash(input.writerToken), publisher],
      )
      await db.query(
        "INSERT INTO cm_shared_bindings VALUES($1,'codex',$2::text,$2::text::uuid,$3,$4)",
        [ns, input.threadId, id, Number(row.generation) + 1],
      )
      return this.info(await this.shared(db, ns, id))
    })
  }
  async reserveShared(
    ns: string,
    id: string,
    input: {
      generation: number
      operationId: string
      cut: number
      archiveId: string
    },
  ) {
    return this.tx(async (db) => {
      const row = await this.shared(db, ns, id)
      if (
        row.reservation === input.operationId &&
        row.reservation_archive === input.archiveId
      )
        return this.info(row)
      if (
        Number(row.generation) !== input.generation ||
        row.source_adapter !== 'codex' ||
        row.activity !== 'idle' ||
        Number(row.next_seq) !== input.cut
      )
        throw new MeshError(
          'SOURCE_BUSY',
          'Wait for the current turn and its tools to finish, then prepare a fresh continuation',
        )
      const archive = (
        await db.query(
          'SELECT manifest FROM cm_archives WHERE namespace=$1 AND id=$2 AND committed_at IS NOT NULL',
          [ns, input.archiveId],
        )
      ).rows[0]
      const source = archive?.manifest.header.source
      if (
        !source ||
        source.id !== row.source_id ||
        source.incarnation !== row.incarnation ||
        source.eventCount !== input.cut
      )
        throw new MeshError(
          'HISTORY_CHANGED',
          'The prepared history does not match this conversation',
        )
      await db.query(
        "UPDATE cm_shared_sessions SET activity='reserved',reservation=$3,reservation_archive=$4 WHERE namespace=$1 AND id=$2",
        [ns, id, input.operationId, input.archiveId],
      )
      return this.info(await this.shared(db, ns, id))
    })
  }
  async commitSharedDsh(
    ns: string,
    id: string,
    input: { operationId: string; targetSessionId: string },
  ) {
    return this.tx(async (db) => {
      const row = await this.shared(db, ns, id)
      const target = await this.session(db, ns, input.targetSessionId)
      const imported = JSON.parse(target.header).contextmeshImport
      if (
        row.source_adapter === 'deepseek' &&
        row.source_id === target.id &&
        imported?.operationId === input.operationId
      )
        return this.info(row)
      if (
        row.activity !== 'reserved' ||
        row.reservation !== input.operationId ||
        target.adapter !== 'deepseek' ||
        target.active_handle ||
        target.recovery_required ||
        !target.materialized ||
        imported?.operationId !== input.operationId ||
        imported?.archiveId !== row.reservation_archive ||
        Number(target.next_seq) !== imported?.eventCount
      )
        throw new MeshError(
          'TARGET_NOT_READY',
          'Finish preparing the receiving conversation before switching ownership',
        )
      await db.query(
        `UPDATE cm_shared_sessions SET source_adapter='deepseek',source_id=$3,incarnation=$4,generation=generation+1,source_offset=$5,
        activity='unknown',active_turn=NULL,active_tools='{}',stop_requested=false,reservation=NULL WHERE namespace=$1 AND id=$2`,
        [ns, id, target.id, target.incarnation, target.next_seq],
      )
      await db.query(
        "INSERT INTO cm_shared_bindings VALUES($1,'deepseek',$2,$3,$4,$5)",
        [ns, target.id, target.incarnation, id, Number(row.generation) + 1],
      )
      return this.info(await this.shared(db, ns, id))
    })
  }
  async putSharedBlock(
    ns: string,
    digest: string,
    data: Buffer,
    quota: number,
  ) {
    if (
      !data.length ||
      data.length > archiveBlockBytes ||
      archiveSha256(data) !== digest
    )
      throw new MeshError(
        'CONTENT_INVALID',
        'The content block failed validation',
        400,
      )
    await this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        ns + ':shared-quota',
      ])
      if (
        (
          await db.query(
            'SELECT 1 FROM cm_shared_blocks WHERE namespace=$1 AND digest=$2',
            [ns, digest],
          )
        ).rowCount
      )
        return
      const used = Number(
        (
          await db.query(
            'SELECT COALESCE(sum(octet_length(data)),0) AS bytes FROM cm_shared_blocks WHERE namespace=$1',
            [ns],
          )
        ).rows[0].bytes,
      )
      if (used + data.length > quota)
        throw new MeshError(
          'QUOTA_EXCEEDED',
          'Shared history storage is full',
          413,
        )
      await db.query('INSERT INTO cm_shared_blocks VALUES($1,$2,$3)', [
        ns,
        digest,
        data,
      ])
    })
    return { digest }
  }
  async sharedText(
    ns: string,
    id: string,
    seq: number,
    offset: number,
    length: number,
  ) {
    const row = (
      await this.pool.query(
        'SELECT e.content,e.bytes,s.scope FROM cm_shared_events e JOIN cm_shared_sessions s ON e.namespace=s.namespace AND e.share_id=s.id WHERE e.namespace=$1 AND e.share_id=$2 AND e.seq=$3',
        [ns, id, seq],
      )
    ).rows[0]
    if (!row) throw new MeshError('NOT_FOUND', 'Shared record not found', 404)
    let data: Buffer
    if (row.content.native) {
      const ref = row.content.native
      const native = (
        await this.pool.query(
          'SELECT e.event FROM cm_events e JOIN cm_sessions s ON s.namespace=e.namespace AND s.id=e.session_id WHERE e.namespace=$1 AND e.session_id=$2 AND e.seq=$3 AND s.incarnation=$4',
          [ns, ref.id, ref.seq, ref.incarnation],
        )
      ).rows[0]
      if (!native)
        throw new MeshError(
          'SOURCE_CHANGED',
          'The original record is unavailable',
        )
      data = Buffer.from(
        sharedDshItem(JSON.parse(native.event), row.scope)?.text ?? '',
      ).subarray(offset, offset + length)
    } else {
      const chunks: Buffer[] = []
      let start = 0
      for (const digest of row.content.blocks as string[]) {
        const size = (
          await this.pool.query(
            'SELECT octet_length(data) AS bytes FROM cm_shared_blocks WHERE namespace=$1 AND digest=$2',
            [ns, digest],
          )
        ).rows[0]?.bytes
        if (!size)
          throw new MeshError('CORRUPTION', 'Shared content is incomplete', 422)
        if (start + size > offset && start < offset + length) {
          const block = (
            await this.pool.query(
              'SELECT data FROM cm_shared_blocks WHERE namespace=$1 AND digest=$2',
              [ns, digest],
            )
          ).rows[0].data as Buffer
          if (archiveSha256(block) !== digest)
            throw new MeshError(
              'CORRUPTION',
              'Shared content failed verification',
              422,
            )
          chunks.push(
            block.subarray(
              Math.max(0, offset - start),
              Math.min(size, offset + length - start),
            ),
          )
        }
        start += size
        if (start >= offset + length) break
      }
      data = Buffer.concat(chunks)
    }
    return {
      data: data.toString('base64'),
      next:
        offset + data.length < Number(row.bytes) ? offset + data.length : null,
    }
  }
}
