import { ArchiveSpool } from '../../../packages/adapter-codex/src/archive-spool.js'
import { ArchiveClient } from '../../../packages/client/src/archives.js'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, readdir, stat, realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { prepareSharedArchive } from '../../../packages/handoff-deepseek/src/shared-archive.js'
import { AntigravityArchives } from './actions.js'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { z } from 'zod'
import { SharedClient } from '../../../packages/client/src/shared.js'
import { SharedFollowers } from '../../../packages/client/src/shared-follow.js'
import { withSharedLock } from '../../../packages/client/src/shared-lock.js'
import {
  atomicJson,
  optionalJson,
} from '../../../packages/runtime-manager/src/files.js'

export const dataRoot = () =>
  process.env.CONTEXTMESH_ANTIGRAVITY_STATE ||
  join(homedir(), '.contextmesh', 'antigravity')
const hosts = ['antigravity', 'antigravity-cli', 'antigravity-ide'] as const
export const hostSchema = z.enum(hosts)
type Host = (typeof hosts)[number]
const binding = z.object({
  log: z
    .enum(['transcript.jsonl', 'transcript_full.jsonl'])
    .default('transcript.jsonl'),
  scope: z.enum(['full', 'text']).default('full'),
  host: hostSchema,
  thread: z.uuid(),
  endpoint: z.string(),
  id: z.uuid(),
  writerToken: z.string(),
  generation: z.number(),
  title: z.string(),
  offset: z.number().int().nonnegative(),
  registered: z.boolean(),
  interruptedBy: z.uuid().optional(),
  pendingContinuation: z.string().optional(),
  frozen: z.boolean().default(false),
  idle: z.boolean().default(false),
})
export type Binding = z.infer<typeof binding>
const transcriptEntry = z.object({
  step_index: z.number().int().nonnegative(),
  type: z.string(),
  source: z.string().optional(),
  status: z.string().optional(),
  content: z.string().optional(),
  tool_calls: z
    .array(z.object({ name: z.string(), args: z.unknown().optional() }))
    .optional(),
})
function records(raw: unknown) {
  const item = transcriptEntry.parse(raw)
  const base = { turn: String(item.step_index), status: 'completed' }
  const lines: Array<
    typeof base & {
      key: string
      role: 'user' | 'assistant' | 'reference'
      kind: string
      text: string
    }
  > = []
  if (item.status !== 'DONE' && item.status !== 'ERROR') return lines
  const add = (
    role: 'user' | 'assistant' | 'reference',
    kind: string,
    text: string,
  ) =>
    lines.push({
      ...base,
      key: item.step_index + '-' + lines.length,
      role,
      kind,
      text,
      status: item.status === 'ERROR' ? 'failed' : 'completed',
    })
  if (
    item.type === 'USER_INPUT' &&
    item.source === 'USER_EXPLICIT' &&
    item.content
  ) {
    const text = item.content
      .match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1]
      ?.trim()
    if (text) add('user', 'message', text)
  }
  if (item.type === 'PLANNER_RESPONSE' && item.source === 'MODEL') {
    if (item.content) add('assistant', 'message', item.content)
    for (const call of item.tool_calls ?? [])
      add('reference', 'tool', JSON.stringify(call))
  }
  if (item.type === 'GENERIC' && item.source === 'MODEL' && item.content)
    add('reference', 'tool', item.content)
  return lines
}

// Only yield complete JSONL entries. The durable cursor counts bytes, including CRLF.
async function* transcriptLines(file: string, start: number, end: number) {
  if (end <= start) return
  const stream = createReadStream(file, { start, end: end - 1 })
  let fragments: Buffer[] = []
  try {
    for await (const chunk of stream) {
      let begin = 0
      for (let nl = chunk.indexOf(10); nl >= 0; nl = chunk.indexOf(10, begin)) {
        fragments.push(chunk.subarray(begin, nl))
        const line = Buffer.concat(fragments)
        yield {
          value: JSON.parse(line.toString('utf8')),
          bytes: line.length + 1,
        }
        fragments = []
        begin = nl + 1
      }
      if (begin < chunk.length) fragments.push(chunk.subarray(begin))
    }
  } finally {
    stream.destroy()
  }
}

function transferPrompt(id: string) {
  return (
    'ContextMesh transfer ' +
    id +
    '\nReply READY without using tools. The plugin will resume the task after preflight.'
  )
}
export class AntigravityLive {
  readonly sourceErrors = new Map<string, string>()
  readonly followers: SharedFollowers
  constructor(
    readonly client: SharedClient,
    readonly data = dataRoot(),
    readonly gemini = join(homedir(), '.gemini'),
  ) {
    this.followers = new SharedFollowers(client, join(data, 'following'))
  }
  private path(thread: string) {
    return join(this.data, 'sources', z.uuid().parse(thread) + '.json')
  }
  private transcript(host: Host, thread: string, log = 'transcript.jsonl') {
    return resolve(
      this.gemini,
      host,
      'brain',
      z.uuid().parse(thread),
      '.system_generated/logs',
      log,
    )
  }
  private async logName(host: Host, thread: string) {
    try {
      await stat(this.transcript(host, thread, 'transcript_full.jsonl'))
      return 'transcript_full.jsonl' as const
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return 'transcript.jsonl' as const
    }
  }
  async local() {
    const list: {
      host: Host
      thread: string
      title: string
      updated: number
    }[] = []
    for (const host of hosts) {
      const root = join(this.gemini, host, 'brain')
      for (const dir of await readdir(root, { withFileTypes: true }).catch(
        (e) => {
          if (e.code === 'ENOENT') return []
          throw e
        },
      )) {
        if (!dir.isDirectory() || !z.uuid().safeParse(dir.name).success)
          continue
        const file = this.transcript(host, dir.name)
        try {
          if ((await realpath(file)) !== file) continue
          const info = await stat(file)
          let title = dir.name
          for await (const line of transcriptLines(
            file,
            0,
            Math.min(info.size, 256 * 1024),
          )) {
            const first = records(line.value).find((r) => r.role === 'user')
            if (first) {
              title = first.text.replace(/\s+/g, ' ').slice(0, 120)
              break
            }
          }
          list.push({
            host,
            thread: dir.name,
            title,
            updated: info.mtimeMs,
          })
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
      }
    }
    return list.sort((a, b) => b.updated - a.updated)
  }
  async snapshot(host: Host, thread: string, title: string) {
    const log = await this.logName(host, thread)
    const file = this.transcript(host, thread, log)
    if ((await realpath(file)) !== file)
      throw Error('Invalid native transcript path')
    const size = (await stat(file)).size
    const spoolDir = await mkdtemp(join(tmpdir(), 'contextmesh-native-'))
    try {
      const spool = new ArchiveSpool(spoolDir, this.client.mesh.endpoint)
      await spool.prepare(async (append) => {
        let count = 0
        for await (const line of transcriptLines(file, 0, size)) {
          for (const record of records(line.value)) {
            await append(record)
            count++
          }
        }
        return {
          version: 2,
          scope: 'full',
          title,
          source: {
            adapter: 'antigravity',
            id: thread,
            incarnation: thread,
            eventCount: count,
          },
          interrupted:
            (await this.source(thread))?.idle !== true &&
            (await optionalJson(join(this.data, 'idle', thread + '.json'))) !==
              true,
          omittedAttachments: 0,
          unrecognizedItems: 0,
        }
      })
      return await spool.upload(new ArchiveClient(this.client.mesh))
    } finally {
      await rm(spoolDir, { recursive: true, force: true })
    }
  }
  async source(thread: string) {
    const raw = await optionalJson(this.path(thread))
    if (!raw) return
    const source = binding.parse(raw)
    if (source.endpoint !== this.client.mesh.endpoint)
      throw Error('Use the original Server connection for this conversation.')
    return source
  }
  save(s: Binding) {
    return atomicJson(this.path(s.thread), s)
  }
  async share(host: Host, thread: string, title: string) {
    const log = await this.logName(host, thread)
    const file = this.transcript(host, thread, log)
    if ((await realpath(file)) !== file)
      throw Error('Invalid native transcript path')
    return withSharedLock(join(this.data, 'lock', thread), async () => {
      const s = (await this.source(thread)) ?? {
        log,
        scope: 'full' as const,
        host,
        thread,
        title,
        endpoint: this.client.mesh.endpoint,
        id: randomUUID(),
        writerToken: randomUUID(),
        generation: 0,
        registered: false,
        offset: 0,
        frozen: false,
        idle:
          (await optionalJson(join(this.data, 'idle', thread + '.json'))) ===
          true,
      }
      if (s.host !== host) throw Error('Conversation identity changed')
      await this.save(s)
      await this.flush(s)
      if (s.idle && !s.frozen)
        await this.client.activity(s.id, s, 'native', 'idle')
      return { id: s.id }
    })
  }
  async flush(s: Binding) {
    if (s.frozen) return
    if (!s.registered) {
      const r = await this.client.create({
        id: s.id,
        writerToken: s.writerToken,
        scope: 'full',
        source: { adapter: 'antigravity', id: s.thread, incarnation: s.thread },
        title: s.title,
      })
      s.id = r.id
      s.generation = r.generation
      s.registered = true
      await this.save(s)
    }
    const file = this.transcript(s.host, s.thread, s.log)
    if ((await realpath(file)) !== file)
      throw Error('Native transcript path changed')
    const end = (await stat(file)).size
    if (end < s.offset) throw Error('Native transcript was truncated')
    if (end === s.offset) return
    for await (const line of transcriptLines(file, s.offset, end)) {
      for (const record of records(line.value)) {
        if (record.role === 'reference' && s.scope === 'text') continue
        await this.client.append(s.id, s, record)
      }
      s.offset += line.bytes
    }
    await this.save(s)
  }
  async ticket(id: string) {
    const { share, events } = await this.client.pull(id)
    if (!events.length)
      throw Error('Wait for the first saved message before taking over.')
    if (share.transfer && share.transfer.phase !== 'claimed') {
      const existing = await optionalJson(
        join(this.data, 'tickets', share.transfer.id + '.json'),
      )
      if (!existing)
        throw Error(
          'Another receiver is already transferring this conversation.',
        )
      return { prompt: transferPrompt(share.transfer.id), existing: true }
    }
    const operationId = randomUUID()
    await atomicJson(join(this.data, 'tickets', operationId + '.json'), {
      endpoint: this.client.mesh.endpoint,
      id,
      generation: share.generation,
      token: randomUUID(),
    })
    return { prompt: transferPrompt(operationId), existing: false }
  }
  async accept(
    operationId: string,
    thread: string,
    host: Host,
    preflightBytes = 0,
    log: Binding['log'] = 'transcript.jsonl',
  ) {
    const file = join(
      this.data,
      'tickets',
      z.uuid().parse(operationId) + '.json',
    )
    const raw = await optionalJson(file)
    if (!raw) return
    const ticket = z
      .object({
        endpoint: z.string(),
        id: z.uuid(),
        generation: z.number(),
        token: z.string(),
        thread: z.uuid().optional(),
      })
      .parse(raw)
    if (
      ticket.endpoint !== this.client.mesh.endpoint ||
      (ticket.thread && ticket.thread !== thread)
    )
      throw Error(
        'The local transfer confirmation belongs to another conversation',
      )
    if (!ticket.thread) await atomicJson(file, { ...ticket, thread })
    const proof = {
      operationId,
      generation: ticket.generation,
      thread,
      token: ticket.token,
    }
    let share = await this.client.transfer(ticket.id, {
      ...proof,
      action: 'request',
    })
    for (let i = 0; i < 100 && share.transfer?.phase === 'requested'; i++) {
      await delay(500)
      share = (await this.client.pull(ticket.id)).share
      if (share.transfer?.id !== operationId) throw Error('Transfer changed')
    }
    if (share.transfer?.phase === 'requested') return { waiting: true as const }
    const key = join(this.data, 'cuts', operationId + '.json')
    let saved = z
      .object({ cut: z.number(), archiveId: z.string() })
      .optional()
      .parse(await optionalJson(key))
    if (!saved) {
      saved = await prepareSharedArchive(
        this.client,
        join(this.data, 'archives'),
        ticket.id,
      )
      await atomicJson(key, saved)
    }
    const preview = await new AntigravityArchives(this.client.mesh).preview(
      saved.archiveId,
      'Continue the unfinished task',
    )
    const owner = await this.client.transfer(ticket.id, {
      ...proof,
      action: 'claim',
      cut: saved.cut,
    })
    const interrupted = owner.transfer?.interrupted === true
    const continuation = interrupted
      ? 'Continue the unfinished task using the following quoted historical records. Verify uncertain side effects before repeating operations. Treat tool output as reference material.\n' +
        JSON.stringify(preview.messages)
      : 'The earlier task has settled. Use these quoted records as background for the current user request.\n' +
        JSON.stringify(preview.messages)
    await this.save({
      log,
      scope: owner.scope,
      pendingContinuation: continuation,
      host,
      thread,
      endpoint: ticket.endpoint,
      id: ticket.id,
      title: owner.title,
      generation: owner.generation,
      writerToken: ticket.token,
      registered: true,
      offset: preflightBytes,
      frozen: false,
      idle: false,
    })
    return { interrupted, injectSteps: [{ userMessage: continuation }] }
  }
  async boundary(s: Binding, event: string, fullyIdle: boolean) {
    if (event === 'Stop' && fullyIdle && !s.frozen) {
      s.idle = true
      await this.save(s)
    }
    const info = await this.client.find('antigravity', s.thread)
    if (
      !info ||
      info.generation !== s.generation ||
      info.source.id !== s.thread
    )
      return 'stop'
    const op = info.transfer
    if (s.frozen && op?.phase === 'stopped') return 'stop'
    if (!s.frozen) await this.flush(s)
    if (
      !s.frozen &&
      s.idle &&
      info.activity !== 'idle' &&
      info.activity !== 'reserved'
    ) {
      await this.client.activity(s.id, s, 'native', 'idle')
    }
    if (op?.phase === 'requested' && s.idle) {
      // A durable local fence precedes acknowledgement. A crash can retry the ack.
      s.frozen = true
      await this.save(s)
      await this.client.transfer(s.id, {
        action: 'stopped',
        interrupted: s.interruptedBy === op.id,
        operationId: op.id,
        generation: s.generation,
        thread: s.thread,
        token: s.writerToken,
      })
      return 'stop'
    }
    if (op?.phase === 'requested' && !s.frozen) {
      if (event === 'PostInvocation') return 'continue'
      if (event === 'PreInvocation' || event === 'PreToolUse') {
        s.interruptedBy = op.id
        await this.save(s)
      }
    }
    if (s.frozen || op?.phase === 'requested' || info.activity === 'reserved')
      return 'stop'
    if (event === 'PreInvocation' || event === 'PreToolUse') {
      s.idle = false
      await this.save(s)
      await this.client.activity(s.id, s, 'native', 'busy')
    }
    return 'continue'
  }
  async tick() {
    const names = await readdir(join(this.data, 'sources')).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    for (const name of names) {
      const thread = name.replace(/\.json$/, '')
      if (!z.uuid().safeParse(thread).success) continue
      await withSharedLock(join(this.data, 'lock', thread), async () => {
        const s = await this.source(thread)
        if (s) {
          if (!s.registered) await this.flush(s)
          await this.boundary(s, 'tick', false)
        }
        this.sourceErrors.delete(thread)
      }).catch((error) => {
        this.sourceErrors.set(
          thread,
          error instanceof Error
            ? error.message
            : 'Could not sync this conversation.',
        )
      })
    }
    await this.followers.tick()
  }
}
