import { z } from 'zod'
import { validatePortable, type PortableContext } from './portable.js'
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
    if (item.type === 'userMessage') {
      const content = z
        .array(
          z.object({ type: z.literal('text'), text: z.string() }).passthrough(),
        )
        .parse(item.content)
      messages.push({
        role: 'user',
        text: content.map((c) => c.text).join('\n'),
      })
    } else if (item.type === 'agentMessage')
      messages.push({ role: 'assistant', text: z.string().parse(item.text) })
    else if (item.type === 'reasoning') continue
    else {
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
      messages.push({
        role: 'reference',
        text: `[Native ${item.type}; historical reference only]\n${JSON.stringify(item)}`,
      })
    }
  }
  return validatePortable({ ...base, messages })
}
