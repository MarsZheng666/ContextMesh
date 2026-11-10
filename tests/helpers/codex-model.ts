import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export async function codexModel(home: string, tool = false) {
  const app = Fastify()
  const requests: any[] = []
  app.post('/*', async (req, reply) => {
    requests.push(req.body)
    const text =
      JSON.stringify(req.body).includes('CODEX-RELAY-731') &&
      JSON.stringify(req.body).includes('total=17')
        ? 'CODEX-RELAY-731 total=17 next=verification'
        : 'native fixture reply'
    let item: any = {
      id: 'msg_' + randomUUID(),
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }],
    }
    const body = req.body as any
    const calling =
      tool &&
      !body.input
        ?.slice(
          Math.max(
            0,
            body.input.findLastIndex((entry: any) => entry.role === 'user'),
          ),
        )
        .some((entry: any) => entry.type === 'function_call_output')
    if (calling)
      item = {
        id: 'fc_' + randomUUID(),
        type: 'function_call',
        call_id: 'call_' + randomUUID(),
        name:
          ['exec_command', 'shell_command', 'shell'].find((name) =>
            body.tools?.some((t: any) => t.name === name),
          ) ?? 'exec_command',
        status: 'completed',
        arguments: JSON.stringify({
          cmd: "printf 'live-probe-output\\n'; sleep 3",
          yield_time_ms: 4500,
        }),
      }
    const response = {
      id: 'resp_' + randomUUID(),
      object: 'response',
      created_at: 1,
      model: 'gpt-6.1-sol',
      status: 'completed',
      output: [item],
      usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
    }
    let events: any[] = [
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
        delta: text,
      },
      {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text,
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ]
    if (calling)
      events = [
        {
          type: 'response.created',
          response: { ...response, status: 'in_progress', output: [] },
        },
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { ...item, status: 'in_progress', arguments: '' },
        },
        {
          type: 'response.function_call_arguments.delta',
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        },
        {
          type: 'response.function_call_arguments.done',
          item_id: item.id,
          output_index: 0,
          arguments: item.arguments,
        },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response },
      ]
    reply.hijack()
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream' })
    reply.raw.end(
      events
        .map(
          (e) => 'event: ' + e.type + '\ndata: ' + JSON.stringify(e) + '\n\n',
        )
        .join(''),
    )
  })
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 })
  await mkdir(home, { recursive: true, mode: 0o700 })
  await writeFile(
    join(home, 'config.toml'),
    `model = "gpt-6.1-sol"\nmodel_provider = "fixture"\n[model_providers.fixture]\nname = "Isolated test provider"\nbase_url = "${endpoint}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n[features]\nplugins = false\napps = false\nincremental_tools = false\ndeferred_tool_world_state = false\n`,
    { mode: 0o600 },
  )
  return { app, requests, endpoint }
}
