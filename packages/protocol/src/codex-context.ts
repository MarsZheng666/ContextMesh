import { z } from 'zod'
import {
  portableContext,
  validatePortable,
  type PortableContext,
} from './portable.js'
export const codexGuiArchive = z
  .object({
    operationId: z.uuid(),
    nativeThreadId: z.uuid(),
    cliVersion: z.string().min(1).max(128),
    title: z.string().min(1).max(160).optional(),
    context: portableContext,
  })
  .strict()

export const nativeSnapshot = z.object({
  thread: z
    .object({
      id: z.string().min(1),
      cwd: z.string(),
      cliVersion: z.string(),
      status: z
        .object({
          type: z.enum(['idle', 'active', 'notLoaded', 'systemError']),
        })
        .passthrough(),
    })
    .passthrough(),
  turns: z.array(
    z
      .object({
        id: z.string(),
        status: z.enum(['completed', 'failed', 'interrupted', 'inProgress']),
      })
      .passthrough(),
  ),
  items: z.array(
    z
      .object({
        turnId: z.string(),
        item: z.object({ type: z.string() }).passthrough(),
      })
      .passthrough(),
  ),
})
export type NativeSnapshot = z.infer<typeof nativeSnapshot>
export const codexArchiveScope = z.enum(['full', 'text'])
export type CodexArchiveScope = z.infer<typeof codexArchiveScope>
type NativeItem = NativeSnapshot['items'][number]['item']
type PortableMessage = PortableContext['messages'][number]

export function assertCodexItemSettled(item: NativeItem) {
  if (
    'status' in item &&
    !['completed', 'failed', 'declined'].includes(String(item.status))
  )
    throw new Error('Native tool work is not settled')
  if (
    item.type === 'commandExecution' &&
    item.processId != null &&
    item.exitCode == null
  )
    throw new Error('Native background commands are not settled')
}

export function projectCodexMessage(
  item: NativeItem,
  scope: CodexArchiveScope,
): PortableMessage | undefined {
  if (item.type === 'userMessage') {
    const content = z
      .array(z.object({ type: z.string() }).passthrough())
      .parse(item.content)
    const parts = content.filter((part) => part.type === 'text')
    if (scope === 'full' && parts.length !== content.length)
      throw new Error('Native snapshot contains unsupported attachments')
    if (scope === 'text' && !parts.length) return
    return {
      role: 'user',
      text: parts.map((part) => z.string().parse(part.text)).join('\n'),
    }
  }
  if (item.type === 'agentMessage')
    return { role: 'assistant', text: z.string().parse(item.text) }
  if (scope === 'text' || item.type === 'reasoning') return
  assertCodexItemSettled(item)
  if (
    ![
      'commandExecution',
      'fileChange',
      'functionCallOutput',
      'mcpToolCall',
      'dynamicToolCall',
      'plan',
    ].includes(item.type)
  )
    throw new Error('Native snapshot contains unsupported content')
  return {
    role: 'reference',
    text: `[Native ${item.type}; historical reference only]\n${JSON.stringify(item)}`,
  }
}

export function extendCodexContext(
  base: PortableContext,
  native: NativeSnapshot,
): PortableContext {
  if (
    native.thread.status.type !== 'idle' ||
    native.turns.some((t) => t.status === 'inProgress')
  )
    throw new Error('Wait for native Codex work to settle before importing')
  const messages = [...validatePortable(base).messages]
  for (const { item } of native.items) {
    const message = projectCodexMessage(item, 'full')
    if (message) messages.push(message)
  }
  return validatePortable({ ...base, messages })
}
