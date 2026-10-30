import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
import { MeshError } from '../../packages/protocol/src/index.js'

const target = { provider: 'contextmesh-second', model: 'relay' }
const read = async (f: Awaited<ReturnType<typeof environment>>, id: string) => {
  const handle = await f.client.open(id, 'read')
  try {
    return {
      header: handle.session.header,
      events: (await f.client.read(handle, 0, Number.MAX_SAFE_INTEGER)).events,
    }
  } finally {
    await f.client.close(handle, randomUUID())
  }
}
const workerState = z.object({
  defaultModel: z.unknown().optional(),
  controlled: z.boolean(),
  modelRequests: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      messages: z.array(z.unknown()),
    }),
  ),
})
it('relays native history to another adapter without changing global defaults, replays no completed tools, and retains the route after restart', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, true),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'READ_WORKSPACE and remember CONTINUITY-PHRASE-4817.',
    })
    const original = await read(f, sessionId),
      before = workerState.parse(await a.rpc('state', { sessionId }))
    await a.rpc('select-model', { sessionId, selection: target })
    const selected = await read(f, sessionId),
      after = workerState.parse(await a.rpc('state', { sessionId }))
    expect(after.modelRequests.length).toBe(before.modelRequests.length)
    expect(after.defaultModel).toEqual(before.defaultModel)
    expect(selected.header).toEqual(original.header)
    expect(selected.events.slice(0, original.events.length)).toEqual(
      original.events,
    )
    const rows = (
      await f.store.pool.query(
        'SELECT id FROM cm_model_relays WHERE namespace=$1 AND session_id=$2 AND state=$3',
        [f.namespace, sessionId, 'completed'],
      )
    ).rows
    const operationId = rows.at(-1)!.id
    await a.rpc('m1', {
      command: { action: 'select-model', sessionId, ...target, operationId },
    })
    expect((await read(f, sessionId)).events).toEqual(selected.events)
    await a.rpc('prompt', {
      sessionId,
      text: 'Recall the original marker. Do not run tools again.',
    })
    const requests = workerState.parse(
      await a.rpc('state', { sessionId }),
    ).modelRequests
    const next = requests.at(-1)!
    expect(next).toMatchObject(target)
    expect(JSON.stringify(next.messages)).toContain('CONTINUITY-PHRASE-4817')
    expect(JSON.stringify(next.messages)).toContain('fixture-sentinel')
    expect(JSON.stringify(next.messages)).not.toContain('fixturePrivateState')
    const final = await read(f, sessionId)
    expect(final.events.filter((e) => e.type === 'tool/result')).toHaveLength(
      original.events.filter((e) => e.type === 'tool/result').length,
    )
    expect(final.events.slice(0, original.events.length)).toEqual(
      original.events,
    )
    await a.stop()
    const restarted = await f.launch('A', f.source, true)
    await restarted.rpc('native-resume', { sessionId })
    await restarted.rpc('prompt', {
      sessionId,
      text: 'Recall CONTINUITY-PHRASE-4817 after restart.',
    })
    expect(
      workerState
        .parse(await restarted.rpc('state', { sessionId }))
        .modelRequests.at(-1),
    ).toMatchObject(target)
  } finally {
    await f.close()
  }
}, 60000)

it('rejects missing, unknown, non-text and too-small targets before changing the selected model', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember CONTINUITY-PHRASE-4817.',
    })
    const original = await read(f, sessionId)
    for (const selection of [
      { provider: 'missing-provider', model: 'none' },
      { ...target, reasoningEffort: 'impossible' },
      ...['tiny', 'unknown', 'no-text'].map((model) => ({
        provider: 'contextmesh-second',
        model,
      })),
    ]) {
      await expect(
        a.rpc('select-model', { sessionId, selection }),
      ).rejects.toThrow()
      expect((await read(f, sessionId)).events).toEqual(original.events)
      expect(
        workerState.parse(await a.rpc('state', { sessionId })).controlled,
      ).toBe(false)
    }
    await a.rpc('prompt', {
      sessionId,
      text: 'Continue using the original model.',
    })
    expect(
      workerState
        .parse(await a.rpc('state', { sessionId }))
        .modelRequests.at(-1)?.provider,
    ).toBe('contextmesh-e2e')
  } finally {
    await f.close()
  }
}, 30000)

it('waits for current work while freezing new input, then switches before the next request', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('start-running', { sessionId })
    const selection = a.rpc('select-model', { sessionId, selection: target })
    await expect
      .poll(
        async () =>
          workerState.parse(await a.rpc('state', { sessionId })).controlled,
      )
      .toBe(true)
    await expect(
      a.rpc('prompt', { sessionId, text: 'must remain a client draft' }),
    ).rejects.toThrow('SESSION_FROZEN')
    await expect
      .poll(
        async () =>
          z
            .object({ holding: z.boolean() })
            .parse(await a.rpc('state', { sessionId })).holding,
      )
      .toBe(true)
    await a.rpc('finish-running', { sessionId })
    await selection
    await a.rpc('prompt', { sessionId, text: 'Now continue.' })
    expect(
      workerState
        .parse(await a.rpc('state', { sessionId }))
        .modelRequests.at(-1),
    ).toMatchObject(target)
    expect(JSON.stringify((await read(f, sessionId)).events)).not.toContain(
      'must remain a client draft',
    )
  } finally {
    await f.close()
  }
}, 30000)

it('hands off the conversation current selection without requiring its obsolete original provider on the target', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, true),
      b = await f.launch('B', f.target, true, false, undefined, true)
    const sessionId = randomUUID(),
      projectId = randomUUID()
    await a.rpc('m1', {
      command: { action: 'project', projectId, name: 'model relay' },
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
    await a.rpc('select-model', { sessionId, selection: target })
    const original = await read(f, sessionId)
    await expect
      .poll(
        async () =>
          z
            .array(
              z.object({ id: z.string(), projectId: z.string().nullable() }),
            )
            .parse(await f.client.request('/v1/remote-sessions'))
            .find((s) => s.id === sessionId)?.projectId,
      )
      .toBe(projectId)
    const intent = z.object({ id: z.string() }).parse(
      await b.rpc('m1', {
        command: {
          action: 'takeover',
          sessionId,
          confirmed: true,
        },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({
              handoffState: z.string().optional(),
              error: z.string().nullable(),
            })
            .parse(
              await b.rpc('m1', {
                command: { action: 'takeover-status', takeoverId: intent.id },
              }),
            ).handoffState,
        { timeout: 15000 },
      )
      .toBe('completed')
    expect(
      z.object({ live: z.boolean() }).parse(await a.rpc('state', { sessionId }))
        .live,
    ).toBe(false)
    await b.rpc('prompt', {
      sessionId,
      text: 'READ_WORKSPACE and recall the original marker.',
    })
    const requests = workerState.parse(
      await b.rpc('state', { sessionId }),
    ).modelRequests
    expect(requests[0]).toMatchObject(target)
    expect(JSON.stringify(requests[0]?.messages)).toContain(
      'CONTINUITY-PHRASE-4817',
    )
    const final = await read(f, sessionId)
    expect(final.events.slice(0, original.events.length)).toEqual(
      original.events,
    )
    expect(
      final.events.some(
        (e) =>
          e.type === 'model/selection' &&
          z.object({ provider: z.string() }).parse(e.data).provider ===
            target.provider,
      ),
    ).toBe(true)
    expect((await f.client.stat(sessionId))?.header).toEqual(original.header)
    expect(final.events.filter((e) => e.type === 'model/selection')).toEqual(
      original.events.filter((e) => e.type === 'model/selection'),
    )
  } finally {
    await f.close()
  }
}, 40000)

it('keeps the source available when the receiving device has no current model configured', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      b = await f.launch('B', f.target, false, false, undefined, true),
      projectId = randomUUID(),
      sessionId = randomUUID()
    await a.rpc('m1', {
      command: { action: 'project', projectId, name: 'same model' },
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
    await expect(
      a.rpc('m1', {
        command: {
          action: 'handoff',
          sessionId,
          targetNodeId: b.nodeId,
          targetModel: target,
        },
      }),
    ).rejects.toThrow('current')
    await expect(
      b.rpc('m1', {
        command: {
          action: 'takeover',
          sessionId,
          confirmed: true,
          targetModel: target,
        },
      }),
    ).rejects.toThrow('current')
    const operation = z.object({ id: z.string() }).parse(
      await a.rpc('m1', {
        command: { action: 'handoff', sessionId, targetNodeId: b.nodeId },
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request('/v1/handoffs/' + operation.id))
            .state,
        { timeout: 10000 },
      )
      .toBe('failed')
    await expect
      .poll(
        async () =>
          workerState.parse(await a.rpc('state', { sessionId })).controlled,
        { timeout: 10000 },
      )
      .toBe(false)
    expect(
      z.object({ live: z.boolean() }).parse(await a.rpc('state', { sessionId }))
        .live,
    ).toBe(true)
    expect(
      z.object({ live: z.boolean() }).parse(await b.rpc('state', { sessionId }))
        .live,
    ).toBe(false)
    const before = await read(f, sessionId)
    expect(
      before.events.filter((e) => e.type === 'model/selection'),
    ).not.toContainEqual(
      expect.objectContaining({ data: expect.objectContaining(target) }),
    )
    await a.rpc('prompt', {
      sessionId,
      text: 'Continue with the original current model.',
    })
    expect(
      workerState
        .parse(await a.rpc('state', { sessionId }))
        .modelRequests.at(-1),
    ).toMatchObject({ provider: 'contextmesh-e2e', model: 'scripted' })
  } finally {
    await f.close()
  }
}, 30000)

it('reconciles lost prepare and completion responses without appending the selection twice', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    const prepare = f.store.prepareModelRelay.bind(f.store),
      finish = f.store.finishModelRelay.bind(f.store)
    vi.spyOn(f.store, 'prepareModelRelay').mockImplementationOnce(
      async (...args) => {
        await prepare(...args)
        throw new MeshError('UNAVAILABLE', 'lost prepare response', 503)
      },
    )
    vi.spyOn(f.store, 'finishModelRelay').mockImplementationOnce(
      async (...args) => {
        await finish(...args)
        throw new MeshError('UNAVAILABLE', 'lost completion response', 503)
      },
    )
    await a.rpc('select-model', { sessionId, selection: target })
    const events = (await read(f, sessionId)).events
    expect(
      events.filter(
        (e) =>
          e.type === 'model/selection' &&
          z.object({ provider: z.string() }).parse(e.data).provider ===
            target.provider,
      ),
    ).toHaveLength(1)
    expect(
      workerState.parse(await a.rpc('state', { sessionId })).controlled,
    ).toBe(false)
    expect(
      (
        await f.store.pool.query(
          'SELECT state FROM cm_model_relays WHERE namespace=$1 AND session_id=$2',
          [f.namespace, sessionId],
        )
      ).rows.every((r) => r.state === 'completed'),
    ).toBe(true)
  } finally {
    await f.close()
  }
}, 30000)
