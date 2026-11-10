import { z } from 'zod'
import { integer, nativeId } from './index.js'

export const sharedFeature = 'live-session-sync-v1'
export const sharedSource = z.object({
  adapter: z.enum(['deepseek', 'codex']),
  id: nativeId,
  incarnation: z.uuid(),
})
export const sharedInfo = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(160),
  scope: z.enum(['full', 'text']),
  source: sharedSource,
  generation: integer,
  nextSeq: integer,
  activity: z.enum(['unknown', 'busy', 'idle', 'reserved']),
  reservation: z.uuid().nullable(),
})
export type SharedInfo = z.infer<typeof sharedInfo>
export const sharedContent = z.object({
  bytes: integer,
  blocks: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(65536),
})
export const sharedItem = z.object({
  key: z.string().min(1).max(512),
  turn: z.string().max(256),
  role: z.enum(['user', 'assistant', 'reference']),
  kind: z.string().min(1).max(80),
  status: z.string().max(48).optional(),
  preview: z.string().max(240),
})
export type SharedItem = z.infer<typeof sharedItem>
export const sharedUpdate = sharedItem.extend({ content: sharedContent })
export const sharedEvent = sharedItem.extend({ seq: integer, bytes: integer })
export type SharedEvent = z.infer<typeof sharedEvent>
export const sharedPage = z.object({
  share: sharedInfo,
  events: z.array(sharedEvent).max(200),
  next: integer,
  more: z.boolean(),
})
export const sharedCreate = z
  .object({
    id: z.uuid(),
    title: sharedInfo.shape.title,
    scope: sharedInfo.shape.scope,
    source: sharedSource,
    writerToken: z.string().min(32).max(128),
  })
  .strict()
export const sharedWrite = z.object({
  generation: integer,
  writerToken: z.string().min(32).max(128),
})
export const sharedAppend = sharedWrite
  .extend({
    eventId: z.string().min(1).max(160),
    item: sharedUpdate,
  })
  .strict()
export const sharedActivity = sharedWrite
  .extend({
    turn: z.string().min(1).max(256),
    state: z.enum(['busy', 'idle']),
    tool: z.string().min(1).max(256).optional(),
  })
  .strict()

/** Preserve only visible text. Native instructions and replay state stay native. */
export function visibleText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) =>
      part &&
      typeof part === 'object' &&
      ['text', 'input_text', 'output_text'].includes(part.type) &&
      typeof part.text === 'string'
        ? [part.text]
        : [],
    )
    .join('\n')
}

export function sharedDshItem(
  event: any,
  scope: 'full' | 'text',
): (Omit<SharedItem, 'preview'> & { text: string }) | undefined {
  const data = event.data ?? {}
  const turn = String(data.turn ?? 'event:' + event.seq)
  if (
    event.type === 'user/message' &&
    ['runtime-context', 'time-context'].includes(data.source?.kind)
  )
    return
  if (event.type === 'assistant/message' && !visibleText(data.message?.content))
    return
  if (event.type === 'user/message')
    return {
      key: 'message:' + (data.id ?? event.seq),
      turn,
      role: 'user',
      kind: 'message',
      text: visibleText(data.content),
    }
  if (event.type === 'assistant/message')
    return {
      key: 'message:' + (data.message?.id ?? event.seq),
      turn,
      role: 'assistant',
      kind: 'message',
      text: visibleText(data.message?.content),
    }
  if (scope === 'full' && event.type === 'tool/call')
    return {
      key: 'tool:' + data.callId,
      turn,
      role: 'reference',
      kind: 'tool',
      status: 'running',
      text: String(data.name ?? 'Tool') + '\n' + String(data.arguments ?? ''),
    }
  if (scope === 'full' && event.type === 'tool/result')
    return {
      key: 'tool:' + data.message?.toolCallId,
      turn,
      role: 'reference',
      kind: 'tool',
      status: data.message?.isError ? 'failed' : 'completed',
      text: visibleText(data.message?.content),
    }
}
