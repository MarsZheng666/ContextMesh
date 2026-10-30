import { afterEach, expect, it, vi } from 'vitest'
import { UiModel } from '../../packages/handoff-deepseek/src/client/state.js'
import {
  en,
  type Key,
} from '../../packages/handoff-deepseek/src/client/locales.js'
const t = (key: Key) => en[key]
const previous = { provider: 'a', model: 'one' },
  target = { provider: 'b', model: 'two' }
const snapshot = (owner = 'A') => ({
  nodeId: 'A',
  name: 'Laptop',
  nodes: [],
  projects: [],
  mappings: [{ projectId: 'project', root: '/here' }],
  sessions: [
    {
      id: 'session',
      incarnation: 'incarnation',
      title: 'Conversation',
      projectId: 'project',
      activeNodeId: owner,
      activeNodeName: owner,
      handoffId: null,
      handoffState: null,
      recoveryRequired: false,
    },
  ],
  handoffs: [],
  errors: {},
})
afterEach(() => vi.unstubAllGlobals())
it('keeps a concurrently sent draft waiting until the native model change finishes after takeover', async () => {
  let release!: () => void,
    arrived!: () => void,
    owned = false
  const pending = new Promise<void>((resolve) => {
      release = resolve
    }),
    entered = new Promise<void>((resolve) => {
      arrived = resolve
    })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const command = JSON.parse(String(options.body))
      let value: unknown
      if (command.action === 'status') value = snapshot(owned ? 'A' : 'B')
      else if (command.action === 'takeover') value = { id: 'intent' }
      else {
        arrived()
        await pending
        owned = true
        value = {
          state: 'linked',
          errorCode: null,
          error: null,
          handoffState: 'completed',
          handoffError: null,
        }
      }
      return Response.json({ ok: true, value })
    }),
  )
  const model = new UiModel(() => true)
  try {
    const selection = model.beforeModelSelect('session', previous, target, t)
    await entered
    let admitted = false
    const sending = model.readyToSend('session', t).then((value) => {
      admitted = value
      return value
    })
    await Promise.resolve()
    release()
    expect(await selection).toBeUndefined()
    await Promise.resolve()
    expect(admitted).toBe(false)
    model.finishModelSelect('session')
    expect(await sending).toBe(true)
  } finally {
    model.close()
  }
})
it('cancels a provider change before any host mutation', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const model = new UiModel(() => false)
  expect(await model.beforeModelSelect('session', previous, target, t)).toBe(
    true,
  )
  expect(fetch).not.toHaveBeenCalled()
  model.close()
})
it('shows the receiving device current-model configuration error and sends no alternate model', async () => {
  const commands: Array<Record<string, unknown>> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const command = JSON.parse(String(options.body))
      commands.push(command)
      const value =
        command.action === 'status'
          ? snapshot('B')
          : command.action === 'takeover'
            ? { id: 'intent' }
            : {
                state: 'linked',
                errorCode: null,
                error: null,
                handoffState: 'failed',
                handoffError:
                  'Configure the current model current-provider/current-model on the receiving device.',
              }
      return Response.json({ ok: true, value })
    }),
  )
  const model = new UiModel(() => true)
  try {
    await expect(model.ensureOwned('session', t)).rejects.toThrow(
      'current-provider/current-model',
    )
    expect(commands.find((c) => c.action === 'takeover')).not.toHaveProperty(
      'targetModel',
    )
  } finally {
    model.close()
  }
})
it('waits for the native model response before admitting input and preserves cancellation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ ok: true, value: snapshot() })),
  )
  const model = new UiModel(() => true)
  expect(
    await model.beforeModelSelect('session', previous, target, t),
  ).toBeUndefined()
  let admitted = false
  const ready = model.waitForModelSelect('session').then(() => {
    admitted = true
  })
  await Promise.resolve()
  expect(admitted).toBe(false)
  model.finishModelSelect('session')
  await ready
  expect(admitted).toBe(true)
  expect(
    await model.beforeModelSelect('session', target, previous, t),
  ).toBeUndefined()
  const abort = new AbortController(),
    waiting = model.waitForModelSelect('session', abort.signal)
  abort.abort(new Error('draft kept'))
  await expect(waiting).rejects.toThrow('draft kept')
  model.close()
})
it('takes over with the current model before admitting a separately requested native model switch', async () => {
  const actions: Array<Record<string, unknown>> = []
  let acquired = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const command = JSON.parse(String(options.body))
      actions.push(command)
      let value: unknown
      if (command.action === 'status') value = snapshot(acquired ? 'A' : 'B')
      else if (command.action === 'takeover') value = { id: 'intent' }
      else {
        acquired = true
        value = {
          state: 'linked',
          errorCode: null,
          error: null,
          handoffState: 'completed',
          handoffError: null,
        }
      }
      return Response.json({ ok: true, value })
    }),
  )
  const confirm = vi.fn(() => true),
    model = new UiModel(confirm)
  expect(
    await model.beforeModelSelect('session', previous, target, t),
  ).toBeUndefined()
  expect(actions.find((a) => a.action === 'takeover')).toMatchObject({
    confirmed: true,
  })
  expect(actions.find((a) => a.action === 'takeover')).not.toHaveProperty(
    'targetModel',
  )
  expect(model.getSnapshot().data?.sessions[0]?.activeNodeId).toBe('A')
  model.finishModelSelect('session')
  model.close()
})
