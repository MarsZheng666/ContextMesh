import { it, expect } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { MessageId, type LlmRuntime, type Message } from '@deepseek-ai/dsh-llm'
import {
  capacityEstimate,
  assertRequestBudget,
  analyzeModel,
  inspectModel,
} from '../../packages/handoff-deepseek/src/model-compatibility.js'
const route = { provider: 'fixture', model: 'model' }
const message = (text: string) =>
  ({
    id: MessageId('message'),
    source: { kind: 'user' },
    role: 'user',
    content: [{ type: 'text', text }],
  }) as Message
function session(messages: Message[], header?: unknown) {
  return {
    requestHeader: () => header,
    snapshotEvents: () =>
      messages.map((m, i) => ({ seq: i, type: 'message', data: m })),
    deriveMessages: () => messages,
  } as unknown as Session
}
function llm(
  contextWindow?: number,
  textInput: readonly string[] | null = ['text'],
  maxTokens = 1024,
) {
  return {
    prepareCall: async (config: object) => ({
      config: { ...route, ...config, maxTokens },
      context: contextWindow ? { contextWindow } : undefined,
      inputModalities: textInput === null ? undefined : textInput,
    }),
  } as unknown as LlmRuntime
}
it.each(['a'.repeat(12000), '中文上下文'.repeat(1000), 'αβ🙂'.repeat(1200)])(
  'reports heuristic uncertainty and applies only the explicitly chosen policy',
  (text) => {
    const request = { messages: [message(text)] },
      budget = { route, contextWindow: 100000, outputReserve: 1024 }
    const report = capacityEstimate(request, budget)
    expect(report.exact).toBe(false)
    expect(report.estimatedTokens).toBeGreaterThan(0)
    expect(report.byteUpperBound).toBeGreaterThan(report.estimatedTokens)
    const intermediate =
      Math.ceil((report.estimatedTokens + report.byteUpperBound) / 2) +
      report.outputReserve +
      report.headroom
    const limited = { ...budget, contextWindow: intermediate }
    expect(() => assertRequestBudget(request, limited)).toThrow()
    expect(() =>
      assertRequestBudget(request, { ...limited, capacityMode: 'estimated' }),
    ).not.toThrow()
    expect(() =>
      assertRequestBudget(request, {
        ...limited,
        capacityMode: 'estimated',
        contextWindow: 1,
      }),
    ).toThrow()
  },
)
it('requires declared text/window facts and never increases known adapter limits through a profile', async () => {
  const s = session([message('hello')])
  await expect(analyzeModel(llm(undefined), s, route)).rejects.toMatchObject({
    code: 'MODEL_CAPABILITIES_UNKNOWN',
  })
  const a = await analyzeModel(
    llm(undefined, null),
    s,
    route,
    undefined,
    undefined,
    { profile: { ...route, textInput: true, contextWindow: 8000 } },
  )
  expect(a.capabilities.contextWindow).toBe(8000)
  const b = await analyzeModel(llm(4000), s, route, undefined, undefined, {
    profile: { ...route, contextWindow: 8000 },
  })
  expect(b.capabilities.contextWindow).toBe(4000)
  await expect(
    analyzeModel(llm(4000, []), s, route, undefined, undefined, {
      profile: { ...route, textInput: true },
    }),
  ).rejects.toMatchObject({ code: 'MODEL_CAPABILITIES_UNKNOWN' })
})
it('checks explicit output and tool limits before mutation and again at dispatch', async () => {
  const s = session([message('hello')])
  await expect(
    inspectModel(llm(8000, ['text'], 2048), s, route, undefined, undefined, {
      profile: { ...route, maxOutputTokens: 1024 },
    }),
  ).rejects.toMatchObject({ code: 'MODEL_OUTPUT_LIMIT' })
  const profile = { ...route, maxOutputTokens: 2048, tools: false }
  const budget = await inspectModel(llm(8000), s, route, undefined, undefined, {
    profile,
  })
  expect(() =>
    assertRequestBudget(
      { messages: [message('hello')], maxTokens: 4096 },
      budget,
    ),
  ).toThrow('output')
  expect(() =>
    assertRequestBudget(
      { messages: [message('hello')], tools: [{} as never] },
      budget,
    ),
  ).toThrow('tool')
})
it('does not call a model or change native records during preflight', async () => {
  const messages = [message('original')],
    s = session(messages)
  const before = JSON.stringify(s.snapshotEvents())
  const report = await analyzeModel(llm(8000), s, route)
  expect(report.capacity.conservativeFits).toBe(true)
  expect(JSON.stringify(s.snapshotEvents())).toBe(before)
})
