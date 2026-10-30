import { it, expect, vi } from 'vitest'
import { confirmFileAction } from '../../packages/handoff-deepseek/src/client/files.js'
it('requires explicit confirmation for export, apply and rollback and preserves state when cancelled', async () => {
  const request = vi.fn(async () => ({ ok: true }))
  for (const action of [
    'workspace-export',
    'workspace-apply',
    'workspace-rollback',
  ] as const) {
    expect(
      await confirmFileAction(
        request,
        async () => false,
        action,
        'id',
        'review',
      ),
    ).toBe(false)
    expect(request).not.toHaveBeenCalled()
  }
  await confirmFileAction(
    request,
    async () => true,
    'workspace-export',
    'plan',
    'review',
  )
  expect(request).toHaveBeenLastCalledWith({
    action: 'workspace-export',
    planId: 'plan',
    confirmed: true,
  })
  await confirmFileAction(
    request,
    async () => true,
    'workspace-apply',
    'transfer',
    'review',
    'preview',
  )
  expect(request).toHaveBeenLastCalledWith({
    action: 'workspace-apply',
    transferId: 'transfer',
    previewId: 'preview',
    confirmed: true,
  })
})
