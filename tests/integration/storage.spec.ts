import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyOwnedError,
  SessionOwnershipLostError,
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
} from '@deepseek-ai/dsh-session-persistence'
import { fixture, TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { MeshError } from '../../packages/protocol/src/index.js'
const header = (id: string = randomUUID()) => ({
  id,
  version: 4,
  createdAt: 1,
  isSeeded: false,
})
const events = [{ seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } }]

describe('remote database and protocol', () => {
  it('reports malformed stored JSON and event envelopes as corruption', async () => {
    const f = await fixture()
    const ctx = await f.mount()
    const id = SessionId(randomUUID())
    const h = await ctx.sessionPersistence.create({
      ...header(id),
      id,
      version: 4,
    })
    await h.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    await f.store.pool.query(
      'UPDATE cm_events SET event=$3 WHERE namespace=$1 AND session_id=$2',
      [f.namespace, id, '{}'],
    )
    await expect(h.read()).rejects.toBeInstanceOf(
      SessionPersistenceCorruptionError,
    )
    await f.store.pool.query(
      'UPDATE cm_events SET event=$3 WHERE namespace=$1 AND session_id=$2',
      [f.namespace, id, '{'],
    )
    await expect(h.read()).rejects.toBeInstanceOf(
      SessionPersistenceCorruptionError,
    )
    await h.close()
  })
  it('commits a batch only once after the response is lost', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    let dropped = false
    const client = new MeshClient({
      endpoint: f.endpoint,
      token: TOKEN,
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        if (String(input).endsWith('/append') && !dropped) {
          dropped = true
          await response.arrayBuffer()
          throw new Error('response lost after commit')
        }
        return response
      },
    })
    const result = await client.append(h, events, randomUUID())
    expect(result.nextSeq).toBe(1)
    expect((await client.read(h, 0, 100)).events).toEqual(events)
    await client.close(h, randomUUID())
  })
  it('rejects a reused operation ID with another payload without changing the log', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    const operation = randomUUID()
    await f.client.append(h, events, operation)
    await expect(
      f.client.append(h, [{ ...events[0]!, time: 2 }], operation),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect((await f.client.read(h, 0, 100)).events).toEqual(events)
    await f.client.close(h, randomUUID())
  })
  it('does not store any prefix of a batch with a sequence gap', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    await expect(
      f.client.append(h, [events[0]!, { ...events[0]!, seq: 2 }], randomUUID()),
    ).rejects.toMatchObject({ code: 'SEQ_CONFLICT' })
    expect((await f.client.read(h, 0, 100)).events).toEqual([])
    await f.client.close(h, randomUUID())
  })
  it('isolates namespaces even with the same native identity', async () => {
    const f = await fixture()
    const id = randomUUID()
    const a = await f.store.create(f.namespace, {
      operationId: randomUUID(),
      instanceId: randomUUID(),
      adapter: 'deepseek',
      header: header(id),
      inheritedEventCount: 0,
    })
    expect(await f.store.stat('another-namespace', id, randomUUID())).toBeNull()
    await expect(
      f.store.read('another-namespace', a.handleId, 0, 10),
    ).rejects.toMatchObject({ code: 'HANDLE_CLOSED' })
    await f.client.close(a, randomUUID())
  })
  it('rejects unauthenticated requests and oversized/nonconforming payloads', async () => {
    const f = await fixture()
    expect((await fetch(`${f.endpoint}/v1/sessions`)).status).toBe(401)
    const result = await f.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { header: { id: 'x' } },
    })
    expect(result.statusCode).toBe(400)
    const huge = await f.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) }),
    })
    expect(huge.statusCode).toBe(413)
  })
  it('allows one remote writer and concurrent readers across provider instances', async () => {
    const f = await fixture()
    const a = await f.mount()
    const b = await f.mount()
    const id = SessionId(randomUUID())
    const h = await a.sessionPersistence.create({
      ...header(id),
      id,
      version: 4,
    })
    await h.flush()
    await expect(b.sessionPersistence.open(id, 'write')).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    )
    const r = await b.sessionPersistence.open(id, 'read')
    expect((await r.read()).events).toEqual([])
    await h.close()
    const next = await b.sessionPersistence.open(id, 'write')
    await next.close()
    await r.close()
  })
  it('fences an expired writer and requires explicit stopped-process recovery', async () => {
    const f = await fixture()
    const a = await f.mount()
    const b = await f.mount()
    const id = SessionId(randomUUID())
    const h = await a.sessionPersistence.create({
      ...header(id),
      id,
      version: 4,
    })
    await h.flush()
    await f.store.pool.query(
      "UPDATE cm_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
      [f.namespace, id],
    )
    await expect(
      h.append([
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      ]),
    ).rejects.toBeInstanceOf(SessionOwnershipLostError)
    await expect(b.sessionPersistence.open(id, 'write')).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    })
    await f.store.recover(f.namespace, id, randomUUID())
    const next = await b.sessionPersistence.open(id, 'write')
    await next.flush()
    await h.close().catch(() => {})
    await expect(b.sessionPersistence.open(id, 'write')).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    )
    await next.close()
  })
  it('preserves fork metadata and unknown ignorable records across reopen', async () => {
    const f = await fixture()
    const a = await f.mount()
    const id = SessionId(randomUUID())
    const { SessionLogOffset } = await import('@deepseek-ai/dsh-session')
    const h = await f.client.create({ ...header(id), isSeeded: true }, 1)
    await f.client.append(
      h,
      [
        {
          ...events[0]!,
          type: 'future/record',
          ignorable: true,
          data: { value: 'retained' },
        },
      ],
      randomUUID(),
    )
    await f.client.close(h, randomUUID())
    const b = await f.mount()
    const r = await b.sessionPersistence.open(id, 'read')
    expect(r.inheritedEventCount).toBe(1)
    expect((await r.read()).events[0]?.type).toBe('future/record')
    await r.close()
  })
  it('round-trips nested JSON types, empty arrays, NUL and unpaired Unicode without coercion', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    const batch = [
      {
        ...events[0]!,
        data: {
          number: 1,
          flag: true,
          nil: null,
          empty: [],
          single: ['x'],
          nested: { text: '\u0000\ud800' },
        },
      },
    ]
    await f.client.append(h, batch, randomUUID())
    expect((await f.client.read(h, 0, 100)).events).toEqual(batch)
    await f.client.close(h, randomUUID())
  })
  it('does not let an old read handle observe a reused pending identity', async () => {
    const f = await fixture()
    const first = await f.client.create(header(), 0)
    const reader = await f.client.open(first.session.id, 'read')
    await f.client.close(first, randomUUID())
    const next = await f.client.create(header(first.session.id), 0)
    await f.client.flush(next, randomUUID())
    await expect(f.client.read(reader, 0, 100)).rejects.toMatchObject({
      code: 'HANDLE_CLOSED',
    })
    await f.client.close(reader, randomUUID())
    await f.client.close(next, randomUUID())
  })
  it('pins multi-page reads to the original prefix and preserves a batch larger than one page', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    const first = Array.from({ length: 512 }, (_, seq) => ({
      ...events[0]!,
      seq,
    }))
    await f.client.append(h, first, randomUUID())
    await f.client.append(h, [{ ...events[0]!, seq: 512 }], randomUUID())
    expect(
      (await f.client.read(h, 0, Number.MAX_SAFE_INTEGER)).events,
    ).toHaveLength(513)
    await f.client.close(h, randomUUID())
  })
  it('serializes simultaneous write claims in the database', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    await f.client.flush(h, randomUUID())
    await f.client.close(h, randomUUID())
    const other = new MeshClient({ endpoint: f.endpoint, token: TOKEN })
    const outcomes = await Promise.allSettled([
      f.client.open(h.session.id, 'write'),
      other.open(h.session.id, 'write'),
    ])
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter((r) => r.status === 'rejected')).toHaveLength(1)
    for (const r of outcomes)
      if (r.status === 'fulfilled') await f.client.close(r.value, randomUUID())
  })
  it('rolls back every inserted row when the database fails in the middle of a batch', async () => {
    const f = await fixture()
    const h = await f.client.create(header(), 0)
    const fn = `cm_failure_${randomUUID().replaceAll('-', '')}`
    await f.store.pool.query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.seq=1 THEN RAISE EXCEPTION 'injected storage failure'; END IF; RETURN NEW; END $$`,
    )
    await f.store.pool.query(
      `CREATE TRIGGER ${fn} BEFORE INSERT ON cm_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    )
    try {
      await expect(
        f.store.append(f.namespace, h.handleId, {
          operationId: randomUUID(),
          epoch: h.epoch,
          expectedNextSeq: 0,
          events: [events[0]!, { ...events[0]!, seq: 1 }],
        }),
      ).rejects.toThrow('injected storage failure')
      expect((await f.client.read(h, 0, 100)).events).toEqual([])
      expect((await f.client.stat(h.session.id))?.nextSeq).toBe(0)
    } finally {
      await f.store.pool.query(`DROP TRIGGER ${fn} ON cm_events`)
      await f.store.pool.query(`DROP FUNCTION ${fn}()`)
      await f.client.close(h, randomUUID())
    }
  })
})
