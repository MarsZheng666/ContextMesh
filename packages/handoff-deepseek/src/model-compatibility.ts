import type {
  LlmRuntime,
  PreparedLlmCall,
  Message,
  GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { MeshError } from '../../protocol/src/index.js'
import { modelRoute } from '../../protocol/src/handoff.js'
import type { ModelRoute } from '../../protocol/src/model-relay.js'

/** Estimate conservatively without importing a provider's tokenizer or retaining private replay state. */
export function requestBudget(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
export function portableHistory(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(portableHistory)
  if (!value || typeof value !== 'object') return true
  const row = Object.fromEntries(Object.entries(value))
  if (
    ['image', 'file', 'spill'].includes(String(row.type)) ||
    'spillId' in row ||
    'attachmentId' in row
  )
    return false
  return Object.values(row).every(portableHistory)
}
export function completeToolHistory(messages: readonly Message[]) {
  const calls = new Set<string>()
  for (const message of messages) {
    if (
      message.content.some(
        (block) =>
          ![
            'text',
            'reasoning',
            'tool-call',
            'tool-addition',
            'tool-removal',
          ].includes(block.type),
      )
    )
      throw new MeshError(
        'MODEL_HISTORY_UNSUPPORTED',
        'history contains unsupported content',
      )
    if (message.role === 'assistant')
      for (const block of message.content) {
        if (block.type === 'tool-call') {
          try {
            JSON.parse(block.arguments)
          } catch {
            throw new MeshError(
              'MODEL_HISTORY_UNSUPPORTED',
              'a historical tool call has invalid JSON arguments',
            )
          }
          if (calls.has(block.id))
            throw new MeshError(
              'MODEL_HISTORY_UNSUPPORTED',
              'tool call identities are not unique',
            )
          calls.add(block.id)
        }
      }
    if (message.role === 'tool' && !calls.delete(message.toolCallId))
      throw new MeshError(
        'MODEL_HISTORY_UNSUPPORTED',
        'a tool result has no matching call',
      )
  }
  if (calls.size)
    throw new MeshError(
      'MODEL_HISTORY_UNSUPPORTED',
      'finish pending tool calls before switching models',
    )
}
export interface ModelBudget {
  route: ModelRoute
  contextWindow: number
  outputReserve: number
}
export function assertRequestBudget(
  request: Pick<GenerateOptions, 'messages' | 'tools' | 'system' | 'maxTokens'>,
  budget: ModelBudget,
) {
  const input = requestBudget({
    messages: request.messages,
    tools: request.tools,
    system: request.system,
  })
  if (
    input + (request.maxTokens ?? budget.outputReserve) + 1024 >
    budget.contextWindow
  )
    throw new MeshError(
      'MODEL_CONTEXT_TOO_SMALL',
      'this model may not fit the conversation; choose a larger context window',
    )
}
export async function inspectModel(
  llm: LlmRuntime,
  session: Session,
  requested: ModelRoute,
  signal?: AbortSignal,
  outputLimit?: number,
) {
  const header = session.requestHeader()
  const explicitMax =
    outputLimit ??
    (header?.adapterDefaults?.maxTokens === true
      ? undefined
      : header?.config.maxTokens)
  const prepared: PreparedLlmCall = await llm.prepareCall(
    {
      provider: requested.provider,
      model: requested.model,
      ...(explicitMax === undefined ? {} : { maxTokens: explicitMax }),
      ...(requested.reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(requested.reasoningEffort) }
        : {}),
    },
    signal,
  )
  if (
    !prepared.inputModalities?.includes('text') ||
    !prepared.context?.contextWindow
  )
    throw new MeshError(
      'MODEL_CAPABILITIES_UNKNOWN',
      'this model must declare text support and its context window before relay',
    )
  if (!portableHistory(session.snapshotEvents()))
    throw new MeshError(
      'MODEL_HISTORY_UNSUPPORTED',
      'this version supports text and completed tool history; attachments cannot be relayed',
    )
  const messages = session.deriveMessages()
  completeToolHistory(messages)
  const budget: ModelBudget = {
    // Persist only the explicit controls; prepared defaults remain adapter-owned request state.
    route: modelRoute.parse(requested),
    contextWindow: prepared.context.contextWindow,
    outputReserve:
      prepared.config.maxTokens ??
      Math.min(8192, Math.floor(prepared.context.contextWindow / 4)),
  }
  assertRequestBudget(
    { messages, tools: session.requestHeader()?.tools },
    budget,
  )
  return budget
}
