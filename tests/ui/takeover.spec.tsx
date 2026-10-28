import { afterEach, expect, it, vi } from 'vitest'
import { UiModel } from '../../packages/handoff-deepseek/src/client/state.js'
import {
  en,
  type Key,
} from '../../packages/handoff-deepseek/src/client/locales.js'
const t = (key: Key) => en[key]
const snapshot = (owner = 'B') => ({
  nodeId: 'A',
  name: 'Laptop',
  nodes: [
    { id: 'A', name: 'Laptop', online: true },
    { id: 'B', name: 'Server', online: true },
  ],
  projects: [{ id: 'project', name: 'Shared project' }],
  mappings: [{ projectId: 'project', root: '/target' }],
  sessions: [
    {
      id: 'session',
      incarnation: 'incarnation',
      title: 'Example',
      projectId: 'project',
      activeNodeId: owner,
      activeNodeName: owner === 'A' ? 'Laptop' : 'Server',
      handoffId: null,
      handoffState: null,
      recoveryRequired: false,
    },
  ],
  handoffs: [],
  errors: {},
})
afterEach(() => {
  vi.unstubAllGlobals()
})
function server(mode: 'success' | 'failed' | 'local' = 'success') {
  const actions: string[] = []
  let statuses = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, options: RequestInit) => {
      const command = JSON.parse(String(options.body))
      actions.push(command.action)
      let value: unknown
      if (command.action === 'status')
        value = snapshot(mode === 'local' || statuses++ > 0 ? 'A' : 'B')
      else if (command.action === 'takeover') value = { id: 'intent' }
      else
        value =
          mode === 'failed'
            ? {
                state: 'failed',
                errorCode: 'NODE_UNAVAILABLE',
                error: 'source disconnected',
              }
            : {
                state: 'linked',
                errorCode: null,
                error: null,
                handoffState: 'completed',
                handoffError: null,
              }
      return Response.json({ ok: true, value })
    }),
  )
  return actions
}
it('asks before takeover and cancels without creating a takeover request', async () => {
  const actions = server(),
    confirm = vi.fn((_message: string) => false),
    model = new UiModel(confirm)
  expect(await model.ensureOwned('session', t)).toBe(false)
  expect(confirm).toHaveBeenCalledOnce()
  expect(confirm.mock.calls[0]?.[0]).toContain('Server')
  expect(actions).toEqual(['status'])
  model.close()
})
it('waits for ownership before allowing the original message and deduplicates confirmation', async () => {
  const actions = server(),
    confirm = vi.fn(() => true),
    model = new UiModel(confirm)
  const first = model.ensureOwned('session', t),
    second = model.ensureOwned('session', t)
  expect(second).toBe(first)
  expect(await first).toBe(true)
  expect(confirm).toHaveBeenCalledOnce()
  expect(actions).toEqual(['status', 'takeover', 'takeover-status', 'status'])
  expect(model.getSnapshot().data?.sessions[0]?.activeNodeId).toBe('A')
  model.close()
})
it('returns failures before message admission and leaves ordinary local messages alone', async () => {
  const actions = server('failed'),
    model = new UiModel(() => true)
  await expect(model.ensureOwned('session', t)).rejects.toMatchObject({
    code: 'NODE_UNAVAILABLE',
    message: en.NODE_UNAVAILABLE,
  })
  expect(actions).toEqual(['status', 'takeover', 'takeover-status'])
  model.close()
  const local = server('local'),
    confirm = vi.fn(() => true),
    localModel = new UiModel(confirm)
  expect(await localModel.ensureOwned('session', t)).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
  expect(local).toEqual(['status'])
  localModel.close()
})
