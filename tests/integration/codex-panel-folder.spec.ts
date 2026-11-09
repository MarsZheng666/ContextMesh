import { expect, it, vi } from 'vitest'
import { panelFolderPicker } from '../../apps/cli/src/codex-panel-folder.js'

it('allows the panel to poll a native choice and preserves a path outside recent projects', async () => {
  const path = '/Volumes/测试 data/a folder '
  let finish!: (path: string | null) => void
  const selection = new Promise<string | null>((resolve) => {
    finish = resolve
  })
  const choose = vi.fn(() => selection)
  const picker = panelFolderPicker(choose)
  const opened = picker({
    action: 'open',
    initialDirectory: '/Users/test/projects',
  })
  const status = { action: 'status', id: opened.id }

  expect(choose).toHaveBeenCalledWith('/Users/test/projects', undefined)
  expect(picker(status)).toEqual({ id: opened.id, state: 'waiting' })
  expect(() => picker({ action: 'open' })).toThrow('already open')
  finish(path)
  await selection
  expect(picker(status)).toEqual({ id: opened.id, state: 'selected', path })
})

it('reports cancellation without supplying a new path and can reopen', async () => {
  const choose = vi.fn<() => Promise<string | null>>()
  choose.mockResolvedValueOnce(null).mockResolvedValueOnce('/tmp/next')
  const picker = panelFolderPicker(choose)
  const opened = picker({ action: 'open' })
  await Promise.resolve()
  expect(picker({ action: 'status', id: opened.id })).toEqual({
    id: opened.id,
    state: 'cancelled',
  })

  const next = picker({ action: 'open' })
  await Promise.resolve()
  expect(() => picker({ action: 'status', id: opened.id })).toThrow('expired')
  expect(picker({ action: 'status', id: next.id })).toMatchObject({
    state: 'selected',
    path: '/tmp/next',
  })
})
