import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
import { MeshError } from '../../packages/protocol/src/index.js'

const state = z.object({
  live: z.boolean(),
  running: z.boolean().optional(),
  controlled: z.boolean(),
  modelRequests: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      messages: z.array(z.unknown()),
    }),
  ),
})
async function setup(missing = false, tool = false) {
  const f = await environment()
  const a = await f.launch('A', f.source),
    b = await f.launch(
      'B',
      f.target,
      false,
      false,
      undefined,
      true,
      undefined,
      { provider: missing ? 'absent' : 'contextmesh-second', model: 'relay' },
    )
  const sessionId = randomUUID(),
    projectId = randomUUID()
  await a.rpc('m1', {
    command: { action: 'project', projectId, name: 'continuation' },
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
    text: 'READ_WORKSPACE and remember CONTINUITY-PHRASE-4817.',
  })
  await a.rpc('m1', { command: { action: 'refresh' } })
  await a.rpc(tool ? 'start-tool' : 'start-running', {
    sessionId,
    text: tool
      ? 'READ_WORKSPACE again then finish the original unfinished task.'
      : 'Finish the original unfinished task using the marker and completed workspace read.',
  })
  await expect
    .poll(async () => state.parse(await a.rpc('state', { sessionId })).running)
    .toBe(true)
  const takeover = async () =>
    z.object({ id: z.string() }).parse(
      await b.rpc('m1', {
        command: { action: 'takeover', sessionId, confirmed: true },
      }),
    )
  const status = async (id: string) =>
    z
      .object({
        handoffState: z.string().optional(),
        handoffId: z.string().optional(),
      })
      .parse(
        await b.rpc('m1', {
          command: { action: 'takeover-status', takeoverId: id },
        }),
      )
  const events = async () => {
    const h = await f.client.open(sessionId, 'read')
    try {
      return (await f.client.read(h, 0, Number.MAX_SAFE_INTEGER)).events
    } finally {
      await f.client.close(h, randomUUID())
    }
  }
  return { ...f, a, b, sessionId, takeover, status, events }
}
it.each([false, true])(
  'automatically continues on a receiver with only another provider; lost completion response=%s',
  async (lost) => {
    const f = await setup()
    try {
      const complete = f.store.completeHandoff.bind(f.store)
      if (lost)
        vi.spyOn(f.store, 'completeHandoff').mockImplementationOnce(
          async (...args) => {
            await complete(...args)
            throw new MeshError(
              'RESPONSE_LOST',
              'injected lost response after commit',
              500,
            )
          },
        )
      const original = await f.events(),
        operation = await f.takeover()
      await expect
        .poll(async () => (await f.status(operation.id)).handoffState, {
          timeout: 20000,
        })
        .toBe('completed')
      await expect
        .poll(
          async () =>
            state.parse(await f.b.rpc('state', { sessionId: f.sessionId }))
              .modelRequests.length,
          { timeout: 10000 },
        )
        .toBe(1)
      await expect
        .poll(
          async () =>
            state.parse(await f.b.rpc('state', { sessionId: f.sessionId }))
              .running,
        )
        .toBe(false)
      const next = state.parse(
        await f.b.rpc('state', { sessionId: f.sessionId }),
      ).modelRequests[0]!
      expect(next).toMatchObject({
        provider: 'contextmesh-second',
        model: 'relay',
      })
      expect(JSON.stringify(next.messages)).toContain('CONTINUITY-PHRASE-4817')
      expect(JSON.stringify(next.messages)).toContain('fixture-sentinel')
      expect(JSON.stringify(next.messages)).toContain(
        'Finish the original unfinished task',
      )
      expect(
        state.parse(await f.a.rpc('state', { sessionId: f.sessionId })).live,
      ).toBe(false)
      await expect
        .poll(async () => JSON.stringify(await f.events()))
        .toContain('contextmesh-continuation')
      const final = await f.events()
      expect(final.slice(0, original.length)).toEqual(original)
      expect(final.filter((e) => e.type === 'tool/result')).toHaveLength(
        original.filter((e) => e.type === 'tool/result').length,
      )
      expect(
        final.filter(
          (e) =>
            e.type === 'user/message' &&
            JSON.stringify(e.data).includes('contextmesh-continuation'),
        ),
      ).toHaveLength(1)
      await f.b.rpc('m1', { command: { action: 'refresh' } })
      await f.b.stop()
      const restarted = await f.launch(
        'B',
        f.target,
        false,
        false,
        undefined,
        true,
      )
      await restarted.rpc('native-resume', { sessionId: f.sessionId })
      await restarted.rpc('m1', { command: { action: 'refresh' } })
      expect(
        state.parse(await restarted.rpc('state', { sessionId: f.sessionId }))
          .modelRequests,
      ).toHaveLength(0)
    } finally {
      await f.close()
    }
  },
  40000,
)
it('leaves A running when receiver preflight fails', async () => {
  const f = await setup(true)
  try {
    const op = await f.takeover()
    await expect
      .poll(async () => (await f.status(op.id)).handoffState, {
        timeout: 15000,
      })
      .toBe('failed')
    await expect
      .poll(
        async () =>
          state.parse(await f.a.rpc('state', { sessionId: f.sessionId }))
            .controlled,
      )
      .toBe(false)
    expect(
      state.parse(await f.a.rpc('state', { sessionId: f.sessionId })),
    ).toMatchObject({ live: true, running: true })
    expect(JSON.stringify(await f.events())).not.toContain(
      'contextmesh-handoff:',
    )
    await f.a.rpc('finish-running', { sessionId: f.sessionId })
  } finally {
    await f.close()
  }
}, 30000)
it('does not resume a task that finishes naturally while B preflights', async () => {
  const f = await setup()
  let unblock = () => {}
  try {
    let reached!: () => void
    const arrived = new Promise<void>((r) => {
        reached = r
      }),
      barrier = new Promise<void>((r) => {
        unblock = r
      })
    const preflight = f.store.preflightHandoff.bind(f.store)
    vi.spyOn(f.store, 'preflightHandoff').mockImplementationOnce(
      async (...args) => {
        reached()
        await barrier
        return preflight(...args)
      },
    )
    const op = await f.takeover()
    await arrived
    expect(
      state.parse(await f.a.rpc('state', { sessionId: f.sessionId })).running,
    ).toBe(true)
    await f.a.rpc('finish-running', { sessionId: f.sessionId })
    await expect
      .poll(
        async () =>
          state.parse(await f.a.rpc('state', { sessionId: f.sessionId }))
            .running,
      )
      .toBe(false)
    unblock()
    await expect
      .poll(async () => (await f.status(op.id)).handoffState, {
        timeout: 15000,
      })
      .toBe('completed')
    expect(
      state.parse(await f.b.rpc('state', { sessionId: f.sessionId }))
        .modelRequests,
    ).toHaveLength(0)
    expect(JSON.stringify(await f.events())).not.toContain(
      'contextmesh-continuation',
    )
  } finally {
    unblock()
    await f.close()
  }
}, 30000)

it.each([false, true])(
  'waits for an in-flight tool result without cancelling its body; timeout=%s',
  async (timeout) => {
    const f = await setup(false, true)
    try {
      await expect
        .poll(
          async () =>
            z
              .object({ toolHeld: z.boolean() })
              .parse(await f.a.rpc('state', { sessionId: f.sessionId }))
              .toolHeld,
        )
        .toBe(true)
      const before = await f.events(),
        op = await f.takeover()
      await expect
        .poll(async () => (await f.status(op.id)).handoffState, {
          timeout: 10000,
        })
        .toBe('preparing')
      expect(
        z
          .object({ toolHeld: z.boolean(), toolAborted: z.boolean() })
          .parse(await f.a.rpc('state', { sessionId: f.sessionId })),
      ).toEqual({ toolHeld: true, toolAborted: false })
      if (timeout) {
        await expect
          .poll(async () => (await f.status(op.id)).handoffState, {
            timeout: 10000,
          })
          .toBe('failed')
        expect(
          state.parse(await f.a.rpc('state', { sessionId: f.sessionId })),
        ).toMatchObject({ live: true, running: true })
      }
      await f.a.rpc('finish-tool', { sessionId: f.sessionId })
      if (timeout) {
        await expect
          .poll(
            async () =>
              z
                .object({ holding: z.boolean() })
                .parse(await f.a.rpc('state', { sessionId: f.sessionId }))
                .holding,
          )
          .toBe(true)
        await f.a.rpc('finish-running', { sessionId: f.sessionId })
      } else {
        await expect
          .poll(async () => (await f.status(op.id)).handoffState, {
            timeout: 15000,
          })
          .toBe('completed')
        await expect
          .poll(
            async () =>
              state.parse(await f.b.rpc('state', { sessionId: f.sessionId }))
                .modelRequests.length,
          )
          .toBe(1)
        const final = await f.events()
        expect(final.filter((e) => e.type === 'tool/result')).toHaveLength(
          before.filter((e) => e.type === 'tool/result').length + 1,
        )
      }
      expect(
        z
          .object({ toolAborted: z.boolean() })
          .parse(await f.a.rpc('state', { sessionId: f.sessionId }))
          .toolAborted,
      ).toBe(false)
    } finally {
      await f.close()
    }
  },
  40000,
)

it('rechecks workspace after a running tool settles and leaves A running if files changed', async () => {
  const f = await setup(false, true)
  try {
    await expect
      .poll(
        async () =>
          z
            .object({ toolHeld: z.boolean() })
            .parse(await f.a.rpc('state', { sessionId: f.sessionId })).toolHeld,
      )
      .toBe(true)
    const op = await f.takeover()
    await expect
      .poll(async () => (await f.status(op.id)).handoffState, {
        timeout: 10000,
      })
      .toBe('preparing')
    await writeFile(
      join(f.source, 'handoff-sentinel.txt'),
      'changed during tool execution',
    )
    await f.a.rpc('finish-tool', { sessionId: f.sessionId })
    await expect
      .poll(async () => (await f.status(op.id)).handoffState, {
        timeout: 10000,
      })
      .toBe('failed')
    expect(
      state.parse(await f.a.rpc('state', { sessionId: f.sessionId })),
    ).toMatchObject({ live: true, running: true })
    expect(JSON.stringify(await f.events())).not.toContain(
      'contextmesh-handoff:',
    )
    await f.a.rpc('finish-running', { sessionId: f.sessionId })
  } finally {
    await f.close()
  }
}, 30000)
