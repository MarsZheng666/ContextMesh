import { it, expect, vi, afterEach } from 'vitest'
import { UiModel } from '../../packages/handoff-deepseek/src/client/state.js'
const snapshot = {
  nodeId: 'A',
  name: 'Laptop',
  nodes: [],
  projects: [],
  mappings: [],
  sessions: [],
  handoffs: [],
  errors: {},
}
afterEach(() => vi.unstubAllGlobals())
it('keeps the previous list when offline and revalidates status before permitting a send', async () => {
  let online = true
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      if (!online) throw new TypeError('network')
      return Response.json({ ok: true, value: snapshot })
    }),
  )
  const model = new UiModel(() => true)
  try {
    await model.refresh()
    expect(model.getSnapshot().data?.name).toBe('Laptop')
    online = false
    await model.refresh()
    expect(model.getSnapshot().data?.name).toBe('Laptop')
    expect(model.getSnapshot().error).toMatchObject({ code: 'CONNECTION_LOST' })
    await expect(model.waitForModelSelect('session')).rejects.toMatchObject({
      code: 'CONNECTION_LOST',
    })
    online = true
    await model.refresh()
    expect(model.getSnapshot().error).toBeUndefined()
    await expect(model.waitForModelSelect('session')).resolves.toBeUndefined()
  } finally {
    model.close()
  }
})
