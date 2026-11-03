import { test, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { environment } from '../helpers/handoff-environment.js'
test('native upgrade preflight fences idle sessions and refuses running tasks without cancelling them', async () => {
  const f = await environment()
  try {
    const a = await f.launch('Upgrade', f.source),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember UPGRADE-PRESERVE-4817.',
    })
    const before = await f.client.stat(sessionId)
    await expect(
      a.rpc('m1', { command: { action: 'prepare-upgrade' } }),
    ).resolves.toEqual({ ready: true })
    await expect(a.rpc('create', { sessionId: randomUUID() })).rejects.toThrow()
    await a.rpc('m1', { command: { action: 'cancel-upgrade' } })
    await a.rpc('start-running', {
      sessionId,
      text: 'Keep working on the original fixture task.',
    })
    await expect(
      a.rpc('m1', { command: { action: 'prepare-upgrade' } }),
    ).rejects.toThrow(/Finish|busy|running/)
    const state = (await a.rpc('state', { sessionId })) as { running: boolean }
    expect(state.running).toBe(true)
    expect((await f.client.stat(sessionId))?.incarnation).toBe(
      before?.incarnation,
    )
  } finally {
    await f.close()
  }
}, 40000)

test('concurrent upgrade requests both wait for the acknowledged flush', async () => {
  const f = await environment()
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  try {
    const a = await f.launch('ConcurrentUpgrade', f.source),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Preserve this before upgrading.',
    })
    const original = f.store.flush.bind(f.store)
    let entered = false
    vi.spyOn(f.store, 'flush').mockImplementation(async (...args) => {
      entered = true
      await blocked
      return original(...args)
    })
    const first = a.rpc('m1', { command: { action: 'prepare-upgrade' } })
    await expect.poll(() => entered).toBe(true)
    let secondFinished = false
    const second = a
      .rpc('m1', { command: { action: 'prepare-upgrade' } })
      .then((result) => {
        secondFinished = true
        return result
      })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(secondFinished).toBe(false)
    release()
    await expect(first).resolves.toEqual({ ready: true })
    await expect(second).resolves.toEqual({ ready: true })
    await a.rpc('m1', { command: { action: 'cancel-upgrade' } })
    await a.rpc('prompt', {
      sessionId,
      text: 'Continue after cancelling the upgrade.',
    })
  } finally {
    release()
    await f.close()
  }
}, 40000)

test('a completed handoff can be upgraded and cancelled without losing the receiving agent', async () => {
  const f = await environment()
  try {
    const a = await f.launch('BeforeUpgrade', f.source),
      b = await f.launch('AfterUpgrade', f.target)
    const projectId = randomUUID(),
      sessionId = randomUUID()
    await a.rpc('m1', {
      command: { action: 'project', projectId, name: 'upgrade fixture' },
    })
    await a.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.source },
    })
    await b.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.target },
    })
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', { sessionId, text: 'Keep HANDOFF-UPGRADE-4817.' })
    const transfer = (await a.rpc('m1', {
      command: { action: 'handoff', sessionId, targetNodeId: b.nodeId },
    })) as { id: string }
    await expect
      .poll(
        async () =>
          (
            (await f.client.request('/v1/handoffs/' + transfer.id)) as {
              state: string
            }
          ).state,
        { timeout: 15000 },
      )
      .toBe('completed')
    await expect
      .poll(
        async () => {
          try {
            return await b.rpc('m1', { command: { action: 'prepare-upgrade' } })
          } catch (error) {
            return String(error)
          }
        },
        { timeout: 5000 },
      )
      .toEqual({ ready: true })
    await b.rpc('m1', { command: { action: 'cancel-upgrade' } })
    await b.rpc('prompt', {
      sessionId,
      text: 'Continue after cancelling the upgrade.',
    })
    expect(
      ((await b.rpc('state', { sessionId })) as { live: boolean }).live,
    ).toBe(true)
  } finally {
    await f.close()
  }
}, 40000)
