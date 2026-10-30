import { fileReferences } from '../../packages/handoff-deepseek/src/file-attachments.js'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '../../packages/handoff-deepseek/src/index.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { modelRoute } from '../../packages/protocol/src/handoff.js'

export const inject = [
  'agents',
  'sessions',
  'contextmeshHandoff',
  'sessionController',
  'workingDirectory',
  'sandboxPolicy',
  'agentPresets',
  'llm',
  'webServer',
  'connection',
]
const realModel = process.env.CONTEXTMESH_TEST_REAL_MODEL === '1'
const provider = realModel ? 'deepseek-official' : 'contextmesh-e2e',
  model = realModel ? 'deepseek-flash' : 'scripted'
class ScriptedModel extends LlmAdapter {
  constructor(readonly route = provider) {
    super()
  }
  requests: GenerateOptions[] = []
  hold = false
  release?: () => void
  override async listModels() {
    return [
      {
        provider: this.route,
        id: this.route === provider ? model : 'relay',
        name: this.route === provider ? model : 'relay',
      },
    ]
  }
  override async resolveModel(p: string, m: string) {
    return {
      provider: p,
      id: m,
      name: m,
      context:
        m === 'unknown'
          ? undefined
          : {
              contextWindow:
                m === 'tiny' ? 4096 : m === 'balanced' ? 32768 : 2000000,
            },
      inputModalities: m === 'no-text' ? [] : ['text' as const],
    }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (!options.purpose) this.requests.push(options)
    if (this.hold && !options.purpose) {
      const signal = options.signal
      if (!signal)
        throw new Error('scripted running request needs cancellation')
      try {
        await new Promise<void>((resolve) => {
          const done = () => resolve()
          this.release = done
          signal.addEventListener('abort', done, { once: true })
          if (signal.aborted) done()
        })
        if (signal.aborted)
          throw new Error('scripted work cancelled for takeover')
      } finally {
        this.hold = false
      }
    }
    const start = options.messages.findLastIndex(
      (m) => m.role === 'user' && JSON.stringify(m).includes('READ_WORKSPACE'),
    )
    if (
      !options.purpose &&
      start >= 0 &&
      !options.messages.slice(start + 1).some((m) => m.role === 'tool')
    ) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: ToolCallId(randomUUID()),
          name: 'bash',
          arguments: JSON.stringify({
            command: 'pwd && cat handoff-sentinel.txt',
            description: 'Read the handoff fixture in the current workspace',
          }),
        },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = JSON.stringify(options.messages).includes(
      'CONTINUITY-PHRASE-4817',
    )
      ? 'Context retained CONTINUITY-PHRASE-4817.'
      : 'Ready.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 10 } }
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { fixturePrivateState: this.route } },
    }
  }
}
const input = z.object({
  id: z.number().int(),
  action: z.enum([
    'file-read',
    'create',
    'prompt',
    'state',
    'm1',
    'api',
    'local-settings',
    'start-running',
    'history-follow',
    'native-resume',
    'select-model',
    'finish-running',
  ]),
  sessionId: z.string().optional(),
  text: z.string().optional(),
  fileData: z.string().optional(),
  fileName: z.string().optional(),
  command: z.unknown().optional(),
  selection: modelRoute.optional(),
  finalTitle: z.string().optional(),
  cwd: z.string().optional(),
  mode: z
    .enum(['read-only', 'workspace-write', 'danger-full-access'])
    .optional(),
})
export async function apply(ctx: Context) {
  const sidebarSessions = new Map<string, unknown>()
  ctx.on('api-session/added', (summary) => {
    sidebarSessions.set(summary.sessionId, summary)
  })
  ctx.on('api-session/removed', (id) => {
    sidebarSessions.delete(id)
  })
  const presetMode = process.env.TEST_ISOLATED_POLICY_MODE
  if (presetMode) {
    const dispose = await ctx.agentPresets.register({
      id: 'm1-isolated-policy',
      plugins: [
        {
          id: 'policy',
          name: '@deepseek-ai/dsh-sandbox-policy',
          isolate: { sandboxPolicy: true },
          config: { mode: presetMode },
        },
      ],
    })
    ctx.effect(() => dispose, 'fixture: isolated policy preset')
  }
  let failResume = process.env.TEST_FAIL_TARGET_RESUME === '1'
  ctx.on('agent/created', () => {
    if (failResume) {
      failResume = false
      throw new Error('injected target publication failure')
    }
  })
  const adapter = new ScriptedModel()
  const second = new ScriptedModel('contextmesh-second')
  if (!realModel) {
    if (process.env.TEST_SKIP_SOURCE_MODEL !== '1')
      ctx.llm.registerAdapter([provider], adapter)
    ctx.llm.registerAdapter(['contextmesh-second'], second)
  }
  const receive = (raw: unknown) => {
    void (async () => {
      let id: number | undefined
      try {
        const request = input.parse(raw)
        id = request.id
        await ctx.get('loader')?.await()
        let value: unknown
        const sessionId = SessionId(request.sessionId ?? randomUUID())
        if (request.action === 'create') {
          value = await ctx.sessionController.create({
            sessionId,
            cwd: process.env.TEST_PROJECT_ROOT!,
            ...(presetMode ? { agentPreset: 'm1-isolated-policy' } : {}),
          })
          await ctx.sessionController.selectModel({
            sessionId,
            provider,
            model,
          })
        } else if (request.action === 'finish-running') {
          adapter.release?.()
          value = { released: true }
        } else if (request.action === 'select-model') {
          if (!request.selection) throw new Error('selection required')
          value = await ctx.sessionController.selectModel({
            sessionId,
            ...request.selection,
          })
        } else if (request.action === 'start-running') {
          adapter.hold = true
          await ctx.sessionController.prompt(
            {
              sessionId,
              requestId: brandString<SessionRequestId>(randomUUID()),
              mode: 'queue',
              content: [{ type: 'text', text: request.text ?? 'Long task' }],
            },
            new AbortController().signal,
          )
          value = { started: true }
        } else if (request.action === 'file-read') {
          const agent = ctx.agents.get(sessionId)
          if (!agent) throw new Error('Agent is not live')
          const refs = fileReferences(agent.session.snapshotEvents())
          value = await Promise.all(
            refs.map(async (ref) => {
              const chunks: Buffer[] = []
              for await (const chunk of ctx.get('attachments')!.readFileStream({
                ...ref,
                attachmentId: AttachmentId(ref.attachmentId),
              }))
                chunks.push(Buffer.from(chunk))
              return { ref, data: Buffer.concat(chunks).toString('base64') }
            }),
          )
        } else if (request.action === 'prompt') {
          const file =
            request.fileData === undefined
              ? undefined
              : await ctx
                  .get('fileUploads')!
                  .upload(
                    ctx.agents.get(sessionId)!,
                    { name: request.fileName, data: request.fileData },
                    new AbortController().signal,
                  )
          await ctx.sessionController.prompt(
            {
              sessionId,
              requestId: brandString<SessionRequestId>(randomUUID()),
              mode: 'queue',
              content: [
                { type: 'text', text: request.text ?? 'Continue.' },
                ...(file
                  ? [{ type: 'file' as const, receiptId: file.receiptId }]
                  : []),
              ],
            },
            new AbortController().signal,
          )
          const agent = ctx.agents.get(sessionId)
          if (!agent) throw new Error('Agent is not live')
          await agent.whenIdle()
          await ctx.sessions.flush(agent.session)
          value = {
            requests: adapter.requests.length,
            events: agent.session.snapshotEvents(),
            cwd: ctx.workingDirectory.get(agent.session),
            policy: (
              ctx.get('agentPresets')?.serviceFor(agent, 'sandboxPolicy') ??
              agent.ctx.get('sandboxPolicy') ??
              ctx.sandboxPolicy
            ).resolve({ session: agent.session }),
          }
        } else if (request.action === 'local-settings') {
          const agent = ctx.agents.get(sessionId)
          if (!agent) throw new Error('Agent is not live')
          if (request.finalTitle)
            agent.ctx.effect(
              () => () => {
                agent.session.append('session/title', {
                  title: request.finalTitle!,
                  messageSeqs: [],
                  source: { kind: 'user' },
                })
              },
              'fixture: final scope title',
            )
          if (request.cwd) await ctx.workingDirectory.set(agent, request.cwd)
          if (request.mode) setSandboxMode(agent.session, request.mode)
          await ctx.sessions.flush(agent.session)
          value = { configured: true }
        } else if (request.action === 'native-resume') {
          const result = await ctx.sessionController.resolveAgent(sessionId)
          if ('error' in result) throw result.error
          value = { live: true }
        } else if (request.action === 'history-follow') {
          const controller = new AbortController()
          const iterator = ctx.sessionController
            .follow(
              { address: { kind: 'session', sessionId } },
              controller.signal,
            )
            [Symbol.asyncIterator]()
          const first = await iterator.next()
          // Advance beyond the snapshot, where native DSH used to promote history.
          const next = iterator.next().catch(() => undefined)
          await new Promise((resolve) => setTimeout(resolve, 300))
          const live = Boolean(ctx.agents.get(sessionId))
          controller.abort()
          await next
          await iterator.return?.()
          value = { snapshot: first.value, live }
        } else if (request.action === 'state') {
          const agent = ctx.agents.get(sessionId)
          const modules: unknown = ctx.get('clientModules')
          const browserGraph =
            modules &&
            typeof modules === 'object' &&
            'graph' in modules &&
            typeof modules.graph === 'function'
              ? Reflect.apply(modules.graph, modules, [])
              : null
          value = {
            browserGraph,
            defaultModel: ctx.get('agentDefaultModel')?.currentSelection(),
            modelRequests: [...adapter.requests, ...second.requests].map(
              (r) => ({
                provider: r.provider,
                model: r.model,
                messages: r.messages,
                tools: r.tools,
              }),
            ),
            sidebarSessions: [...sidebarSessions.values()],
            live: Boolean(agent),
            controlled: ctx.agents.isControlled(sessionId),
            holding: Boolean(adapter.hold && adapter.release),
            running: agent?.status === 'running',
            frozen: ctx.contextmeshHandoff
              ? await ctx.contextmeshHandoff.command({ action: 'status' })
              : null,
          }
        } else if (request.action === 'm1')
          value = await ctx.contextmeshHandoff.command(request.command)
        else {
          const fetch = ctx.connection.createSharedFetchHandler('/api')
          const response = await fetch.fetch(
            new Request('http://localhost/api/contextmesh', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(request.command),
            }),
            ctx.connection.browserPeer,
          )
          value = {
            status: response.status,
            body: await response.json(),
            origin: ctx.webServer.getOrigin(),
          }
        }
        process.send?.({ id, ok: true, value })
      } catch (error) {
        process.send?.({
          id,
          ok: false,
          error: error instanceof Error ? error.stack : String(error),
        })
      }
    })()
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => {
      process.off('message', receive)
    }
  }, 'handoff test: IPC')
  process.send?.({ ready: true, nodeId: ctx.contextmeshHandoff.client.nodeId })
}
