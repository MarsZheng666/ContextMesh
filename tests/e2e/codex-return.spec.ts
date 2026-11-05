import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, readFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
import { TOKEN } from '../fixture.js'
import { CodexBridge } from '../../packages/adapter-codex/src/bridge.js'
import { CodexContextImport } from '../../packages/handoff-deepseek/src/codex-import.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { codexModel } from '../helpers/codex-model.js'
import { MeshError } from '../../packages/protocol/src/index.js'

async function setup(real = false) {
  const f = await environment(),
    a = await f.launch('A', f.source),
    b = await f.launch('B', f.target, false, false, undefined, true)
  const id = randomUUID()
  await a.rpc('create', { sessionId: id })
  await a.rpc('prompt', {
    sessionId: id,
    text: 'READ_WORKSPACE and remember CONTINUITY-PHRASE-4817 CODEX-RELAY-731 total=17.',
  })
  const home = join(f.root, 'codex')
  await mkdir(home)
  const service = real ? await codexModel(home) : undefined
  if (service) f.defer(() => service.app.close())
  const bridge = new CodexBridge({
    connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
    stateDir: join(f.root, 'bridge'),
    native: {
      executable: real
        ? process.env.CONTEXTMESH_TEST_CODEX_BIN
        : process.execPath,
      args: real ? undefined : [resolve('tests/helpers/codex-rpc-fixture.mjs')],
      env: {
        ...process.env,
        CODEX_HOME: home,
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
      timeoutMs: 15000,
    },
  })
  const imported = await bridge.import({
    sourceId: id,
    target: { cwd: f.target, model: 'gpt-6.1-sol', sandbox: 'read-only' },
  })
  await bridge.run(
    imported.sessionId,
    'Continue using CODEX-RELAY-731 total=17 and report the next verification step.',
  )
  const operationId = randomUUID(),
    command = {
      action: 'import-codex',
      sourceId: imported.sessionId,
      cwd: f.target,
      operationId,
      confirmed: true,
    }
  const copy = () => b.rpc('m1', { command })
  const codex = new MeshClient({
    endpoint: f.endpoint,
    token: TOKEN,
    adapter: 'codex',
  })
  const snapshots = await codex.stat(imported.sessionId)
  return {
    ...f,
    a,
    b,
    id,
    bridge,
    imported,
    operationId,
    command,
    copy,
    codex,
    snapshots,
    service,
  }
}
const resultSchema = z.object({
  sessionId: z.string(),
  operationId: z.string(),
  phase: z.string(),
  sourceCut: z.object({
    adapter: z.string(),
    id: z.string(),
    eventCount: z.number(),
  }),
})
it.each([false, true])(
  'returns archived Codex context to native DSH without starting work or replaying tools; lost append=%s',
  async (lost) => {
    const f = await setup()
    try {
      const chosen = join(f.target, 'chosen-import-directory')
      await mkdir(chosen)
      f.command.cwd = chosen
      let raced = false
      const close = f.store.close.bind(f.store)
      vi.spyOn(f.store, 'close').mockImplementation(async (...args) => {
        const result = await close(...args)
        const handle = await f.store.pool.query(
          'SELECT session_id,access FROM cm_handles WHERE namespace=$1 AND id=$2',
          [args[0], args[1]],
        )
        if (
          !raced &&
          handle.rows[0]?.session_id === 'dsh:' + f.operationId &&
          handle.rows[0]?.access === 'write'
        ) {
          raced = true
          // Native history promotion wins the race against coordinator publication.
          expect(
            await f.b.rpc('native-resume', {
              sessionId: 'dsh:' + f.operationId,
            }),
          ).toMatchObject({
            cwd: chosen,
            workspaceRoot: chosen,
          })
        }
        return result
      })
      if (lost) {
        const append = f.store.append.bind(f.store)
        vi.spyOn(f.store, 'append').mockImplementationOnce(async (...args) => {
          await append(...args)
          throw new MeshError(
            'RESPONSE_LOST',
            'injected archive append loss',
            503,
          )
        })
      }
      const result = resultSchema.parse(await f.copy())
      expect(raced).toBe(true)
      expect(result).toMatchObject({
        phase: 'published',
        sourceCut: {
          adapter: 'codex',
          id: f.imported.sessionId,
          eventCount: 2,
        },
      })
      const state = z
        .object({ live: z.boolean(), modelRequests: z.array(z.unknown()) })
        .parse(await f.b.rpc('state', { sessionId: result.sessionId }))
      expect(state).toMatchObject({ live: true, modelRequests: [] })
      expect(await f.copy()).toEqual(
        await f.b.rpc('m1', {
          command: {
            action: 'import-codex-status',
            operationId: f.operationId,
          },
        }),
      )
      const h = await f.client.open(result.sessionId, 'read'),
        log = await f.client.read(h, 0, 10000)
      await f.client.close(h, randomUUID())
      expect(log.snapshot.header.contextmeshImport).toMatchObject({
        operationId: f.operationId,
        source: { adapter: 'codex', id: f.imported.sessionId },
      })
      expect(JSON.stringify(log.events)).toContain('Historical tool result')
      expect(JSON.stringify(log.events)).not.toContain('fixturePrivateState')
      expect(log.events.filter((e) => e.type === 'tool/call')).toHaveLength(0)
      await f.b.rpc('prompt', {
        sessionId: result.sessionId,
        text: 'Continue the verification from this imported context. Do not repeat completed operations.',
      })
      const requests = z
        .object({
          modelRequests: z.array(
            z.object({
              provider: z.string(),
              model: z.string(),
              messages: z.array(z.unknown()),
            }),
          ),
        })
        .parse(
          await f.b.rpc('state', { sessionId: result.sessionId }),
        ).modelRequests
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        provider: 'contextmesh-second',
        model: 'relay',
      })
      expect(JSON.stringify(requests[0]!.messages)).toContain(
        'CONTINUITY-PHRASE-4817',
      )
      expect(JSON.stringify(requests[0]!.messages)).toContain(
        'fixture-sentinel',
      )
      expect(JSON.stringify(requests[0]!.messages)).toContain(
        'fixture continuation',
      )
      expect((await f.codex.stat(f.imported.sessionId))?.nextSeq).toBe(
        f.snapshots?.nextSeq,
      )
      await f.b.stop()
      const restarted = await f.launch(
        'B',
        f.target,
        false,
        false,
        undefined,
        true,
      )
      expect(
        await restarted.rpc('m1', { command: { ...f.command } }),
      ).toMatchObject({ sessionId: result.sessionId, phase: 'published' })
      await restarted.rpc('native-resume', { sessionId: result.sessionId })
      await restarted.rpc('prompt', {
        sessionId: result.sessionId,
        text: 'Verify the imported marker after restart, without repeating tools.',
      })
      expect(
        (await f.client.list()).filter((s) => s.id === 'dsh:' + f.operationId),
      ).toHaveLength(1)
    } finally {
      await f.close()
    }
  },
  60000,
)
it('rejects missing confirmation, a missing directory and a busy or uncertain source before creating target history', async () => {
  const f = await setup()
  try {
    await expect(
      f.b.rpc('m1', { command: { ...f.command, confirmed: false } }),
    ).rejects.toThrow()
    await expect(
      f.b.rpc('m1', { command: { ...f.command, cwd: join(f.root, 'absent') } }),
    ).rejects.toThrow()
    const writer = await f.codex.open(f.imported.sessionId, 'write')
    await expect(f.copy()).rejects.toThrow('Finish or reconcile')
    await f.codex.close(writer, randomUUID(), true)
    await expect(f.copy()).rejects.toThrow('Finish or reconcile')
    expect(
      (await f.client.list()).filter((s) => s.id === 'dsh:' + f.operationId),
    ).toHaveLength(0)
  } finally {
    await f.close()
  }
}, 30000)
it('rejects reused import identities with another directory and keeps private context out of status', async () => {
  const f = await setup()
  try {
    const imported = resultSchema.parse(await f.copy())
    await expect(
      f.b.rpc('m1', { command: { ...f.command, cwd: f.source } }),
    ).rejects.toThrow('another source, directory or model')
    const status = await f.b.rpc('m1', {
      command: { action: 'import-codex-status', operationId: f.operationId },
    })
    expect(JSON.stringify(status)).not.toContain('fixture-sentinel')
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    expect(status).toMatchObject({ sessionId: imported.sessionId })
  } finally {
    await f.close()
  }
}, 30000)
it.runIf(!!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'real Codex CLI archives a continuation that returns to native DSH and its receiving model',
  async () => {
    const f = await setup(true)
    try {
      const result = resultSchema.parse(await f.copy())
      expect(f.service!.requests).toHaveLength(1)
      await f.b.rpc('prompt', {
        sessionId: result.sessionId,
        text: 'Use the remembered marker and last Codex result; perform the next verification without repeating completed work.',
      })
      const state = z
        .object({
          modelRequests: z.array(
            z.object({ messages: z.array(z.unknown()), model: z.string() }),
          ),
        })
        .parse(await f.b.rpc('state', { sessionId: result.sessionId }))
      expect(state.modelRequests).toHaveLength(1)
      expect(JSON.stringify(state.modelRequests[0]!.messages)).toContain(
        'CODEX-RELAY-731 total=17 next=verification',
      )
      expect(state.modelRequests[0]!.model).toBe('relay')
    } finally {
      await f.close()
    }
  },
  60000,
)

it('offers import, status and explicit confirmation through the existing local CLI', async () => {
  const f = await setup()
  try {
    const managed = join(f.root, 'isolated-managed')
    await mkdir(join(managed, 'data/dsh'), { recursive: true })
    await symlink(f.b.stateDir, join(managed, 'data/dsh/contextmesh'))
    const execute = promisify(execFile),
      call = async (args: string[], useManaged = false) =>
        JSON.parse(
          (
            await execute(
              process.execPath,
              [
                '--import',
                'tsx',
                'apps/cli/src/main.ts',
                ...args,
                ...(useManaged ? [] : ['--state-dir', f.b.stateDir]),
              ],
              {
                env: {
                  ...process.env,
                  CONTEXTMESH_HOME: managed,
                  CONTEXTMESH_BUNDLE: useManaged ? f.root : undefined,
                  CONTEXTMESH_STATE_DIR: undefined,
                  DSH_HOME: useManaged
                    ? undefined
                    : join(f.root, 'unconfigured-home'),
                },
              },
            )
          ).stdout,
        )
    await expect(
      call(['import-codex', f.imported.sessionId, '--cwd', f.target]),
    ).rejects.toThrow('--confirm')
    const result = await call([
      'import-codex',
      f.imported.sessionId,
      '--cwd',
      f.target,
      '--operation-id',
      f.operationId,
      '--confirm',
    ])
    expect(result).toMatchObject({
      phase: 'published',
      sourceId: f.imported.sessionId,
    })
    expect(await call(['import-codex-status', f.operationId])).toMatchObject({
      sessionId: result.sessionId,
    })
    expect(
      await call(['import-codex-status', f.operationId], true),
    ).toMatchObject({ sessionId: result.sessionId })
    await expect(call(['import-codex-recover', f.operationId])).rejects.toThrow(
      '--confirm-stopped',
    )
    expect(
      await call(['import-codex-recover', f.operationId, '--confirm-stopped']),
    ).toMatchObject({ sessionId: result.sessionId, phase: 'published' })
  } finally {
    await f.close()
  }
}, 40000)
