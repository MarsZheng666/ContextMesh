import { Context } from '@deepseek-ai/cordis'
import type {} from '../../packages/handoff-deepseek/src/client/index.js'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
async function method() {
  const source = await readFile(
    'node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js',
    'utf8',
  )
  const start = source.indexOf(
    'async sendSession(session, text, attachmentIds, mode, signal) {',
  )
  if (start < 0) throw new Error('pinned composer method missing')
  const end = source.indexOf('\n\t\t\t/**', start)
  return runInNewContext('({' + source.slice(start, end) + '})', {
    nextPaint: async () => {},
  }).sendSession as (
    this: unknown,
    session: unknown,
    text: string,
    attachments: unknown[],
    mode: string,
    signal?: AbortSignal,
  ) => Promise<{ kind: string }>
}
it('does not create an echo or send a prompt when takeover confirmation is cancelled', async () => {
  const send = await method(),
    begin = vi.fn(),
    prompt = vi.fn(),
    resolve = vi.fn()
  const ctx = new Context()
  ctx.on('conversation/before-send', async () => true as const)
  const owner = {
    ctx,
    resolveDraftAttachments: resolve,
  }
  expect(
    await send.call(
      owner,
      { sessionId: 'session', beginSubmission: begin, prompt },
      'keep my draft',
      [],
      'queue',
    ),
  ).toMatchObject({ kind: 'error' })
  expect(begin).not.toHaveBeenCalled()
  expect(prompt).not.toHaveBeenCalled()
  expect(resolve).not.toHaveBeenCalled()
})
it('waits for the guard and sends one original prompt after ownership arrives', async () => {
  const send = await method()
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
      release = resolve
    }),
    prompt = vi.fn(async (_content: unknown) => ({ ok: true })),
    begin = vi.fn(() => ({ requestId: 'request', abandon: () => {} }))
  const owner = {
    ctx: {
      serial: async () => {
        await ready
      },
    },
    resolveDraftAttachments: () => [],
    fileUploads: { getSnapshot: () => ({}) },
  }
  const result = send.call(
    owner,
    { sessionId: 'session', beginSubmission: begin, prompt },
    'original text',
    [],
    'queue',
  )
  expect(begin).not.toHaveBeenCalled()
  expect(prompt).not.toHaveBeenCalled()
  release()
  expect(await result).toMatchObject({ kind: 'success' })
  expect(prompt).toHaveBeenCalledOnce()
  expect(prompt.mock.calls[0]?.[0]).toEqual([
    { type: 'text', text: 'original text' },
  ])
})
