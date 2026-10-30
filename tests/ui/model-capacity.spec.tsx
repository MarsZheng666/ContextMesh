import { it, expect, vi, afterEach } from 'vitest'
import { UiModel } from '../../packages/handoff-deepseek/src/client/state.js'
import {
  en,
  type Key,
} from '../../packages/handoff-deepseek/src/client/locales.js'
const target = { provider: 'same', model: 'target' },
  previous = { provider: 'same', model: 'source' },
  t = (k: Key) => en[k]
const status = {
  nodeId: 'A',
  name: 'Laptop',
  modelPreflight: true,
  nodes: [],
  projects: [],
  mappings: [],
  sessions: [
    {
      id: 'S',
      incarnation: 'I',
      title: 'Task',
      projectId: null,
      activeNodeId: 'A',
      activeNodeName: 'Laptop',
      handoffId: null,
      handoffState: null,
      recoveryRequired: false,
    },
  ],
  handoffs: [],
  errors: {},
}
const report = {
  route: target,
  historyCut: 12,
  capacity: {
    method: 'estimate',
    exact: false,
    estimatedTokens: 1000,
    byteUpperBound: 6000,
    contextWindow: 4000,
    outputReserve: 1000,
    headroom: 1024,
    conservativeFits: false,
    estimatedFits: true,
  },
  capabilities: {
    textInput: true,
    tools: 'adapter-defined',
    maxOutputTokens: null,
  },
}
afterEach(() => vi.unstubAllGlobals())
for (const approve of [false, true])
  it(`${approve ? 'binds' : 'cancels'} estimated capacity before native selection`, async () => {
    const actions: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
      const action = JSON.parse(String(init.body))
      actions.push(action)
      return Response.json({
        ok: true,
        value:
          action.action === 'status'
            ? status
            : action.action === 'model-check'
              ? report
              : { approved: true },
      })
    })
    const model = new UiModel(() => approve)
    try {
      expect(await model.beforeModelSelect('S', previous, target, t)).toBe(
        approve ? undefined : true,
      )
      const consent = actions.find((a) => a.action === 'approve-model-capacity')
      if (approve)
        expect(consent).toMatchObject({
          historyCut: 12,
          ...target,
          sessionId: 'S',
          confirmed: true,
        })
      else expect(consent).toBeUndefined()
    } finally {
      model.close()
    }
  })
it('blocks an estimate that cannot fit without asking for approval', async () => {
  const confirm = vi.fn(() => true)
  vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) =>
    Response.json({
      ok: true,
      value:
        JSON.parse(String(init.body)).action === 'status'
          ? status
          : {
              ...report,
              capacity: { ...report.capacity, estimatedFits: false },
            },
    }),
  )
  const model = new UiModel(confirm)
  try {
    expect(await model.beforeModelSelect('S', previous, target, t)).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(model.getSnapshot().error).toMatchObject({
      code: 'MODEL_CONTEXT_TOO_SMALL',
    })
  } finally {
    model.close()
  }
})
