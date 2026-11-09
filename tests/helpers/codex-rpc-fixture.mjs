import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const file = join(process.env.CODEX_HOME, 'fixture.json')
let state = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { threads: {}, requests: [] }
const send = (v) => process.stdout.write(JSON.stringify(v) + '\n')
const save = () => writeFileSync(file, JSON.stringify(state))
const fail = process.env.CODEX_FIXTURE_FAULT
let initialized = false
createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line),
    p = r.params ?? {}
  state.requests.push(r)
  save()
  if (!('id' in r) || !r.method) return
  const reply = (result) => send({ id: r.id, result })
  if (r.method === 'initialize') {
    initialized = true
    return reply({ userAgent: 'fixture' })
  }
  if (!initialized) return send({ id: r.id, error: { code: -32000 } })
  const t = state.threads[p.threadId]
  switch (r.method) {
    case 'config/read':
      return reply({
        config: { mcp_servers: { fixture_mcp: { enabled: true } } },
      })
    case 'thread/start': {
      const id = p.ephemeral
        ? 'ephemeral'
        : process.env.CODEX_FIXTURE_UUIDS === '1'
          ? randomUUID()
          : 'native-' + Object.keys(state.threads).length
      const model =
        p.model ?? process.env.CODEX_FIXTURE_DEFAULT_MODEL ?? 'fixture-default'
      const thread = {
        id,
        cwd: p.cwd,
        cliVersion: '0.154.0',
        status: { type: 'idle' },
        modelProvider: 'fixture',
        model,
      }
      if (!p.ephemeral)
        state.threads[id] = {
          thread,
          items: [],
          turns: [],
          injected: [],
          sandbox: p.sandbox,
        }
      save()
      return reply({
        thread,
        cwd: p.cwd,
        model,
        modelProvider: 'fixture',
        sandbox: {
          type: p.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite',
        },
        approvalPolicy: 'never',
      })
    }
    case 'thread/inject_items':
      t.injected.push(...p.items)
      save()
      if (fail === 'inject-drop') return process.exit(1)
      return reply({})
    case 'thread/resume':
      if (!t) return send({ id: r.id, error: { code: -32600 } })
      return reply({
        thread: t.thread,
        cwd: t.thread.cwd,
        model: t.thread.model,
        modelProvider: 'fixture',
        sandbox: {
          type: t.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite',
        },
        approvalPolicy: 'never',
      })
    case 'thread/read':
      return reply({ thread: t.thread })
    case 'thread/turns/list':
      return reply({ data: t.turns, nextCursor: null })
    case 'thread/items/list': {
      if (fail === 'cursor-loop')
        return reply({ data: t.items, nextCursor: 'same' })
      const start = Number(p.cursor ?? 0)
      const end = start + (p.limit ?? 100)
      return reply({
        data: t.items.slice(start, end),
        nextCursor: end < t.items.length ? String(end) : null,
      })
    }
    case 'turn/start': {
      if (fail === 'probe-fail' && !p.clientUserMessageId)
        return send({
          id: r.id,
          error: { code: -32000, message: 'provider rejected preflight' },
        })
      const id = 'turn-' + t.turns.length
      const turn = { id, status: 'completed' }
      t.turns.push(turn)
      t.items.push(
        {
          turnId: id,
          item: {
            type: 'userMessage',
            id: id + '-u',
            clientId: p.clientUserMessageId ?? null,
            content: p.input,
          },
        },
        {
          turnId: id,
          item: {
            type: 'agentMessage',
            id: id + '-a',
            text: 'fixture continuation',
            phase: 'final_answer',
          },
        },
      )
      if (process.env.CODEX_FIXTURE_RUN_LOG_BYTES) {
        t.items.splice(t.items.length - 1, 0, {
          turnId: id,
          item: {
            type: 'commandExecution',
            status: 'completed',
            exitCode: 0,
            aggregatedOutput: 'x'.repeat(
              Number(process.env.CODEX_FIXTURE_RUN_LOG_BYTES),
            ),
          },
        })
      }
      save()
      reply({ turn })
      if (
        fail === 'turn-drop' ||
        (fail === 'continuation-drop' && p.clientUserMessageId)
      )
        return process.exit(1)
      if (fail === 'turn-slow')
        return setTimeout(
          () =>
            send({
              method: 'turn/completed',
              params: { threadId: p.threadId, turn },
            }),
          1000,
        )
      send({ method: 'turn/completed', params: { threadId: p.threadId, turn } })
      return
    }
    default:
      return send({ id: r.id, error: { code: -32601 } })
  }
})
