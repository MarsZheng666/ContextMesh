import { codexPanel } from '../helpers/codex-panel.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { it, expect, vi } from 'vitest'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
import { DeviceClient } from '../../packages/client/src/devices.js'
import { TOKEN } from '../fixture.js'
import { ConfirmedCodexTakeover } from '../../packages/adapter-codex/src/takeover.js'
import { codexModel } from '../helpers/codex-model.js'
import { MeshError } from '../../packages/protocol/src/index.js'

async function setup(
  fault?: string,
  real = false,
  running = true,
  tool = false,
  ordinary = false,
  empty = false,
) {
  const f = await environment()
  if (ordinary) {
    await rm(join(f.source, '.git'), { recursive: true })
    await rm(join(f.target, '.git'), { recursive: true })
  }
  const a = await f.launch('A', f.source)
  const sessionId = randomUUID(),
    projectId = randomUUID()
  await a.rpc('m1', {
    command: { action: 'project', projectId, name: 'confirmed agent takeover' },
  })
  await a.rpc('m1', {
    command: { action: 'mapping', projectId, root: f.source },
  })
  await a.rpc('create', { sessionId })
  if (!empty)
    await a.rpc('prompt', {
      sessionId,
      text: 'READ_WORKSPACE and remember CODEX-RELAY-731 total=17.',
    })
  await a.rpc('m1', { command: { action: 'refresh' } })
  if (running)
    await a.rpc(tool ? 'start-tool' : 'start-running', {
      sessionId,
      text: tool
        ? 'READ_WORKSPACE again then finish the original unfinished task.'
        : 'Verify CODEX-RELAY-731 total=17 using the completed workspace read.',
    })
  const home = join(f.root, 'codex-home')
  await mkdir(home)
  let model: Awaited<ReturnType<typeof codexModel>> | undefined
  if (real) {
    model = await codexModel(home)
    f.defer(() => model!.app.close())
  }
  const options = {
    connection: {
      endpoint: f.endpoint,
      token: TOKEN,
      timeoutMs: 3000,
      retries: 0,
    },
    stateDir: join(f.root, 'receiver-state'),
    native: {
      executable: real
        ? process.env.CONTEXTMESH_TEST_CODEX_BIN
        : process.execPath,
      args: real ? undefined : [resolve('tests/helpers/codex-rpc-fixture.mjs')],
      env: {
        ...process.env,
        CODEX_HOME: home,
        CODEX_FIXTURE_FAULT: fault,
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
      timeoutMs: real ? 15000 : 3000,
    },
  }
  const worker = new ConfirmedCodexTakeover(options)
  const start = () =>
    worker.takeover({
      sourceId: sessionId,
      confirmed: true,
      target: {
        cwd: f.target,
        model: 'gpt-6.1-sol',
        sandbox: 'workspace-write',
      },
      waitMs: 30000,
    })
  const nativeState = async () =>
    JSON.parse(await readFile(join(home, 'fixture.json'), 'utf8'))
  const sourceState = async () =>
    z
      .object({
        live: z.boolean(),
        running: z.boolean().optional(),
        controlled: z.boolean(),
        toolAborted: z.boolean().optional(),
        toolHeld: z.boolean().optional(),
      })
      .parse(await a.rpc('state', { sessionId }))
  return {
    ...f,
    a,
    sessionId,
    worker,
    options,
    start,
    nativeState,
    sourceState,
    model,
  }
}
it.each([false, true])(
  'confirmed takeover stops DSH after preflight and continues exactly once; lost dispatch response=%s',
  async (lost) => {
    const f = await setup()
    try {
      const claim = f.store.claimCodexContinuation.bind(f.store)
      if (lost) {
        // The server committed but the receiver did not get the response. It must reconcile, never resend a native turn.
        vi.spyOn(f.store, 'claimCodexContinuation').mockImplementationOnce(
          async (...args) => {
            await claim(...args)
            throw new MeshError(
              'RESPONSE_LOST',
              'injected committed response loss',
              500,
            )
          },
        )
        await expect(f.start()).rejects.toThrow()
        const rows = (
          await f.store.pool.query(
            'SELECT id,execution FROM cm_handoffs WHERE namespace=$1',
            [f.namespace],
          )
        ).rows
        expect(rows).toHaveLength(1)
        expect(rows[0].execution).toBe('uncertain')
        const snapshot = await f.nativeState()
        expect(
          snapshot.requests.filter(
            (r: any) =>
              r.method === 'turn/start' && r.params.clientUserMessageId,
          ),
        ).toHaveLength(0)
        await expect(
          f.worker.recover(rows[0].id, false as unknown as true),
        ).rejects.toThrow('Confirm')
        // A claim without native evidence remains fenced even after explicit stopped-process verification.
        await expect(f.worker.recover(rows[0].id, true)).rejects.toThrow()
        expect((await f.worker.status(rows[0].id)).executionState).toBe(
          'uncertain',
        )
        return
      }
      const result = await f.start()
      expect(result.handoff).toMatchObject({
        state: 'completed',
        executionState: 'completed',
        targetSessionId: 'codex:' + result.handoff.id,
      })
      expect(result.execution).toMatchObject({
        status: 'completed',
        text: 'fixture continuation',
      })
      expect(await f.sourceState()).toMatchObject({
        live: false,
        running: false,
      })
      expect((await f.client.stat(f.sessionId))?.successorSessionId).toBe(
        result.handoff.targetSessionId,
      )
      await expect(f.client.open(f.sessionId, 'write')).rejects.toMatchObject({
        code: 'SESSION_MOVED',
      })
      await expect(
        f.client.request(`/v1/sessions/${f.sessionId}/recover`, {
          operationId: randomUUID(),
          confirmStopped: true,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_MOVED' })
      const state = await f.nativeState(),
        dispatched = state.requests.filter(
          (r: any) => r.method === 'turn/start',
        )
      expect(dispatched).toHaveLength(2) // one isolated readiness call + one actual continuation
      expect(dispatched[0].params.clientUserMessageId).toBeUndefined()
      expect(dispatched[1].params.clientUserMessageId).toBe(
        result.handoff.executionOperationId,
      )
      const thread = Object.values(state.threads).find(
        (v: any) => v.thread.cwd === f.target && v.injected.length > 0,
      ) as any
      expect(JSON.stringify(thread.injected)).toContain('fixture-sentinel')
      expect(JSON.stringify(thread.injected)).toContain('CODEX-RELAY-731')
      expect(thread.injected.every((i: any) => i.type === 'message')).toBe(true)
      await f.worker.recover(result.handoff.id, true)
      expect(
        (await f.nativeState()).requests.filter(
          (r: any) => r.method === 'turn/start',
        ),
      ).toHaveLength(2)
    } finally {
      await f.close()
    }
  },
  60000,
)
it('failed model readiness check leaves the source running and never requests source cancellation', async () => {
  const f = await setup('probe-fail')
  try {
    await expect(f.start()).rejects.toThrow()
    expect(await f.sourceState()).toMatchObject({
      live: true,
      running: true,
      controlled: false,
    })
    expect(
      (
        await f.store.pool.query(
          'SELECT id FROM cm_handoffs WHERE namespace=$1',
          [f.namespace],
        )
      ).rows,
    ).toHaveLength(0)
    await f.a.rpc('finish-running', { sessionId: f.sessionId })
  } finally {
    await f.close()
  }
}, 30000)
it('does not auto-run an idle source or a task that completes naturally during preflight', async () => {
  const f = await setup()
  try {
    const preflight = f.store.preflightHandoff.bind(f.store)
    vi.spyOn(f.store, 'preflightHandoff').mockImplementationOnce(
      async (...args) => {
        await f.a.rpc('finish-running', { sessionId: f.sessionId })
        await expect
          .poll(async () => (await f.sourceState()).running)
          .toBe(false)
        return preflight(...args)
      },
    )
    const result = await f.start()
    expect(result.handoff).toMatchObject({
      state: 'completed',
      executionState: 'none',
    })
    expect(result.execution).toBeNull()
    expect(
      (await f.nativeState()).requests.filter(
        (r: any) => r.method === 'turn/start',
      ),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 45000)
it('reconciles an uncertain completed native continuation after receiver restart without replay', async () => {
  const f = await setup('continuation-drop')
  try {
    await expect(f.start()).rejects.toThrow()
    const row = (
      await f.store.pool.query(
        'SELECT id,execution FROM cm_handoffs WHERE namespace=$1',
        [f.namespace],
      )
    ).rows[0]
    expect(row.execution).toBe('uncertain')
    const restarted = new ConfirmedCodexTakeover(f.options)
    const recovered = await restarted.recover(row.id, true)
    expect(recovered.handoff).toMatchObject({ executionState: 'completed' })
    expect(
      (await f.nativeState()).requests.filter(
        (r: any) => r.method === 'turn/start' && r.params.clientUserMessageId,
      ),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 45000)
it('waits for running tool bodies before closing the source and imports their settled result', async () => {
  const f = await setup(undefined, false, true, true)
  try {
    await expect.poll(async () => (await f.sourceState()).toolHeld).toBe(true)
    const started = f.start()
    await expect
      .poll(
        async () =>
          (
            await f.store.pool.query(
              'SELECT state FROM cm_handoffs WHERE namespace=$1',
              [f.namespace],
            )
          ).rows[0]?.state,
      )
      .toBe('preparing')
    expect(await f.sourceState()).toMatchObject({
      running: true,
      toolHeld: true,
      toolAborted: false,
    })
    await f.a.rpc('finish-tool', { sessionId: f.sessionId })
    const result = await started
    expect(result.handoff.executionState).toBe('completed')
    expect(await f.sourceState()).toMatchObject({
      live: false,
      toolAborted: false,
    })
    const state = await f.nativeState(),
      target = Object.values(state.threads).find(
        (v: any) => v.thread.cwd === f.target && v.injected.length > 0,
      ) as any
    expect(
      JSON.stringify(target.injected).match(/Historical tool result/g),
    ).toHaveLength(2)
  } finally {
    await f.close()
  }
}, 45000)
it.runIf(!!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'real DSH and Codex CLI perform confirmed running-task takeover with isolated native history and provider',
  async () => {
    const f = await setup(undefined, true)
    try {
      const result = await f.start()
      expect(result.handoff).toMatchObject({
        executionState: 'completed',
        state: 'completed',
      })
      expect(result.execution).toMatchObject({
        status: 'completed',
        text: 'CODEX-RELAY-731 total=17 next=verification',
      })
      expect(f.model!.requests).toHaveLength(2)
      const readinessTools = (f.model!.requests[0].tools ?? []).map(
        (tool: any) => tool.name ?? tool.type,
      )
      expect(
        readinessTools.filter((name: string) =>
          /exec_command|shell|apply_patch|mcp|spawn_agent|js_repl/.test(name),
        ),
      ).toEqual([])
      expect(JSON.stringify(f.model!.requests[1])).toContain('fixture-sentinel')
      expect(f.model!.requests[1].model).toBe('gpt-6.1-sol')
      expect(await f.sourceState()).toMatchObject({
        live: false,
        running: false,
      })
      expect(
        (f.model!.requests[1].input as any[]).some(
          (item) => item.type === 'function_call',
        ),
      ).toBe(false)
    } finally {
      await f.close()
    }
  },
  90000,
)

it('requires confirmation before even probing a model and leaves the source running', async () => {
  const f = await setup()
  try {
    await expect(
      f.worker.takeover({
        sourceId: f.sessionId,
        confirmed: false as unknown as true,
        target: {
          cwd: f.target,
          model: 'gpt-6.1-sol',
          sandbox: 'workspace-write',
        },
      }),
    ).rejects.toThrow('Confirm')
    expect(await f.sourceState()).toMatchObject({
      live: true,
      running: true,
      controlled: false,
    })
    await expect(f.nativeState()).rejects.toMatchObject({ code: 'ENOENT' })
    await f.a.rpc('finish-running', { sessionId: f.sessionId })
  } finally {
    await f.close()
  }
}, 30000)
it('keeps an idle ordinary-folder conversation readable without creating continuation work', async () => {
  const f = await setup(undefined, false, false, false, true)
  try {
    const result = await f.start()
    expect(result.handoff).toMatchObject({
      state: 'completed',
      executionState: 'none',
      manifest: { workspace: { kind: 'directory', commit: null } },
    })
    expect(result.execution).toBeNull()
    const reader = await f.client.open(f.sessionId, 'read')
    expect(
      (await f.client.read(reader, 0, 1000)).events.length,
    ).toBeGreaterThan(0)
    await f.client.close(reader, randomUUID())
  } finally {
    await f.close()
  }
}, 45000)
it('rejects a mismatched Git workspace before stopping A', async () => {
  const f = await setup()
  try {
    await rm(join(f.target, '.git'), { recursive: true })
    await expect(f.start()).rejects.toThrow()
    await expect
      .poll(async () => (await f.sourceState()).controlled)
      .toBe(false)
    expect(await f.sourceState()).toMatchObject({ live: true, running: true })
    await f.a.rpc('finish-running', { sessionId: f.sessionId })
  } finally {
    await f.close()
  }
}, 45000)
it('serializes source-stop and execution claims and rejects native-DSH acceptance of a Codex handoff', async () => {
  const f = await setup()
  try {
    const stop = f.store.claimCodexSourceStop.bind(f.store)
    vi.spyOn(f.store, 'claimCodexSourceStop').mockImplementationOnce(
      async (ns, id, r) => {
        const claimed = await stop(ns, id, r)
        await expect(
          f.store.cancelHandoff(ns, id, {
            ...r,
            revision: claimed.revision,
            operationId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'HANDOFF_STATE' })
        return claimed
      },
    )
    const accept = f.store.acceptCodexHandoff.bind(f.store)
    vi.spyOn(f.store, 'acceptCodexHandoff').mockImplementationOnce(
      async (ns, id, r) => {
        await expect(
          f.store.acceptHandoff(ns, id, { ...r, operationId: randomUUID() }),
        ).rejects.toMatchObject({ code: 'ADAPTER_MISMATCH' })
        await expect(
          f.store.acceptCodexHandoff(ns, id, {
            ...r,
            targetSessionId: 'codex:' + randomUUID(),
            operationId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
        return accept(ns, id, r)
      },
    )
    const claim = f.store.claimCodexContinuation.bind(f.store)
    vi.spyOn(f.store, 'claimCodexContinuation').mockImplementationOnce(
      async (ns, id, r) => {
        const [a, b] = await Promise.allSettled([
          claim(ns, id, r),
          claim(ns, id, { ...r, operationId: randomUUID() }),
        ])
        expect([a, b].filter((v) => v.status === 'fulfilled')).toHaveLength(1)
        if (a.status === 'fulfilled') return a.value
        if (b.status === 'fulfilled') return b.value
        throw new Error('Both claims failed')
      },
    )
    expect((await f.start()).handoff.executionState).toBe('completed')
    expect(
      (await f.nativeState()).requests.filter(
        (r: any) => r.method === 'turn/start' && r.params.clientUserMessageId,
      ),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 45000)
it('adopts an unused continuation after a receiver restart, then starts it once', async () => {
  const f = await setup()
  try {
    const accept = f.store.acceptCodexHandoff.bind(f.store)
    vi.spyOn(f.store, 'acceptCodexHandoff').mockImplementationOnce(
      async (...args) => {
        await accept(...args)
        throw new MeshError(
          'RESPONSE_LOST',
          'injected accept response loss',
          500,
        )
      },
    )
    await expect(f.start()).rejects.toThrow()
    const id = (
      await f.store.pool.query(
        'SELECT id FROM cm_handoffs WHERE namespace=$1',
        [f.namespace],
      )
    ).rows[0].id
    expect((await f.worker.status(id)).executionState).toBe('pending')
    const result = await new ConfirmedCodexTakeover(f.options).recover(id, true)
    expect(result.handoff.executionState).toBe('completed')
    expect(
      (await f.nativeState()).requests.filter(
        (r: any) => r.method === 'turn/start' && r.params.clientUserMessageId,
      ),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 45000)
it('exposes the confirmed takeover and status flow through the public CLI', async () => {
  const f = await setup()
  try {
    const executable = join(f.root, 'codex-fixture.mjs')
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
    const run = promisify(execFile),
      common = ['--state-dir', f.options.stateDir, '--codex-bin', executable],
      env = {
        ...f.options.native.env,
        CONTEXTMESH_ENDPOINT: f.endpoint,
        CONTEXTMESH_TOKEN: TOKEN,
      }
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
    await expect(
      call([
        'takeover',
        f.sessionId,
        '--cwd',
        f.target,
        '--model',
        'gpt-6.1-sol',
        '--workspace-write',
      ]),
    ).rejects.toThrow('--confirm')
    expect(await f.sourceState()).toMatchObject({ running: true })
    const result = await call([
      'takeover',
      f.sessionId,
      '--cwd',
      f.target,
      '--model',
      'gpt-6.1-sol',
      '--workspace-write',
      '--confirm',
    ])
    expect(result.handoff.executionState).toBe('completed')
    expect(await call(['takeover-status', result.handoff.id])).toMatchObject({
      executionState: 'completed',
    })
  } finally {
    await f.close()
  }
}, 45000)

it('recovers a lost execution-finish reply without reporting the acknowledged task as uncertain', async () => {
  const f = await setup()
  try {
    const finish = f.store.finishCodexContinuation.bind(f.store)
    vi.spyOn(f.store, 'finishCodexContinuation').mockImplementationOnce(
      async (...args) => {
        await finish(...args)
        throw new MeshError('RESPONSE_LOST', 'injected finish loss', 500)
      },
    )
    const result = await f.start()
    expect(result.handoff.executionState).toBe('completed')
    expect(
      (await f.nativeState()).requests.filter(
        (r: any) => r.method === 'turn/start' && r.params.clientUserMessageId,
      ),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 45000)

it('uses a paired receiver credential even when its node ID is supplied only by server identity', async () => {
  const f = await setup()
  try {
    const owner = new DeviceClient(f.client),
      pair = (await owner.create('Codex only')) as { code: string }
    const config = await DeviceClient.claim(f.endpoint, pair.code, randomUUID())
    const worker = new ConfirmedCodexTakeover({
      ...f.options,
      connection: { ...f.options.connection, token: config.token },
    })
    const result = await worker.takeover({
      sourceId: f.sessionId,
      confirmed: true,
      target: {
        cwd: f.target,
        model: 'gpt-6.1-sol',
        sandbox: 'workspace-write',
      },
    })
    expect(result.handoff.executionState).toBe('completed')
    const endpoints = (
      await f.store.pool.query(
        'SELECT device_id FROM cm_nodes WHERE namespace=$1 AND id=$2',
        [f.namespace, result.handoff.targetNodeId],
      )
    ).rows
    expect(endpoints[0].device_id).toBe(config.nodeId)
  } finally {
    await f.close()
  }
}, 45000)

it('recovers a continuation rejected before its execution claim committed without retaining a stale local pending marker', async () => {
  const f = await setup()
  try {
    vi.spyOn(f.store, 'claimCodexContinuation').mockRejectedValueOnce(
      new MeshError('UNAVAILABLE', 'injected failure before commit', 503),
    )
    await expect(f.start()).rejects.toThrow()
    const id = (
      await f.store.pool.query(
        'SELECT id FROM cm_handoffs WHERE namespace=$1',
        [f.namespace],
      )
    ).rows[0].id
    expect((await f.worker.status(id)).executionState).toBe('pending')
    const restarted = new ConfirmedCodexTakeover(f.options)
    expect((await restarted.recover(id, true)).handoff.executionState).toBe(
      'completed',
    )
    expect(
      (await f.nativeState()).requests.filter(
        (r: any) => r.method === 'turn/start' && r.params.clientUserMessageId,
      ),
    ).toHaveLength(1)
  } finally {
    await f.close()
  }
}, 45000)

it('rejects an empty conversation before source stop or native task creation', async () => {
  const f = await setup(undefined, false, false, false, false, true)
  try {
    await expect(f.start()).rejects.toThrow('no portable messages')
    expect(await f.sourceState()).toMatchObject({
      live: true,
      controlled: false,
    })
    await expect(f.nativeState()).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await f.close()
  }
}, 30000)

it.runIf(!!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'the sidebar confirms a running DSH takeover and its worker continues after the panel closes',
  async () => {
    const f = await setup(undefined, true)
    const panelHome = join(f.root, 'panel-runtime')
    const panel = codexPanel(f.options, panelHome)
    try {
      expect(await panel.request('tools/list')).toMatchObject({
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: 'contextmesh_panel',
            _meta: {
              ui: { resourceUri: 'ui://contextmesh/panel.html' },
              'openai/ui': { entrypoints: [{ type: 'global' }] },
            },
          }),
          expect.objectContaining({
            name: 'contextmesh_start',
            _meta: {
              ui: {
                resourceUri: 'ui://contextmesh/panel.html',
                visibility: ['app'],
              },
            },
          }),
        ]),
      })
      expect(await panel.tool('catalog')).toMatchObject({
        takeoverAvailable: true,
        sessions: expect.arrayContaining([
          expect.objectContaining({ id: f.sessionId }),
        ]),
      })
      const action = {
        kind: 'takeover',
        sourceId: f.sessionId,
        title: 'Running workspace verification',
        target: {
          cwd: f.target,
          sandbox: 'workspace-write',
        },
      }
      await expect(panel.tool('start', action)).rejects.toThrow('confirmation')
      expect(f.model!.requests).toHaveLength(0)
      expect(await f.sourceState()).toMatchObject({ live: true, running: true })
      const { id } = await panel.tool('start', { ...action, confirmed: true })
      panel.close()

      const reopened = codexPanel(f.options, panelHome)
      try {
        await expect
          .poll(async () => (await reopened.tool('jobs'))[0], {
            timeout: 40000,
          })
          .toMatchObject({
            id,
            state: 'completed',
            action: { title: 'Running workspace verification' },
            threadId: expect.any(String),
          })
        const { threads } = await reopened.tool('choices')
        expect(threads).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: (await reopened.tool('jobs'))[0].threadId,
            }),
          ]),
        )
      } finally {
        reopened.close()
      }
      expect(f.model!.requests.map((request) => request.model)).toEqual([
        'gpt-6.1-sol',
        'gpt-6.1-sol',
      ])
      expect(await f.sourceState()).toMatchObject({
        live: false,
        running: false,
      })
    } finally {
      panel.close()
      await f.close()
    }
  },
  90000,
)

it('the sidebar distinguishes saved sessions from unavailable sources and lists compatible archives', async () => {
  const f = await setup(undefined, false, false)
  const panel = codexPanel(f.options, join(f.root, 'panel-runtime'))
  try {
    await f.a.stop()
    const nativeThreadId = randomUUID()
    const archive = await f.store.publishCodexGuiArchive(f.namespace, {
      operationId: randomUUID(),
      nativeThreadId,
      cliVersion: '0.154.0',
      context: {
        version: 1,
        source: {
          adapter: 'codex',
          id: nativeThreadId,
          incarnation: nativeThreadId,
          eventCount: 1,
        },
        messages: [{ role: 'user', text: 'Isolated archive fixture' }],
      },
    })
    const sessions = (await panel.tool('catalog')).sessions
    expect(sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.sessionId,
          adapter: 'deepseek',
          status: 'import',
        }),
        expect.objectContaining({
          id: archive.id,
          adapter: 'codex',
          status: 'import',
        }),
      ]),
    )
    await f.store.pool.query(
      'UPDATE cm_sessions SET recovery_required=true WHERE namespace=$1 AND id=$2',
      [f.namespace, f.sessionId],
    )
    expect((await panel.tool('catalog')).sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: f.sessionId, status: 'recovery' }),
      ]),
    )
    const resource = await panel.request('resources/read', {
      uri: 'ui://contextmesh/panel.html',
    })
    expect(resource).toMatchObject({
      contents: [
        expect.objectContaining({
          text: expect.stringContaining('data-view="activity"'),
        }),
      ],
    })
    expect(JSON.stringify(resource)).toContain('Choose Folder…')
    expect(JSON.stringify(resource)).not.toContain('Local Codex model')
    expect(JSON.stringify(resource)).not.toContain('remote DSH')
  } finally {
    panel.close()
    await f.close()
  }
}, 30000)

it.runIf(!!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'the sidebar imports a saved session without starting model work or changing the source',
  async () => {
    const f = await setup(undefined, true, false)
    const panelHome = join(f.root, 'panel-runtime')
    const panel = codexPanel(f.options, panelHome)
    try {
      await f.a.stop()
      const before = await f.client.stat(f.sessionId)
      const { id } = await panel.tool('start', {
        kind: 'import',
        sourceAdapter: 'deepseek',
        sourceId: f.sessionId,
        title: 'Saved workspace verification',
        target: { cwd: f.target, sandbox: 'read-only' },
        confirmed: true,
      })
      await expect
        .poll(async () => (await panel.tool('jobs'))[0], { timeout: 12000 })
        .toMatchObject({
          id,
          state: 'completed',
          action: { title: 'Saved workspace verification' },
          threadId: expect.any(String),
        })
      const imported = JSON.parse(
        await readFile(
          join(panelHome, 'data/codex-bridge/imports', id + '.json'),
          'utf8',
        ),
      )
      expect(imported.target).toMatchObject({
        model: 'gpt-6.1-sol',
        provider: 'fixture',
      })
      expect(f.model!.requests).toHaveLength(0)
      expect(await f.client.stat(f.sessionId)).toEqual(before)
    } finally {
      panel.close()
      await f.close()
    }
  },
  30000,
)
