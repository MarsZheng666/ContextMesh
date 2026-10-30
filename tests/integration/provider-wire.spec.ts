import Fastify from 'fastify'
import { Context } from '@deepseek-ai/cordis'
import Llm, { MessageId, ToolCallId, type Message } from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { it, expect, vi } from 'vitest'
it('projects the same completed tool history through actual Responses, Chat and Anthropic adapters without leaking foreign replay state', async () => {
  const app = Fastify(),
    requests: Array<{ path: string; body: unknown }> = []
  app.post('/*', async (req, reply) => {
    requests.push({ path: req.url, body: req.body })
    let events: Array<{ type?: string; [key: string]: unknown }>
    if (req.url.includes('/anthropic'))
      events = [
        {
          type: 'message_start',
          message: {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: 'fixture',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 12, output_tokens: 0 },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'wire continuation ok' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ]
    else if (req.url.includes('/chat'))
      events = [
        {
          id: 'chat_fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'wire continuation ok' },
              finish_reason: null,
            },
          ],
        },
        {
          id: 'chat_fixture',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        },
      ]
    else {
      const item = {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'wire continuation ok',
            annotations: [],
          },
        ],
      }
      const response = {
        id: 'resp_fixture',
        object: 'response',
        created_at: 0,
        model: 'fixture',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
      }
      events = [
        {
          type: 'response.created',
          response: { ...response, status: 'in_progress', output: [] },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress', content: [] },
        },
        {
          type: 'response.content_part.added',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        {
          type: 'response.output_text.delta',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          delta: 'wire continuation ok',
        },
        {
          type: 'response.output_text.done',
          item_id: item.id,
          output_index: 0,
          content_index: 0,
          text: 'wire continuation ok',
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]
    }
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
    reply.raw.end(
      events
        .map(
          (e) =>
            (e.type ? 'event: ' + e.type + '\n' : '') +
            'data: ' +
            JSON.stringify(e) +
            '\n\n',
        )
        .join('') + (req.url.includes('/chat') ? 'data: [DONE]\n\n' : ''),
    )
  })
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 }),
    ctx = new Context()
  vi.stubEnv('CONTEXTMESH_WIRE_KEY', 'fixture-api-key-not-real')
  try {
    await ctx.plugin(Llm)
    const profiles = Object.fromEntries(
      [
        ['responses', 'openai-responses'],
        ['chat', 'openai-completions'],
        ['anthropic', 'anthropic-messages'],
      ].map(([route, api]) => [
        'wire-' + route,
        {
          api,
          apiKeyEnv: 'CONTEXTMESH_WIRE_KEY',
          baseURL:
            endpoint + '/' + route + (route === 'anthropic' ? '' : '/v1'),
          models: [
            {
              id: 'fixture',
              name: 'fixture',
              contextWindow: 65536,
              maxTokens: 1024,
              reasoningEfforts: false as const,
              input: ['text' as const],
            },
          ],
        },
      ]),
    )
    await ctx.plugin(PiAi, { providers: profiles })
    const call = ToolCallId('call_fixture'),
      messages: Message[] = [
        {
          id: MessageId('u1'),
          role: 'user',
          source: { kind: 'user' },
          content: [
            {
              type: 'text',
              text: 'Remember WIRE-CONTINUITY. Inspect the fixture.',
            },
          ],
        },
        {
          id: MessageId('a1'),
          role: 'assistant',
          source: {
            kind: 'model',
            provider: 'foreign-adapter',
            model: 'old',
            replayState: { fixturePrivateReplay: 'NEVER-TRANSMIT-FOREIGN' },
          },
          content: [
            {
              type: 'tool-call',
              id: call,
              name: 'inspect_fixture',
              arguments: '{"file":"fixture.txt"}',
            },
          ],
        },
        {
          id: MessageId('t1'),
          role: 'tool',
          source: { kind: 'tool', callId: call },
          toolCallId: call,
          content: [
            { type: 'text', text: 'fixture contents from a completed tool' },
          ],
        },
        {
          id: MessageId('u2'),
          role: 'user',
          source: { kind: 'user' },
          content: [
            {
              type: 'text',
              text: 'Continue from that result without rerunning the tool.',
            },
          ],
        },
      ]
    const original = JSON.stringify(messages)
    for (const route of ['responses', 'chat', 'anthropic']) {
      const chunks = []
      for await (const chunk of ctx.llm.stream({
        provider: 'wire-' + route,
        model: 'fixture',
        messages,
        maxTokens: 128,
        signal: AbortSignal.timeout(5000),
        tools: [
          {
            name: 'inspect_fixture',
            description: 'Inspect a fixture',
            parameters: {
              type: 'object',
              properties: { file: { type: 'string' } },
              required: ['file'],
            },
          },
        ],
      }))
        chunks.push(chunk)
      expect(JSON.stringify(chunks)).toContain('wire continuation ok')
    }
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      const wire = JSON.stringify(request.body)
      expect(wire).toContain('WIRE-CONTINUITY')
      expect(wire).toContain('completed tool')
      expect(wire).toContain('inspect_fixture')
      expect(wire).not.toContain('NEVER-TRANSMIT-FOREIGN')
    }
    expect(JSON.stringify(messages)).toBe(original)
  } finally {
    vi.unstubAllEnvs()
    await ctx.fiber.dispose()
    await app.close()
  }
}, 20000)
