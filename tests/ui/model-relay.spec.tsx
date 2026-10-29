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
it('combines remote model selection with confirmed takeover instead of a second native switch', async () => {
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
  expect(await model.beforeModelSelect('session', previous, target, t)).toBe(
    true,
  )
  expect(actions.find((a) => a.action === 'takeover')).toMatchObject({
    targetModel: target,
    confirmed: true,
  })
  expect(model.getSnapshot().data?.sessions[0]?.activeNodeId).toBe('A')
  model.close()
})
