import { z } from 'zod'
import type { ArchiveRecord } from '../../client/src/archive-record.js'
import {
  assertCodexItemSettled,
  projectCodexMessage,
  type NativeSnapshot,
} from '../../protocol/src/codex-context.js'
import type { ArchiveHeader } from '../../protocol/src/archives.js'

const tools = new Set([
  'commandExecution',
  'fileChange',
  'functionCallOutput',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'subAgentActivity',
  'plan',
  'webSearch',
  'imageView',
  'imageGeneration',
  'sleep',
])

const media = new Set([
  'image',
  'audio',
  'inputImage',
  'inputAudio',
  'input_image',
  'input_audio',
  'input_file',
])
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function toolPayload(
  item: NativeSnapshot['items'][number]['item'],
  omit: () => void,
) {
  const strip = (part: unknown) => {
    if (!object(part) || typeof part.type !== 'string') return part
    const resource =
      part.type === 'resource' && object(part.resource)
        ? part.resource
        : undefined
    if (!media.has(part.type) && !(resource && 'blob' in resource)) return part
    omit()
    return { type: part.type, attachmentOmitted: true }
  }
  if (
    item.type === 'mcpToolCall' &&
    object(item.result) &&
    Array.isArray(item.result.content)
  )
    return {
      ...item,
      result: { ...item.result, content: item.result.content.map(strip) },
    }
  if (item.type === 'dynamicToolCall' && Array.isArray(item.contentItems))
    return { ...item, contentItems: item.contentItems.map(strip) }
  if (item.type === 'imageGeneration' && Array.isArray(item.inputImages)) {
    const inputImages = item.inputImages.map(() => {
      omit()
      return { attachmentOmitted: true }
    })
    return { ...item, inputImages }
  }
  return item
}

export function archiveItem(
  { turnId, item }: NativeSnapshot['items'][number],
  scope: ArchiveHeader['scope'],
  coverage: Pick<ArchiveHeader, 'omittedAttachments' | 'unrecognizedItems'>,
): ArchiveRecord | undefined {
  assertCodexItemSettled(item)
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    if (item.type === 'userMessage') {
      const parts = z.array(z.object({ type: z.string() })).parse(item.content)
      coverage.omittedAttachments += parts.filter(
        (part) => part.type !== 'text',
      ).length
    }
    const message = projectCodexMessage(item, 'text')
    if (message) return { ...message, turn: turnId, kind: item.type }
    return
  }
  if (
    scope === 'text' ||
    item.type === 'reasoning' ||
    item.type === 'contextCompaction'
  )
    return
  if (!tools.has(item.type)) {
    coverage.unrecognizedItems++
    return
  }
  let text = JSON.stringify(
    toolPayload(item, () => coverage.omittedAttachments++),
    null,
    2,
  )
  if (
    item.type === 'commandExecution' &&
    typeof item.aggregatedOutput === 'string'
  ) {
    const { aggregatedOutput, ...command } = item
    text =
      JSON.stringify(command, null, 2) +
      '\n\n[Recorded command output]\n' +
      aggregatedOutput
  }
  return {
    turn: turnId,
    kind: item.type,
    role: 'reference',
    ...(typeof item.status === 'string' ? { status: item.status } : {}),
    text,
  }
}
