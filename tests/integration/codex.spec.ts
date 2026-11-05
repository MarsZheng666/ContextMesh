import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { it, expect, vi } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { oneTurnLog, meta } from '../upstream/contract.js'
import { CodexBridge } from '../../packages/adapter-codex/src/bridge.js'
import { MeshClient } from '../../packages/client/src/index.js'
import {
  deepSeekContext,
  codexItems,
} from '../../packages/adapter-codex/src/context.js'
import { validatePortable } from '../../packages/protocol/src/portable.js'
import type { StoredEvent } from '../../packages/protocol/src/index.js'

async function setup(fault?: string) {
  const f = await fixture(),
    root = await mkdtemp(join(tmpdir(), 'cm-codex-'))
  await mkdir(join(root, 'workspace'))
  await mkdir(join(root, 'home'))
  f.defer(() => rm(root, { recursive: true, force: true }))
  const id = randomUUID(),
    handle = await f.client.create(meta(id) as any, 0)
  await f.client.append(
    handle,
    oneTurnLog() as unknown as StoredEvent[],
    randomUUID(),
  )
  await f.client.flush(handle, randomUUID())
  await f.client.close(handle, randomUUID())
  const connection = { endpoint: f.endpoint, token: TOKEN, retries: 0 }
  const native = {
    executable: process.execPath,
    args: [resolve('tests/helpers/codex-rpc-fixture.mjs')],
    env: {
      ...process.env,
      CODEX_HOME: join(root, 'home'),
      CODEX_FIXTURE_FAULT: fault,
    },
    timeoutMs: 1000,
  }
  const bridge = new CodexBridge({
    connection,
    stateDir: join(root, 'state'),
    native,
  })
  const target = {
    cwd: join(root, 'workspace'),
    model: 'receiver-only-model',
    sandbox: 'read-only' as const,
  }
  const state = async () =>
    JSON.parse(await readFile(join(root, 'home/fixture.json'), 'utf8'))
  return { ...f, root, id, bridge, target, state, connection, native }
}
it('imports a fixed DSH surface without starting work, then persists Codex continuation across restart', async () => {
  const f = await setup(),
    operationId = randomUUID()
  const imported = await f.bridge.import({
    sourceId: f.id,
    target: f.target,
    operationId,
  })
  expect(
    await f.bridge.import({ sourceId: f.id, target: f.target, operationId }),
  ).toEqual(imported)
  expect(
    await f.bridge.import({
      sourceId: f.id,
      target: f.target,
      operationId: operationId.toUpperCase(),
    }),
  ).toEqual(imported)
  const before = await f.state()
  expect(
    before.requests.filter((r: any) => r.method === 'thread/inject_items'),
  ).toHaveLength(1)
  expect(before.requests.some((r: any) => r.method === 'turn/start')).toBe(
    false,
  )
  expect(JSON.stringify(before.threads[imported.threadId].injected)).toContain(
    'hello',
  )
  expect(
    await f.bridge.run(imported.sessionId, 'Continue the task'),
  ).toMatchObject({ status: 'completed', text: 'fixture continuation' })
  expect(
    await f.bridge.run(imported.sessionId, 'Continue after restart'),
  ).toMatchObject({ status: 'completed' })
  const codex = new MeshClient({ ...f.connection, adapter: 'codex' })
  const handle = await codex.open(imported.sessionId, 'read')
  const archived = await codex.read(handle, 0, 100)
  expect(archived.events).toHaveLength(3)
  expect((archived.events[2]!.snapshot as any).turns).toHaveLength(2)
  await codex.close(handle, randomUUID())
  expect((await f.client.list()).map((s) => s.id)).toEqual([f.id])
  const copied = await f.bridge.import({
    sourceId: imported.sessionId,
    sourceAdapter: 'codex',
    target: f.target,
  })
  expect(
    JSON.stringify((await f.state()).threads[copied.threadId].injected),
  ).toContain('Continue after restart')
  expect((await f.client.stat(f.id))?.nextSeq).toBe(6)
})
it('does not reinject after a native response is lost', async () => {
  const f = await setup('inject-drop'),
    operationId = randomUUID()
  await expect(
    f.bridge.import({ sourceId: f.id, target: f.target, operationId }),
  ).rejects.toThrow('did not complete')
  await expect(
    f.bridge.import({ sourceId: f.id, target: f.target, operationId }),
  ).rejects.toThrow('uncertain')
  expect(
    (await f.state()).requests.filter(
      (r: any) => r.method === 'thread/inject_items',
    ),
  ).toHaveLength(1)
})
it('fences repeated work after an uncertain native turn', async () => {
  const f = await setup('turn-drop')
  const imported = await f.bridge.import({ sourceId: f.id, target: f.target })
  await expect(
    f.bridge.run(imported.sessionId, 'May have executed'),
  ).rejects.toThrow()
  await expect(
    f.bridge.run(imported.sessionId, 'Must not repeat'),
  ).rejects.toThrow('needs review')
  expect(
    (await f.state()).requests.filter((r: any) => r.method === 'turn/start'),
  ).toHaveLength(1)
  const codex = new MeshClient({ ...f.connection, adapter: 'codex' })
  await expect(codex.open(imported.sessionId, 'write')).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  })
})
it('fails before target mutation for invalid workspaces and unsupported sources', async () => {
  const f = await setup()
  await expect(
    f.bridge.import({
      sourceId: f.id,
      target: { ...f.target, cwd: join(f.root, 'missing') },
    }),
  ).rejects.toThrow()
  const h = await f.client.open(f.id, 'write')
  await f.client.append(
    h,
    [{ seq: 6, type: 'turn/start', time: 10, data: { turn: 2 } }],
    randomUUID(),
  )
  await f.client.flush(h, randomUUID())
  await expect(
    f.bridge.import({ sourceId: f.id, target: f.target }),
  ).rejects.toThrow('source task')
  await f.client.close(h, randomUUID())
})
it('bounds native pagination and keeps an incomplete import out of remote catalogs', async () => {
  const f = await setup('cursor-loop')
  await expect(
    f.bridge.import({ sourceId: f.id, target: f.target }),
  ).rejects.toThrow('pagination did not advance')
  expect(
    await new MeshClient({ ...f.connection, adapter: 'codex' }).list(),
  ).toEqual([])
})
it('validates portable envelopes and never emits executable historical tool items', async () => {
  const f = await setup()
  const handle = await f.client.open(f.id, 'read'),
    cut = await f.client.read(handle, 0, 100)
  const context = deepSeekContext(cut.snapshot, cut.events)
  expect(codexItems(context).every((i) => i.type === 'message')).toBe(true)
  await f.client.close(handle, randomUUID())
  expect(() => validatePortable({ ...context, version: 2 })).toThrow()
  expect(() =>
    validatePortable({
      ...context,
      messages: [{ role: 'assistant', text: 'x'.repeat(1024 * 1024 + 1) }],
    }),
  ).toThrow()
})
it('reconciles a completed but unacknowledged native turn without starting it again', async () => {
  const f = await setup('turn-drop')
  const imported = await f.bridge.import({ sourceId: f.id, target: f.target })
  await expect(
    f.bridge.run(imported.sessionId, 'Execute once'),
  ).rejects.toThrow()
  expect(await f.bridge.status(imported.sessionId)).toMatchObject({
    phase: 'needs-review',
  })
  await expect(
    f.bridge.reconcile(imported.sessionId, false as unknown as true),
  ).rejects.toThrow('Confirm')
  expect(await f.bridge.reconcile(imported.sessionId, true)).toMatchObject({
    reconciled: true,
    replayed: false,
  })
  expect(await f.bridge.reconcile(imported.sessionId, true)).toMatchObject({
    replayed: false,
  })
  expect(
    (await f.state()).requests.filter((r: any) => r.method === 'turn/start'),
  ).toHaveLength(1)
  expect(await f.bridge.status(imported.sessionId)).toMatchObject({
    phase: 'ready',
    pendingOperationId: null,
  })
  const client = new MeshClient({ ...f.connection, adapter: 'codex' }),
    h = await client.open(imported.sessionId, 'read')
  expect((await client.read(h, 0, 100)).events).toHaveLength(2)
  await client.close(h, randomUUID())
})
it('rejects reused import parameters and refuses to run while another writer owns the archive', async () => {
  const f = await setup(),
    operationId = randomUUID()
  const imported = await f.bridge.import({
    sourceId: f.id,
    target: f.target,
    operationId,
  })
  await expect(
    f.bridge.import({
      sourceId: f.id,
      target: { ...f.target, model: 'different-model' },
      operationId,
    }),
  ).rejects.toThrow('different source or target')
  const client = new MeshClient({ ...f.connection, adapter: 'codex' }),
    writer = await client.open(imported.sessionId, 'write')
  await expect(
    f.bridge.run(imported.sessionId, 'Must not execute'),
  ).rejects.toMatchObject({ code: 'ALREADY_OWNED' })
  expect(
    (await f.state()).requests.some((r: any) => r.method === 'turn/start'),
  ).toBe(false)
  await client.close(writer, randomUUID())
  expect(await f.bridge.status(imported.sessionId)).toMatchObject({
    phase: 'ready',
  })
})

it('stops its native connection and keeps recovery required when lease renewal fails', async () => {
  const f = await setup('turn-slow')
  const imported = await f.bridge.import({ sourceId: f.id, target: f.target })
  vi.spyOn(f.bridge.client, 'capabilities').mockResolvedValue({
    protocolVersion: 1,
    leaseMs: 300,
    features: [],
  })
  const renew = f.bridge.client.renew.bind(f.bridge.client)
  vi.spyOn(f.bridge.client, 'renew')
    .mockImplementationOnce(renew)
    .mockRejectedValue(new Error('connection lost'))
  await expect(
    f.bridge.run(imported.sessionId, 'Do not dispatch twice'),
  ).rejects.toThrow()
  expect(await f.bridge.status(imported.sessionId)).toMatchObject({
    phase: 'needs-review',
  })
  expect(
    (await f.state()).requests.filter((r: any) => r.method === 'turn/start'),
  ).toHaveLength(1)
})

it('provides the import, run and status flow through the public CLI', async () => {
  const f = await setup()
  const executable = join(f.root, 'fixture-codex.mjs')
  await writeFile(
    executable,
    '#!' +
      process.execPath +
      '\nimport ' +
      JSON.stringify(
        pathToFileURL(resolve('tests/helpers/codex-rpc-fixture.mjs')).href,
      ) +
      '\n',
    { mode: 0o700 },
  )
  const env = {
    ...process.env,
    CONTEXTMESH_ENDPOINT: f.endpoint,
    CONTEXTMESH_TOKEN: TOKEN,
    CODEX_HOME: join(f.root, 'home'),
    CODEX_FIXTURE_FAULT: '',
  }
  const run = promisify(execFile),
    common = [
      '--state-dir',
      join(f.root, 'cli-state'),
      '--codex-bin',
      executable,
    ]
  const call = async (args: string[]) =>
    JSON.parse(
      (
        await run(
          process.execPath,
          [
            '--import',
            'tsx',
            'apps/cli/src/main.ts',
            'codex',
            ...args,
            ...common,
          ],
          { env },
        )
      ).stdout,
    )
  const imported = await call([
    'import',
    f.id,
    '--cwd',
    f.target.cwd,
    '--model',
    f.target.model,
  ])
  expect(
    await call([
      'run',
      imported.sessionId,
      '--message',
      'Continue through CLI',
    ]),
  ).toMatchObject({ status: 'completed' })
  const status = await call(['status', imported.sessionId])
  expect(status).toMatchObject({ phase: 'ready' })
  expect(JSON.stringify(status)).not.toContain(TOKEN)
  expect(JSON.stringify(status)).not.toContain('hello')
})

it('does not let a resumed import overwrite the pending state of an executing local thread', async () => {
  const f = await setup('turn-slow'),
    operationId = randomUUID()
  const imported = await f.bridge.import({
    sourceId: f.id,
    target: f.target,
    operationId,
  })
  // Simulate a crash after publishing the local binding but before marking the import done.
  const file = join(f.root, 'state/imports', operationId + '.json'),
    journal = JSON.parse(await readFile(file, 'utf8'))
  journal.phase = 'archived'
  await writeFile(file, JSON.stringify(journal))
  const running = f.bridge.run(imported.sessionId, 'Continue once')
  await expect
    .poll(async () =>
      (await f.state()).requests.some((r: any) => r.method === 'turn/start'),
    )
    .toBe(true)
  await expect(
    f.bridge.import({ sourceId: f.id, target: f.target, operationId }),
  ).rejects.toThrow('owns this state directory')
  expect(await f.bridge.status(imported.sessionId)).toMatchObject({
    phase: 'needs-review',
  })
  await expect(running).resolves.toMatchObject({ status: 'completed' })
  expect(
    (await f.state()).requests.filter((r: any) => r.method === 'turn/start'),
  ).toHaveLength(1)
})
