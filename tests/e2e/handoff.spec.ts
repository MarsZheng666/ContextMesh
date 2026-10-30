import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  realpath,
  stat,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fixture, TOKEN } from '../fixture.js'
import { buildServer } from '../../apps/server/src/app.js'
import {
  callLocal,
  controlSocketPath,
} from '../../packages/handoff-deepseek/src/local-control.js'
const execute = promisify(execFile)
const reply = z.object({
  id: z.number().optional(),
  ready: z.boolean().optional(),
  nodeId: z.string().optional(),
  ok: z.boolean().optional(),
  value: z.unknown().optional(),
  error: z.string().optional(),
})

import { environment } from '../helpers/handoff-environment.js'

it(
  'hands a native Web session A to B and back with native history, model context, cwd and file policy intact',
  async () => {
    const f = await environment()
    try {
      const a = await f.launch('A', f.source, true),
        b = await f.launch('B', f.target),
        projectId = randomUUID(),
        sessionId = randomUUID()
      await a.rpc('m1', {
        command: { action: 'project', projectId, name: 'fixture' },
      })
      await a.rpc('m1', {
        command: { action: 'mapping', projectId, root: f.source },
      })
      await b.rpc('m1', {
        command: { action: 'mapping', projectId, root: f.target },
      })
      const graph = z
        .object({ browserGraph: z.unknown() })
        .parse(await a.rpc('state', { sessionId })).browserGraph
      expect(JSON.stringify(graph)).toContain('dsh-contextmesh-handoff')
      await a.rpc('create', { sessionId })
      await a.rpc('prompt', {
        sessionId,
        text: 'Remember CONTINUITY-PHRASE-4817.',
      })
      const before = await f.client.stat(sessionId)
      const requested = z.object({ id: z.string() }).parse(
        await a.rpc('m1', {
          command: { action: 'handoff', sessionId, targetNodeId: b.nodeId },
        }),
      )
      await expect
        .poll(
          async () =>
            z
              .object({ state: z.string() })
              .parse(await f.client.request(`/v1/handoffs/${requested.id}`))
              .state,
          { timeout: 15000 },
        )
        .toBe('completed')
      expect(
        z
          .object({ live: z.boolean() })
          .parse(await a.rpc('state', { sessionId })).live,
      ).toBe(false)
      const sourceCatalog = z
        .object({
          sidebarSessions: z.array(
            z.object({
              sessionId: z.string(),
              agentAvailable: z.boolean(),
              running: z.boolean(),
            }),
          ),
        })
        .parse(await a.rpc('state', { sessionId }))
      expect(sourceCatalog.sidebarSessions).toContainEqual({
        sessionId,
        agentAvailable: false,
        running: false,
      })
      const continued = z
        .object({
          cwd: z.string(),
          policy: z.object({ mode: z.string(), workspaceRoot: z.string() }),
          events: z.array(z.object({ type: z.string(), data: z.unknown() })),
        })
        .parse(
          await b.rpc('prompt', {
            sessionId,
            text: 'READ_WORKSPACE on B; retain the continuity phrase.',
          }),
        )
      expect(continued.cwd).toBe(f.target)
      expect(continued.policy).toMatchObject({
        mode: 'workspace-write',
        workspaceRoot: f.target,
      })
      expect(
        JSON.stringify(
          continued.events.filter((e) => e.type === 'tool/result'),
        ),
      ).toContain('fixture-sentinel')
      expect(
        JSON.stringify(
          continued.events.filter((e) => e.type === 'tool/result'),
        ),
      ).toContain(f.target)
      expect(
        JSON.stringify(
          continued.events.filter((e) => e.type === 'assistant/message'),
        ),
      ).toContain('CONTINUITY-PHRASE-4817')
      const back = z.object({ id: z.string() }).parse(
        await b.rpc('m1', {
          command: { action: 'handoff', sessionId, targetNodeId: a.nodeId },
        }),
      )
      await expect
        .poll(
          async () =>
            z
              .object({ state: z.string() })
              .parse(await f.client.request(`/v1/handoffs/${back.id}`)).state,
          { timeout: 15000 },
        )
        .toBe('completed')
      const returned = z
        .object({
          cwd: z.string(),
          policy: z.object({ workspaceRoot: z.string() }),
        })
        .parse(
          await a.rpc('prompt', {
            sessionId,
            text: 'READ_WORKSPACE on A again.',
          }),
        )
      expect(returned.cwd).toBe(f.source)
      expect(returned.policy.workspaceRoot).toBe(f.source)
      expect((await f.client.stat(sessionId))!.header).toEqual(before!.header)
      const api = z
        .object({
          status: z.number(),
          body: z.object({ ok: z.boolean() }),
          origin: z.string(),
        })
        .parse(await a.rpc('api', { command: { action: 'status' } }))
      expect(api.status).toBe(200)
      expect(api.body.ok).toBe(true)
      expect((await fetch(`${api.origin}/api/contextmesh`)).status).toBe(401)
      expect(
        (await stat(await controlSocketPath(a.stateDir))).mode & 0o777,
      ).toBe(0o600)
      const cli = await execute(
        process.execPath,
        [resolve('dist/cli.js'), 'devices', '--state-dir', a.stateDir],
        { env: { PATH: process.env.PATH }, encoding: 'utf8' },
      )
      expect(JSON.parse(cli.stdout)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: a.nodeId }),
          expect.objectContaining({ id: b.nodeId }),
        ]),
      )
      expect(await callLocal(a.stateDir, { action: 'status' })).toMatchObject({
        ok: true,
        value: { nodeId: a.nodeId },
      })
    } finally {
      await f.close()
    }
  },
  process.env.CONTEXTMESH_TEST_REAL_MODEL === '1' ? 240000 : 60000,
)

async function pair(
  sourceMode?: 'read-only' | 'workspace-write',
  targetMode?: 'read-only' | 'workspace-write',
) {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, false, false, sourceMode),
      b = await f.launch('B', f.target, false, false, targetMode),
      projectId = randomUUID(),
      sessionId = randomUUID()
    await a.rpc('m1', {
      command: { action: 'project', projectId, name: 'fault-fixture' },
    })
    for (const [node, root] of [
      [a, f.source],
      [b, f.target],
    ] as const)
      await node.rpc('m1', { command: { action: 'mapping', projectId, root } })
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember CONTINUITY-PHRASE-4817.',
    })
    return { ...f, a, b, sessionId }
  } catch (error) {
    await f.close()
    throw error
  }
}
for (const method of ['acceptHandoff', 'completeHandoff'] as const)
  it(`reconciles a committed ${method} whose responses are lost`, async () => {
    const f = await pair()
    try {
      const original = f.store[method].bind(f.store)
      vi.spyOn(f.store, method).mockImplementation(
        async (...args: Parameters<typeof original>) => {
          await Reflect.apply(original, undefined, args)
          throw new Error('injected lost committed response')
        },
      )
      const record = z.object({ id: z.string() }).parse(
        await f.a.rpc('m1', {
          command: {
            action: 'handoff',
            sessionId: f.sessionId,
            targetNodeId: f.b.nodeId,
          },
        }),
      )
      await expect
        .poll(
          async () =>
            z
              .object({ state: z.string() })
              .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
          { timeout: 15000 },
        )
        .toBe('completed')
      let result: unknown
      await expect
        .poll(
          async () => {
            try {
              result = await f.b.rpc('prompt', {
                sessionId: f.sessionId,
                text: 'READ_WORKSPACE after lost response.',
              })
              return true
            } catch {
              return false
            }
          },
          { timeout: 10000 },
        )
        .toBe(true)
      expect(JSON.stringify(result)).toContain('fixture-sentinel')
      const events = z
        .object({ events: z.array(z.object({ type: z.string() })) })
        .parse(result).events
      expect(
        events.filter((e) => e.type === 'working-directory/change'),
      ).toHaveLength(1)
    } finally {
      await f.close()
    }
  }, 40000)
it('rejects a dirty target without stopping the original writer', async () => {
  const f = await pair()
  try {
    await writeFile(join(f.target, 'untracked.txt'), 'dirty')
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 12000 },
      )
      .toBe('failed')
    await expect
      .poll(
        async () => {
          try {
            await f.a.rpc('prompt', {
              sessionId: f.sessionId,
              text: 'Continue on the original writer.',
            })
            return true
          } catch {
            return false
          }
        },
        { timeout: 10000 },
      )
      .toBe(true)
    expect(
      z
        .object({ live: z.boolean() })
        .parse(await f.b.rpc('state', { sessionId: f.sessionId })).live,
    ).toBe(false)
  } finally {
    await f.close()
  }
}, 40000)
it('retries an uncertain initial request with its original operation id', async () => {
  const f = await pair()
  try {
    const original = f.store.requestHandoff.bind(f.store)
    let available = false
    vi.spyOn(f.store, 'requestHandoff').mockImplementation(
      async (...args: Parameters<typeof original>) => {
        if (!available) throw new Error('injected offline')
        return original(...args)
      },
    )
    await expect(
      f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    ).rejects.toThrow()
    await expect(
      f.a.rpc('prompt', { sessionId: f.sessionId, text: 'Must remain frozen' }),
    ).rejects.toThrow()
    available = true
    await expect
      .poll(
        async () => {
          const rows = await f.store.pool.query(
            'SELECT state FROM cm_handoffs WHERE namespace=$1 AND session_id=$2',
            [f.namespace, f.sessionId],
          )
          return rows.rows.map((r) => r.state)
        },
        { timeout: 15000 },
      )
      .toEqual(['completed'])
  } finally {
    await f.close()
  }
}, 40000)

it('requires explicit recovery after a lost source-close response, then resumes safely', async () => {
  const f = await pair()
  try {
    const row = (
      await f.store.pool.query(
        'SELECT active_handle FROM cm_sessions WHERE namespace=$1 AND id=$2',
        [f.namespace, f.sessionId],
      )
    ).rows[0]
    const original = f.store.close.bind(f.store)
    const fault = vi
      .spyOn(f.store, 'close')
      .mockImplementation(async (...args) => {
        const result = await original(...args)
        if (args[1] === row.active_handle)
          throw new Error('injected source close response lost')
        return result
      })
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('recovery_required')
    fault.mockRestore()
    const summaries = await f.client.request('/v1/remote-sessions')
    expect(summaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: f.sessionId,
          recoveryRequired: true,
          handoffState: 'recovery_required',
        }),
      ]),
    )
    expect(
      z
        .object({ live: z.boolean() })
        .parse(await f.a.rpc('state', { sessionId: f.sessionId })).live,
    ).toBe(false)
    expect(
      z
        .object({ live: z.boolean() })
        .parse(await f.b.rpc('state', { sessionId: f.sessionId })).live,
    ).toBe(false)
    const fresh = z
      .object({ revision: z.number() })
      .parse(await f.client.request(`/v1/handoffs/${record.id}`))
    await f.client.request(`/v1/handoffs/${record.id}/recover`, {
      operationId: randomUUID(),
      revision: fresh.revision,
      confirmStopped: true,
    })
    await f.a.rpc('m1', {
      command: { action: 'resume', sessionId: f.sessionId },
    })
    const resumedStatus = z
      .object({ errors: z.record(z.string(), z.string()) })
      .parse(await f.a.rpc('m1', { command: { action: 'status' } }))
    expect(resumedStatus.errors[f.sessionId]).toBeUndefined()
    expect(
      JSON.stringify(
        await f.a.rpc('prompt', {
          sessionId: f.sessionId,
          text: 'READ_WORKSPACE after explicit recovery.',
        }),
      ),
    ).toContain('fixture-sentinel')
  } finally {
    await f.close()
  }
}, 40000)

it('disposes and fences a live native Agent after detecting ownership loss', async () => {
  const f = await pair()
  try {
    await f.store.pool.query(
      'UPDATE cm_sessions SET epoch=epoch+1,active_handle=NULL,lease_until=NULL WHERE namespace=$1 AND id=$2',
      [f.namespace, f.sessionId],
    )
    await expect(
      f.a.rpc('prompt', {
        sessionId: f.sessionId,
        text: 'Trigger lease validation.',
      }),
    ).rejects.toThrow()
    await expect
      .poll(
        async () =>
          z
            .object({ live: z.boolean() })
            .parse(await f.a.rpc('state', { sessionId: f.sessionId })).live,
        { timeout: 10000 },
      )
      .toBe(false)
    await expect(
      f.a.rpc('prompt', {
        sessionId: f.sessionId,
        text: 'Must not automatically resume.',
      }),
    ).rejects.toThrow('SESSION_FROZEN')
  } finally {
    await f.close()
  }
}, 40000)

it('restarts the target without losing its later local cwd or stricter sandbox mode', async () => {
  const f = await pair()
  try {
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('completed')
    await expect
      .poll(
        async () => {
          try {
            await f.b.rpc('local-settings', {
              sessionId: f.sessionId,
              cwd: join(f.target, 'nested'),
              mode: 'read-only',
            })
            return true
          } catch {
            return false
          }
        },
        { timeout: 10000 },
      )
      .toBe(true)
    await f.b.stop()
    const restarted = await f.launch('B', f.target)
    expect(restarted.nodeId).toBe(f.b.nodeId)
    await restarted.rpc('m1', {
      command: { action: 'resume', sessionId: f.sessionId },
    })
    const continued = z
      .object({
        cwd: z.string(),
        policy: z.object({ mode: z.string(), workspaceRoot: z.string() }),
        events: z.unknown(),
      })
      .parse(
        await restarted.rpc('prompt', {
          sessionId: f.sessionId,
          text: 'READ_WORKSPACE after cold restart.',
        }),
      )
    expect(continued.cwd).toBe(join(f.target, 'nested'))
    expect(continued.policy).toMatchObject({
      mode: 'read-only',
      workspaceRoot: f.target,
    })
    expect(JSON.stringify(continued.events)).toContain(
      'nested-fixture-sentinel',
    )
  } finally {
    await f.close()
  }
}, 40000)

it('includes scoped teardown events in the fixed final cut and shared title', async () => {
  const f = await pair()
  try {
    await f.a.rpc('local-settings', {
      sessionId: f.sessionId,
      finalTitle: 'Final scoped handoff title',
    })
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('completed')
    const final = z
      .object({ finalNextSeq: z.number() })
      .parse(await f.client.request(`/v1/handoffs/${record.id}`))
    const history = z
      .object({
        events: z.array(
          z.object({ seq: z.number(), type: z.string(), data: z.unknown() }),
        ),
      })
      .parse(
        await f.b.rpc('m1', {
          command: { action: 'history', sessionId: f.sessionId, offset: 0 },
        }),
      )
    expect(history.events[final.finalNextSeq - 1]).toMatchObject({
      type: 'session/title',
      data: { title: 'Final scoped handoff title' },
    })
    await expect
      .poll(
        async () => {
          const rows = z
            .array(z.object({ id: z.string(), title: z.string().nullable() }))
            .parse(await f.client.request('/v1/remote-sessions'))
          return rows.find((r) => r.id === f.sessionId)?.title
        },
        { timeout: 10000 },
      )
      .toBe('Final scoped handoff title')
  } finally {
    await f.close()
  }
}, 40000)
it('continues the same reserved handoff after the HTTP service restarts', async () => {
  const f = await pair()
  try {
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await f.app.close()
    await new Promise((resolve) => setTimeout(resolve, 350))
    const replacement = buildServer({
      store: f.store,
      token: TOKEN,
      namespace: f.namespace,
    })
    f.defer(() => replacement.close())
    await replacement.listen({
      host: '127.0.0.1',
      port: Number(new URL(f.endpoint).port),
    })
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('completed')
    await expect
      .poll(
        async () => {
          try {
            const result = await f.b.rpc('prompt', {
              sessionId: f.sessionId,
              text: 'READ_WORKSPACE after service restart.',
            })
            return JSON.stringify(result).includes('fixture-sentinel')
          } catch {
            return false
          }
        },
        { timeout: 10000 },
      )
      .toBe(true)
  } finally {
    await f.close()
  }
}, 40000)
it('closes a failed target restore and permits explicit return to the source', async () => {
  const f = await pair()
  try {
    const bad = await f.launch('C', f.target, false, true)
    const projectId = z
      .object({ projects: z.array(z.object({ id: z.string() })) })
      .parse(await f.a.rpc('m1', { command: { action: 'status' } }))
      .projects[0]!.id
    await bad.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.target },
    })
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: bad.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('failed')
    expect(
      z
        .object({ live: z.boolean() })
        .parse(await bad.rpc('state', { sessionId: f.sessionId })).live,
    ).toBe(false)
    await f.a.rpc('m1', {
      command: { action: 'resume', sessionId: f.sessionId },
    })
    const continued = z.object({ cwd: z.string(), events: z.unknown() }).parse(
      await f.a.rpc('prompt', {
        sessionId: f.sessionId,
        text: 'READ_WORKSPACE after failed target restore.',
      }),
    )
    expect(continued.cwd).toBe(f.source)
    expect(JSON.stringify(continued.events)).toContain('fixture-sentinel')
  } finally {
    await f.close()
  }
}, 40000)

it('checks the target isolated preset policy before stopping the source', async () => {
  const f = await pair('workspace-write', 'read-only')
  try {
    const record = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${record.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('failed')
    const failure = z
      .object({ error: z.string() })
      .parse(await f.client.request(`/v1/handoffs/${record.id}`))
    expect(failure.error).toContain('target preset policy is stricter')
    expect(
      z
        .object({ live: z.boolean() })
        .parse(await f.a.rpc('state', { sessionId: f.sessionId })).live,
    ).toBe(true)
    await expect
      .poll(
        async () => {
          try {
            await f.a.rpc('prompt', {
              sessionId: f.sessionId,
              text: 'Continue on the original device.',
            })
            return true
          } catch {
            return false
          }
        },
        { timeout: 10000 },
      )
      .toBe(true)
  } finally {
    await f.close()
  }
}, 40000)

it('takes over from the target, cancels active source work, and continues the same native session', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, true),
      b = await f.launch('B', f.target),
      projectId = randomUUID(),
      sessionId = randomUUID()
    await a.rpc('m1', {
      command: { action: 'project', projectId, name: 'takeover' },
    })
    await a.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.source },
    })
    await b.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.target },
    })
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember CONTINUITY-PHRASE-4817.',
    })
    await a.rpc('m1', { command: { action: 'refresh' } })
    await a.rpc('start-running', {
      sessionId,
      text: 'Keep working until interrupted',
    })
    await expect
      .poll(
        async () =>
          z
            .object({ running: z.boolean() })
            .parse(await a.rpc('state', { sessionId })).running,
      )
      .toBe(true)
    const request = z.object({ id: z.string() }).parse(
      await b.rpc('m1', {
        command: { action: 'takeover', sessionId, confirmed: true },
      }),
    )
    await expect
      .poll(
        async () =>
          z.object({ handoffState: z.string().optional() }).parse(
            await b.rpc('m1', {
              command: { action: 'takeover-status', takeoverId: request.id },
            }),
          ).handoffState,
        { timeout: 20000 },
      )
      .toBe('completed')
    expect(
      z.object({ live: z.boolean() }).parse(await a.rpc('state', { sessionId }))
        .live,
    ).toBe(false)
    const continued = z
      .object({
        cwd: z.string(),
        events: z.array(z.object({ type: z.string(), data: z.unknown() })),
      })
      .parse(
        await b.rpc('prompt', {
          sessionId,
          text: 'READ_WORKSPACE and retain context',
        }),
      )
    expect(continued.cwd).toBe(f.target)
    expect(
      JSON.stringify(
        continued.events.filter((e) => e.type === 'assistant/message'),
      ),
    ).toContain('CONTINUITY-PHRASE-4817')
    expect(
      JSON.stringify(continued.events.filter((e) => e.type === 'tool/result')),
    ).toContain('fixture-sentinel')
    expect((await f.client.stat(sessionId))?.header.id).toBe(sessionId)
  } finally {
    await f.close()
  }
}, 40000)

it('keeps native cold history read-only instead of activating a writer', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, true),
      b = await f.launch('B', f.target, true),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', { sessionId, text: 'Read-only history fixture' })
    await a.stop()
    const before = await f.client.stat(sessionId)
    const followed = z
      .object({
        live: z.boolean(),
        snapshot: z.object({ type: z.literal('snapshot') }),
      })
      .parse(await b.rpc('history-follow', { sessionId }))
    expect(followed.live).toBe(false)
    expect(await f.client.stat(sessionId)).toEqual(before)
  } finally {
    await f.close()
  }
}, 40000)

for (const restore of ['resume', 'native-resume'] as const)
  it(`remaps a foreign persisted cwd on ${restore} before permitting another takeover`, async () => {
    const f = await pair()
    try {
      const transfer = z.object({ id: z.string() }).parse(
        await f.a.rpc('m1', {
          command: {
            action: 'handoff',
            sessionId: f.sessionId,
            targetNodeId: f.b.nodeId,
          },
        }),
      )
      await expect
        .poll(
          async () =>
            z
              .object({ state: z.string() })
              .parse(await f.client.request(`/v1/handoffs/${transfer.id}`))
              .state,
          { timeout: 15000 },
        )
        .toBe('completed')
      await expect
        .poll(
          async () => {
            try {
              // Simulate the last persisted directory belonging to the other device.
              await f.b.rpc('local-settings', {
                sessionId: f.sessionId,
                cwd: f.source,
                mode: 'read-only',
              })
              return true
            } catch {
              return false
            }
          },
          { timeout: 10000 },
        )
        .toBe(true)
      await f.b.stop()
      const restarted = await f.launch('B', f.target)
      if (restore === 'resume')
        await restarted.rpc('m1', {
          command: { action: 'resume', sessionId: f.sessionId },
        })
      else await restarted.rpc('native-resume', { sessionId: f.sessionId })
      const resumed = z
        .object({
          cwd: z.string(),
          policy: z.object({ mode: z.string(), workspaceRoot: z.string() }),
        })
        .parse(
          await restarted.rpc('prompt', {
            sessionId: f.sessionId,
            text: 'READ_WORKSPACE after foreign cwd restore',
          }),
        )
      expect(resumed.cwd).toBe(f.target)
      expect(resumed.policy).toMatchObject({
        mode: 'read-only',
        workspaceRoot: f.target,
      })
      const takeover = z.object({ id: z.string() }).parse(
        await f.a.rpc('m1', {
          command: {
            action: 'takeover',
            sessionId: f.sessionId,
            confirmed: true,
          },
        }),
      )
      await expect
        .poll(
          async () =>
            z.object({ handoffState: z.string().optional() }).parse(
              await f.a.rpc('m1', {
                command: { action: 'takeover-status', takeoverId: takeover.id },
              }),
            ).handoffState,
          { timeout: 20000 },
        )
        .toBe('completed')
    } finally {
      await f.close()
    }
  }, 40000)

it('restores the original source through native Web using its completed outgoing handoff', async () => {
  const f = await pair()
  try {
    const transfer = z.object({ id: z.string() }).parse(
      await f.a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId: f.sessionId,
          targetNodeId: f.b.nodeId,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request(`/v1/handoffs/${transfer.id}`)).state,
        { timeout: 15000 },
      )
      .toBe('completed')
    await f.a.stop()
    await f.b.stop()
    const restarted = await f.launch('A', f.source)
    await restarted.rpc('native-resume', { sessionId: f.sessionId })
    const restored = z
      .object({
        cwd: z.string(),
        policy: z.object({ workspaceRoot: z.string() }),
      })
      .parse(
        await restarted.rpc('prompt', {
          sessionId: f.sessionId,
          text: 'READ_WORKSPACE on original source after cold restart',
        }),
      )
    expect(restored.cwd).toBe(f.source)
    expect(restored.policy.workspaceRoot).toBe(f.source)
  } finally {
    await f.close()
  }
}, 40000)

it('configures an unassigned native session from the destination and takes it over without a source setup step', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      b = await f.launch('B', f.target),
      sessionId = randomUUID(),
      projectId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember CONTINUITY-PHRASE-4817.',
    })
    const incarnation = (await f.client.stat(sessionId))!.incarnation
    await b.rpc('m1', {
      command: { action: 'project', projectId, name: 'Chosen on destination' },
    })
    await b.rpc('m1', {
      command: {
        action: 'configure-project',
        sessionId,
        projectId,
        incarnation,
        expectedSourceNodeId: a.nodeId,
        root: f.target,
      },
    })
    expect(
      await f.client.request('/v1/nodes/' + a.nodeId + '/mappings'),
    ).toEqual([])
    const intent = z.object({ id: z.string() }).parse(
      await b.rpc('m1', {
        command: { action: 'takeover', sessionId, confirmed: true },
      }),
    )
    await expect
      .poll(
        async () =>
          z.object({ handoffState: z.string().optional() }).parse(
            await b.rpc('m1', {
              command: { action: 'takeover-status', takeoverId: intent.id },
            }),
          ).handoffState,
        { timeout: 20000 },
      )
      .toBe('completed')
    const continued = z.object({ cwd: z.string(), events: z.unknown() }).parse(
      await b.rpc('prompt', {
        sessionId,
        text: 'READ_WORKSPACE and recall the marker',
      }),
    )
    expect(continued.cwd).toBe(f.target)
    expect(JSON.stringify(continued.events)).toContain('CONTINUITY-PHRASE-4817')
    expect(
      await f.client.request('/v1/nodes/' + a.nodeId + '/mappings'),
    ).toEqual([
      expect.objectContaining({ projectId, root: f.source, revision: 1 }),
    ])
  } finally {
    await f.close()
  }
}, 40000)

it('keeps project setup open for correction instead of replacing a conflicting source directory', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      b = await f.launch('B', f.target),
      sessionId = randomUUID(),
      projectId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', { sessionId, text: 'Unassigned workspace fixture' })
    await b.rpc('m1', {
      command: { action: 'project', projectId, name: 'Wrong source mapping' },
    })
    await a.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.target },
    })
    const incarnation = (await f.client.stat(sessionId))!.incarnation
    await expect(
      b.rpc('m1', {
        command: {
          action: 'configure-project',
          sessionId,
          projectId,
          incarnation,
          expectedSourceNodeId: a.nodeId,
          root: f.target,
        },
      }),
    ).rejects.toThrow('outside this project')
    expect(
      await f.client.request('/v1/nodes/' + a.nodeId + '/mappings'),
    ).toEqual([
      expect.objectContaining({ projectId, root: f.target, revision: 1 }),
    ])
    const sessions = z
      .array(z.object({ id: z.string(), projectId: z.string().nullable() }))
      .parse(await f.client.request('/v1/remote-sessions'))
    expect(sessions.find((s) => s.id === sessionId)?.projectId).toBeNull()
  } finally {
    await f.close()
  }
}, 40000)

it('takes over a plain conversation without Git, keeps target-local files, and resumes after restart', async () => {
  const f = await environment()
  try {
    const notes = join(f.root, 'notes'),
      destination = join(f.root, 'destination')
    await mkdir(notes)
    await mkdir(destination)
    await writeFile(join(notes, 'handoff-sentinel.txt'), 'source-local-file')
    await writeFile(
      join(destination, 'handoff-sentinel.txt'),
      'target-local-file',
    )
    const a = await f.launch('A', notes),
      b = await f.launch('B', destination),
      sessionId = randomUUID(),
      projectId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember CONTINUITY-PHRASE-4817.',
    })
    await b.rpc('m1', {
      command: { action: 'project', projectId, name: 'Plain conversation' },
    })
    const incarnation = (await f.client.stat(sessionId))!.incarnation
    await b.rpc('m1', {
      command: {
        action: 'configure-project',
        sessionId,
        projectId,
        incarnation,
        expectedSourceNodeId: a.nodeId,
        root: destination,
      },
    })
    const intent = z.object({ id: z.string() }).parse(
      await b.rpc('m1', {
        command: { action: 'takeover', sessionId, confirmed: true },
      }),
    )
    await expect
      .poll(
        async () =>
          z.object({ handoffState: z.string().optional() }).parse(
            await b.rpc('m1', {
              command: { action: 'takeover-status', takeoverId: intent.id },
            }),
          ).handoffState,
        { timeout: 20000 },
      )
      .toBe('completed')
    const records = z
      .array(
        z.object({
          sessionId: z.string(),
          manifest: z.object({
            workspace: z.object({
              kind: z.literal('directory'),
              commit: z.null(),
            }),
          }),
        }),
      )
      .parse(
        await f.client.request(
          `/v1/nodes/${b.nodeId}/commands?instanceId=${z.object({ instanceId: z.string() }).parse(((await f.client.request('/v1/nodes')) as unknown[]).find((n: unknown) => z.object({ id: z.string() }).parse(n).id === b.nodeId)).instanceId}`,
        ),
      )
    expect(records.some((r) => r.sessionId === sessionId)).toBe(true)
    await expect
      .poll(
        async () => {
          try {
            await b.rpc('local-settings', { sessionId, mode: 'read-only' })
            return true
          } catch {
            return false
          }
        },
        { timeout: 10000 },
      )
      .toBe(true)
    await b.stop()
    const restarted = await f.launch('B', destination)
    await restarted.rpc('m1', { command: { action: 'resume', sessionId } })
    const continued = z
      .object({
        cwd: z.string(),
        policy: z.object({ mode: z.string(), workspaceRoot: z.string() }),
        events: z.unknown(),
      })
      .parse(
        await restarted.rpc('prompt', {
          sessionId,
          text: 'READ_WORKSPACE and recall the marker',
        }),
      )
    expect(continued.cwd).toBe(destination)
    expect(continued.policy).toMatchObject({
      mode: 'read-only',
      workspaceRoot: destination,
    })
    expect(JSON.stringify(continued.events)).toContain('CONTINUITY-PHRASE-4817')
    expect(JSON.stringify(continued.events)).toContain('target-local-file')
    expect(await readFile(join(notes, 'handoff-sentinel.txt'), 'utf8')).toBe(
      'source-local-file',
    )
    expect(
      await readFile(join(destination, 'handoff-sentinel.txt'), 'utf8'),
    ).toBe('target-local-file')
  } finally {
    await f.close()
  }
}, 50000)
