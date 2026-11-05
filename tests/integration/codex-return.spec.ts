import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, vi } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { meta, oneTurnLog } from '../upstream/contract.js'
import { CodexBridge } from '../../packages/adapter-codex/src/bridge.js'
import { CodexContextImport } from '../../packages/handoff-deepseek/src/codex-import.js'
import { MeshClient } from '../../packages/client/src/index.js'
import {
  MeshError,
  type StoredEvent,
} from '../../packages/protocol/src/index.js'

async function setup() {
  const f = await fixture(),
    root = await mkdtemp(join(tmpdir(), 'cm-return-'))
  f.defer(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'home'))
  await mkdir(join(root, 'cwd'))
  const h = await f.client.create(meta(randomUUID()) as any, 0)
  await f.client.append(
    h,
    oneTurnLog() as unknown as StoredEvent[],
    randomUUID(),
  )
  await f.client.flush(h, randomUUID())
  await f.client.close(h, randomUUID())
  const bridge = new CodexBridge({
    connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
    stateDir: join(root, 'bridge'),
    native: {
      executable: process.execPath,
      args: [resolve('tests/helpers/codex-rpc-fixture.mjs')],
      env: { ...process.env, CODEX_HOME: join(root, 'home') },
    },
  })
  const source = await bridge.import({
    sourceId: h.session.id,
    target: {
      cwd: join(root, 'cwd'),
      model: 'receiver-only',
      sandbox: 'read-only',
    },
  })
  const options = {
      mesh: f.client,
      stateDir: join(root, 'return'),
      preflight: vi.fn(async () => {}),
    },
    importer = new CodexContextImport(options),
    op = randomUUID()
  const input = {
    sourceId: source.sessionId,
    operationId: op,
    cwd: join(root, 'cwd'),
    confirmed: true as const,
    model: { provider: 'local', model: 'ds-flash' },
  }
  const expire = () =>
    f.store.pool.query(
      "UPDATE cm_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
      [f.namespace, 'dsh:' + op],
    )
  return { ...f, root, source, options, importer, input, op, expire }
}
it('retries a committed create across receiver restart with its original HTTP identity', async () => {
  const f = await setup(),
    create = f.store.create.bind(f.store)
  let count = 0
  vi.spyOn(f.store, 'create').mockImplementation(async (...args) => {
    const result = await create(...args)
    if (args[1].header.id === 'dsh:' + f.op && count++ < 3)
      throw new MeshError('RESPONSE_LOST', 'injected create loss', 503)
    return result
  })
  await expect(f.importer.import(f.input)).rejects.toThrow()
  const restarted = new CodexContextImport({
    ...f.options,
    mesh: new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
  })
  const imported = await restarted.import(f.input)
  expect(imported).toMatchObject({
    phase: 'archived',
    sessionId: 'dsh:' + f.op,
  })
  expect(
    (await f.client.list()).filter((s) => s.id === imported.sessionId),
  ).toHaveLength(1)
  expect(f.options.preflight).toHaveBeenCalledOnce()
})
it.each([false, true])(
  'explicitly recovers an expired import writer without duplicating history; append committed=%s',
  async (committed) => {
    const f = await setup(),
      append = f.store.append.bind(f.store)
    const prepare = vi.fn(async () => {
      expect((await f.client.list()).some((s) => s.id === 'dsh:' + f.op)).toBe(
        false,
      )
    })
    vi.spyOn(f.store, 'append').mockImplementationOnce(async (...args) => {
      if (committed) await append(...args)
      throw new MeshError('RESPONSE_LOST', 'injected append outage', 503)
    })
    const mesh = new MeshClient({
        endpoint: f.endpoint,
        token: TOKEN,
        retries: 0,
      }),
      first = new CodexContextImport({
        ...f.options,
        mesh,
        prepareLocal: prepare,
      })
    if (committed) {
      const row = (
        await f.store.pool.query(
          'SELECT event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND seq=0',
          [f.namespace, f.source.sessionId],
        )
      ).rows[0]
      const event = JSON.parse(row.event)
      event.snapshot.turns = [{ id: 'many', status: 'completed' }]
      event.snapshot.items = Array.from({ length: 1000 }, (_, i) => ({
        turnId: 'many',
        item: {
          id: 'u' + i,
          type: 'userMessage',
          content: [{ type: 'text', text: 'Archived fixture message ' + i }],
        },
      }))
      await f.store.pool.query(
        'UPDATE cm_events SET event=$3 WHERE namespace=$1 AND session_id=$2 AND seq=0',
        [f.namespace, f.source.sessionId, JSON.stringify(event)],
      )
    }
    await expect(first.import(f.input)).rejects.toThrow()
    expect(prepare).toHaveBeenCalledOnce()
    if (!committed) {
      expect((await f.client.list()).some((s) => s.id === 'dsh:' + f.op)).toBe(
        false,
      )
      await expect(mesh.open('dsh:' + f.op, 'write')).rejects.toMatchObject({
        code: 'IMPORT_INCOMPLETE',
      })
    }
    expect((await f.client.list()).some((s) => s.id === 'dsh:' + f.op)).toBe(
      false,
    )
    await f.expire()
    await expect(
      f.importer.recover(f.op, false as unknown as true),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    const restarted = new CodexContextImport({
      ...f.options,
      mesh: new MeshClient({ endpoint: f.endpoint, token: TOKEN, retries: 0 }),
    })
    const result = await restarted.recover(f.op, true)
    expect(result.phase).toBe('archived')
    const h = await f.client.open(result.sessionId, 'read'),
      data = await f.client.read(h, 0, 10000)
    await f.client.close(h, randomUUID())
    expect(data.events.filter((e) => e.type === 'user/message')).toHaveLength(
      committed ? 1002 : 2,
    )
    expect((data.snapshot.header.contextmeshImport as any).eventCount).toBe(
      data.events.length,
    )
    expect(await restarted.import(f.input)).toMatchObject({
      sessionId: result.sessionId,
    })
  },
)
it('rechecks an initially empty import after a delayed HTTP append commits during recovery', async () => {
  const f = await setup(),
    append = f.store.append.bind(f.store)
  let delayed: Parameters<typeof append> | undefined
  vi.spyOn(f.store, 'append').mockImplementationOnce(async (...args) => {
    delayed = args
    throw new MeshError('RESPONSE_LOST', 'injected delayed append', 503)
  })
  const importer = new CodexContextImport({
    ...f.options,
    mesh: new MeshClient({ endpoint: f.endpoint, token: TOKEN, retries: 0 }),
  })
  await expect(importer.import(f.input)).rejects.toThrow()
  const read = f.store.read.bind(f.store)
  vi.spyOn(f.store, 'read').mockImplementationOnce(async (...args) => {
    const cut = await read(...args)
    expect(cut.events).toHaveLength(0)
    await append(...delayed!)
    return cut
  })
  const result = await importer.recover(f.op, true)
  expect(result.phase).toBe('archived')
  const h = await f.client.open(result.sessionId, 'read')
  const log = await f.client.read(h, 0, 10000)
  await f.client.close(h, randomUUID())
  expect(log.events.filter((e) => e.type === 'user/message')).toHaveLength(2)
  expect((log.snapshot.header.contextmeshImport as any).eventCount).toBe(
    log.events.length,
  )
})
it('refuses recovery when an imported prefix changed, instead of overwriting it', async () => {
  const f = await setup(),
    flush = f.store.flush.bind(f.store)
  vi.spyOn(f.store, 'flush').mockImplementationOnce(async (...args) => {
    await flush(...args)
    throw new MeshError('RESPONSE_LOST', 'injected flush outage', 503)
  })
  const mesh = new MeshClient({
      endpoint: f.endpoint,
      token: TOKEN,
      retries: 0,
    }),
    importer = new CodexContextImport({ ...f.options, mesh })
  await expect(importer.import(f.input)).rejects.toThrow()
  await f.store.pool.query(
    "UPDATE cm_events SET event=jsonb_set(event::jsonb,'{data,content,0,text}','\"changed outside import\"')::text WHERE namespace=$1 AND session_id=$2 AND seq=0",
    [f.namespace, 'dsh:' + f.op],
  )
  await f.expire()
  await expect(importer.recover(f.op, true)).rejects.toMatchObject({
    code: 'HISTORY_CHANGED',
  })
})
it('lists only archive metadata and blocks unsupported native content before writing DSH history', async () => {
  const f = await setup()
  const catalog = await f.client.request('/v1/codex-archives')
  expect(JSON.stringify(catalog)).not.toContain('portable')
  expect(JSON.stringify(catalog)).not.toContain('hello')
  expect(catalog).toMatchObject([
    { id: f.source.sessionId, busy: false, recoveryRequired: false },
  ])
  const row = (
    await f.store.pool.query(
      'SELECT event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND seq=0',
      [f.namespace, f.source.sessionId],
    )
  ).rows[0]
  const event = JSON.parse(row.event)
  event.snapshot.items = [
    {
      turnId: 'turn',
      item: {
        type: 'userMessage',
        content: [{ type: 'image', url: 'https://example.invalid/a.png' }],
      },
    },
  ]
  await f.store.pool.query(
    'UPDATE cm_events SET event=$3 WHERE namespace=$1 AND session_id=$2 AND seq=0',
    [f.namespace, f.source.sessionId, JSON.stringify(event)],
  )
  await expect(f.importer.import(f.input)).rejects.toThrow()
  expect((await f.client.list()).some((s) => s.id === 'dsh:' + f.op)).toBe(
    false,
  )
  expect(f.options.preflight).not.toHaveBeenCalled()
})
it('keeps source and target untouched when the receiving model preflight rejects', async () => {
  const f = await setup()
  f.options.preflight.mockRejectedValueOnce(new Error('model unavailable'))
  await expect(f.importer.import(f.input)).rejects.toThrow('model unavailable')
  expect((await f.client.list()).some((s) => s.id === 'dsh:' + f.op)).toBe(
    false,
  )
  expect(
    (await f.client.request(
      '/v1/codex-archives/' + encodeURIComponent(f.source.sessionId),
    )) as any,
  ).toMatchObject({ busy: false, recoveryRequired: false })
})
