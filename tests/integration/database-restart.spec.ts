import { it, expect } from 'vitest'
import EmbeddedPostgres from 'embedded-postgres'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { PostgresStore } from '../../packages/storage-postgres/src/index.js'

it('recovers acknowledged events after an immediate PostgreSQL shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'contextmesh-crash-'))
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  const port = address.port
  await new Promise<void>((r) => probe.close(() => r()))
  const databaseDir = join(dir, 'db')
  const db = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'contextmesh',
    password: 'contextmesh-tests',
    persistent: true,
    createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1'],
    onLog: () => {},
    onError: () => {},
  })
  const connectionString = `postgres://contextmesh:contextmesh-tests@127.0.0.1:${port}/postgres`
  let store: PostgresStore | undefined
  let running = false
  try {
    await db.initialise()
    await db.start()
    running = true
    store = new PostgresStore({ connectionString })
    await store.init()
    const id = randomUUID(),
      instanceId = randomUUID()
    const h = await store.create('crash', {
      operationId: randomUUID(),
      instanceId,
      adapter: 'deepseek',
      header: { id, version: 4, createdAt: 1, isSeeded: false },
      inheritedEventCount: 0,
    })
    await store.append('crash', h.handleId, {
      operationId: randomUUID(),
      epoch: h.epoch,
      expectedNextSeq: 0,
      events: [{ seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } }],
    })
    await store.flush('crash', h.handleId, {
      operationId: randomUUID(),
      epoch: h.epoch,
    })
    await store.stop()
    store = undefined
    const pid = Number(
      (await readFile(join(databaseDir, 'postmaster.pid'), 'utf8')).split(
        '\n',
      )[0],
    )
    process.kill(pid, 'SIGQUIT')
    await expect
      .poll(
        () => {
          try {
            process.kill(pid, 0)
            return false
          } catch {
            return true
          }
        },
        { timeout: 5000 },
      )
      .toBe(true)
    running = false
    await db.start()
    running = true
    store = new PostgresStore({ connectionString })
    await store.init()
    const r = await store.open('crash', id, {
      operationId: randomUUID(),
      instanceId: randomUUID(),
      access: 'read',
    })
    expect((await store.read('crash', r.handleId, 0, 10)).events).toEqual([
      { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
    ])
    // The old writer remains fenced/recovery-managed; a database restart is not a writer release.
    await expect(
      store.open('crash', id, {
        operationId: randomUUID(),
        instanceId: randomUUID(),
        access: 'write',
      }),
    ).rejects.toBeDefined()
  } finally {
    await store?.stop()
    if (running) await db.stop()
    await rm(dir, { recursive: true, force: true })
  }
}, 20000)
