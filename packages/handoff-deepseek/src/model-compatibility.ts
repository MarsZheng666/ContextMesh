import { estimateMessage } from '@deepseek-ai/dsh-token-meter/estimate'
import type { ModelProfile, CapacityMode } from './model-profile.js'
import type {
  LlmRuntime,
  PreparedLlmCall,
  Message,
  GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, MessageId } from '@deepseek-ai/dsh-llm'
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
  capacityMode?: CapacityMode
  maxOutputTokens?: number
  toolsAllowed?: boolean
}
type Request = Pick<
  GenerateOptions,
  'messages' | 'tools' | 'system' | 'maxTokens'
>
export function capacityEstimate(request: Request, budget: ModelBudget) {
  const payload = {
    messages: request.messages,
    tools: request.tools,
    system: request.system,
  }
  const byteUpperBound = requestBudget(payload)
  const visible = {
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    tools: request.tools,
    system: request.system,
  }
  const unicode = Array.from(JSON.stringify(visible))
    .filter((c) => c.charCodeAt(0) > 127)
    .join('')
  // Match the pinned Harness baseline, then add explicit Unicode and framing margin.
  const native =
    request.messages.reduce(
      (sum, m) =>
        sum +
        estimateMessage(
          m.id === undefined
            ? {
                ...m,
                id: MessageId('capacity-estimate'),
                source: { kind: 'user' },
              }
            : m,
        ),
      0,
    ) +
    (request.tools?.length
      ? Math.ceil(JSON.stringify(request.tools).length / 4) + 4
      : 0) +
    (request.system
      ? Math.ceil(JSON.stringify(request.system).length / 4) + 4
      : 0)
  const estimatedTokens = Math.ceil(
    (native + Buffer.byteLength(unicode, 'utf8') / 2) * 1.25,
  )
  const outputReserve = request.maxTokens ?? budget.outputReserve,
    headroom = 1024
  return {
    method: 'dsh-heuristic-with-margin' as const,
    exact: false as const,
    estimatedTokens,
    byteUpperBound,
    outputReserve,
    headroom,
    contextWindow: budget.contextWindow,
    conservativeFits:
      byteUpperBound + outputReserve + headroom <= budget.contextWindow,
    estimatedFits:
      estimatedTokens + outputReserve + headroom <= budget.contextWindow,
  }
}
export function assertRequestBudget(request: Request, budget: ModelBudget) {
  if (budget.toolsAllowed === false && request.tools?.length)
    throw new MeshError(
      'MODEL_TOOLS_UNSUPPORTED',
      'choose a tool-capable model or a tool-free preset',
    )
  if (
    budget.maxOutputTokens !== undefined &&
    (request.maxTokens ?? budget.outputReserve) > budget.maxOutputTokens
  )
    throw new MeshError(
      'MODEL_OUTPUT_LIMIT',
      'configured output exceeds the model output limit',
    )
  const estimate = capacityEstimate(request, budget)
  if (
    !(budget.capacityMode === 'estimated'
      ? estimate.estimatedFits
      : estimate.conservativeFits)
  )
    throw new MeshError(
      'MODEL_CONTEXT_TOO_SMALL',
      'this model may not fit the conversation; inspect capacity or choose a larger context window',
    )
}
export async function analyzeModel(
  llm: LlmRuntime,
  session: Session,
  requested: ModelRoute,
  signal?: AbortSignal,
  outputLimit?: number,
  options: { profile?: ModelProfile; capacityMode?: CapacityMode } = {},
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
  const profile = options.profile
  if (
    profile &&
    (profile.provider !== requested.provider ||
      profile.model !== requested.model)
  )
    throw new MeshError(
      'MODEL_PROFILE_CHANGED',
      'model profile belongs to another route',
    )
  const text =
    prepared.inputModalities === undefined
      ? profile?.textInput === true
      : prepared.inputModalities.includes('text')
  let window = prepared.context?.contextWindow ?? profile?.contextWindow
  if (window && profile?.contextWindow)
    window = Math.min(window, profile.contextWindow)
  if (!text || !window)
    throw new MeshError(
      'MODEL_CAPABILITIES_UNKNOWN',
      'this model must declare text support and its context window before relay',
    )
  if (profile?.textInput === false)
    throw new MeshError(
      'MODEL_CAPABILITIES_UNKNOWN',
      'this model profile disables text input',
    )
  if (!portableHistory(session.snapshotEvents()))
    throw new MeshError(
      'MODEL_HISTORY_UNSUPPORTED',
      'this version supports text and completed tools; unsupported resources cannot be relayed',
    )
  const messages = session.deriveMessages()
  completeToolHistory(messages)
  if (
    profile?.tools === false &&
    messages.some(
      (m) => m.role === 'tool' || m.content.some((b) => b.type === 'tool-call'),
    )
  )
    throw new MeshError(
      'MODEL_TOOLS_UNSUPPORTED',
      'this model profile cannot replay the conversation tool history',
    )
  if (
    profile?.maxOutputTokens !== undefined &&
    prepared.config.maxTokens === undefined
  )
    throw new MeshError(
      'MODEL_OUTPUT_LIMIT',
      'set an explicit output limit in the target adapter configuration',
    )
  const budget: ModelBudget = {
    route: modelRoute.parse(requested),
    contextWindow: window,
    outputReserve:
      prepared.config.maxTokens ?? Math.min(8192, Math.floor(window / 4)),
    capacityMode: options.capacityMode ?? 'conservative',
    ...(profile?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: profile.maxOutputTokens }),
    ...(profile?.tools === undefined ? {} : { toolsAllowed: profile.tools }),
  }
  if (
    budget.maxOutputTokens !== undefined &&
    budget.outputReserve > budget.maxOutputTokens
  )
    throw new MeshError(
      'MODEL_OUTPUT_LIMIT',
      'target output limit exceeds its configured maximum',
    )
  const request = { messages, tools: header?.tools }
  if (budget.toolsAllowed === false && request.tools?.length)
    throw new MeshError(
      'MODEL_TOOLS_UNSUPPORTED',
      'choose a tool-free preset for this model',
    )
  return {
    budget,
    capacity: capacityEstimate(request, budget),
    route: budget.route,
    historyCut: session.snapshotEvents().length,
    capabilities: {
      contextWindow: window,
      textInput: text,
      tools: profile?.tools ?? 'adapter-defined',
      maxOutputTokens: profile?.maxOutputTokens ?? null,
      systemPromptUpdate: prepared.systemPromptUpdate ?? null,
      toolUpdate: prepared.toolUpdate ?? null,
    },
  }
}
export async function inspectModel(
  llm: LlmRuntime,
  session: Session,
  requested: ModelRoute,
  signal?: AbortSignal,
  outputLimit?: number,
  options: { profile?: ModelProfile; capacityMode?: CapacityMode } = {},
) {
  const analysis = await analyzeModel(
    llm,
    session,
    requested,
    signal,
    outputLimit,
    options,
  )
  assertRequestBudget(
    {
      messages: session.deriveMessages(),
      tools: session.requestHeader()?.tools,
    },
    analysis.budget,
  )
  return analysis.budget
}
