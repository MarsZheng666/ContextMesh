import { withSharedLock } from '../../client/src/shared-lock.js'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { SharedClient } from '../../client/src/shared.js'
import { SharedFollowers } from '../../client/src/shared-follow.js'
import { MeshClient } from '../../client/src/index.js'
import {
  atomicJson,
  optionalJson,
  privateDirectory,
} from '../../runtime-manager/src/files.js'
import { listenLocal } from '../../handoff-deepseek/src/local-control.js'
import { type SharedItem } from '../../protocol/src/shared.js'
import type { BridgeOptions } from './bridge.js'
import { NativeCodex } from './native.js'

const binding = z.object({
  endpoint: z.string(),
  threadId: z.uuid(),
  id: z.uuid(),
  title: z.string(),
  scope: z.enum(['full', 'text']),
  writerToken: z.string(),
  generation: z.number(),
  registered: z.boolean(),
  seen: z.record(z.string(), z.string()),
  error: z.string().optional(),
  adoption: z
    .object({ generation: z.number(), targetSessionId: z.string() })
    .optional(),
})
type Binding = z.infer<typeof binding>
export const sharedHook = z
  .object({
    session_id: z.uuid(),
    turn_id: z.string().optional(),
    hook_event_name: z.enum([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'Interrupt',
    ]),
    tool_use_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    last_assistant_message: z.string().optional(),
  })
  .passthrough()
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')

export class CodexSharedSync {
  readonly client: SharedClient
  readonly followers: SharedFollowers
  readonly directory: string
  private working?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  constructor(readonly options: BridgeOptions) {
    this.client = new SharedClient(new MeshClient(options.connection))
    this.directory = join(options.stateDir, 'shared')
    this.followers = new SharedFollowers(
      this.client,
      join(this.directory, 'following'),
    )
  }
  private path(thread: string) {
    return join(this.directory, 'sources', z.uuid().parse(thread) + '.json')
  }
  async sources() {
    const files = await readdir(join(this.directory, 'sources')).catch((e) => {
      if (e.code === 'ENOENT') return []
      throw e
    })
    const result: Binding[] = []
    for (const file of files.filter((v) => v.endsWith('.json'))) {
      const value = binding.parse(
        await optionalJson(join(this.directory, 'sources', file)),
      )
      if (value.endpoint === this.client.mesh.endpoint) result.push(value)
    }
    return result
  }
  async share(threadId: string, title: string, scope: 'full' | 'text') {
    const old = await optionalJson(this.path(threadId))
    if (old) {
      const saved = binding.parse(old)
      if (saved.endpoint !== this.client.mesh.endpoint)
        throw new Error('This publisher belongs to a different Server')
      if (saved.scope !== scope)
        throw new Error(
          'This conversation is already shared with ' +
            saved.scope +
            ' scope; the existing scope remains in effect',
        )
      return { id: saved.id }
    }
    const value: Binding = {
      endpoint: this.client.mesh.endpoint,
      threadId,
      id: randomUUID(),
      title,
      scope,
      writerToken: randomUUID(),
      generation: 0,
      registered: false,
      seen: {},
    }
    await atomicJson(this.path(threadId), value)
    return { id: value.id }
  }
  async captureHook(raw: unknown) {
    const input = sharedHook.parse(raw)
    const saved = await optionalJson(this.path(input.session_id))
    if (!saved) return { shared: false }
    const source = binding.parse(saved)
    if (source.endpoint !== this.client.mesh.endpoint) return { shared: false }
    if (
      input.hook_event_name === 'UserPromptSubmit' ||
      input.hook_event_name === 'PreToolUse'
    ) {
      if (source.adoption)
        throw new Error(
          'Wait for the confirmed transfer to finish before continuing this conversation',
        )
      if (!source.registered)
        await this.client.create({
          id: source.id,
          title: source.title,
          scope: source.scope,
          source: {
            adapter: 'codex',
            id: source.threadId,
            incarnation: source.threadId,
          },
          writerToken: source.writerToken,
        })
      await this.client.activity(
        source.id,
        source,
        input.turn_id ?? 'unknown',
        'busy',
        input.hook_event_name === 'PreToolUse' ? input.tool_use_id : undefined,
      )
    }
    // Every invocation has a separate durable file, so concurrent hooks never overwrite each other.
    await atomicJson(
      join(
        this.directory,
        'outbox',
        Date.now() +
          '-' +
          process.hrtime.bigint().toString().padStart(24, '0') +
          '-' +
          randomUUID() +
          '.json',
      ),
      input,
    )
    return { shared: true }
  }
  async prepareAdoption(
    sourceId: string,
    threadId: string,
    targetSessionId: string,
  ) {
    const info = await this.client.find('deepseek', sourceId)
    if (!info) return
    if (await optionalJson(this.path(threadId))) return
    const value: Binding = {
      endpoint: this.client.mesh.endpoint,
      threadId,
      id: info.id,
      title: info.title,
      scope: info.scope,
      writerToken: randomUUID(),
      generation: info.generation + 1,
      registered: true,
      seen: {},
      adoption: { generation: info.generation, targetSessionId },
    }
    const native = new NativeCodex(this.options.native)
    try {
      await native.init()
      await native.scanShared(threadId, info.scope, async (key, record) => {
        value.seen[key] = digest({
          key,
          turn: record.turn,
          role: record.role,
          kind: record.kind,
          status: record.status,
          text: record.text,
        })
      })
    } finally {
      await native.close()
    }
    await atomicJson(this.path(threadId), value)
  }
  private async send(
    source: Binding,
    key: string,
    record: Omit<SharedItem, 'preview'> & { text: string },
  ) {
    const version = digest(record)
    if (source.seen[key] === version) return
    await this.client.append(source.id, source, record)
    source.seen[key] = version
    await atomicJson(this.path(source.threadId), source)
  }
  private async scan(
    source: Binding,
    native: NativeCodex,
    expected?: { turn: string; text: string },
  ) {
    let found = !expected
    await native.scanShared(
      source.threadId,
      source.scope,
      async (key, record) => {
        if (
          expected &&
          record.turn === expected.turn &&
          record.role === 'assistant' &&
          record.text === expected.text
        )
          found = true
        await this.send(source, key, {
          key,
          turn: record.turn,
          role: record.role,
          kind: record.kind,
          status: record.status,
          text: record.text,
        })
      },
    )
    if (!found) throw new Error('Waiting for Codex to persist the final reply')
  }
  private async sync() {
    const sources = await this.sources()
    if (!sources.length) {
      await this.followers.tick()
      return
    }
    const native = new NativeCodex(this.options.native)
    try {
      await native.init()
      for (const source of sources) {
        try {
          if (source.adoption) {
            const info = await this.client.adoptCodex(source.id, {
              ...source.adoption,
              threadId: source.threadId,
              writerToken: source.writerToken,
            })
            source.generation = info.generation
            delete source.adoption
            await atomicJson(this.path(source.threadId), source)
          }
          if (!source.registered) {
            const info = await this.client.create({
              id: source.id,
              title: source.title,
              scope: source.scope,
              source: {
                adapter: 'codex',
                id: source.threadId,
                incarnation: source.threadId,
              },
              writerToken: source.writerToken,
            })
            source.id = info.id
            source.generation = info.generation
            source.registered = true
            await atomicJson(this.path(source.threadId), source)
          }
          await this.followers.follow(source.id)
          const current = await this.client.find('codex', source.threadId)
          if (
            current &&
            (current.source.adapter !== 'codex' ||
              current.source.id !== source.threadId ||
              current.generation !== source.generation)
          )
            continue
          // Persist visible native messages before hook events from their turn.
          await this.scan(source, native)
          const files = await readdir(join(this.directory, 'outbox')).catch(
            (e) => {
              if (e.code === 'ENOENT') return []
              throw e
            },
          )
          for (const file of files.filter((v) => v.endsWith('.json')).sort()) {
            const path = join(this.directory, 'outbox', file)
            const hook = sharedHook.parse(await optionalJson(path))
            if (hook.session_id !== source.threadId) continue
            const turn = hook.turn_id ?? 'unknown'
            if (
              source.scope === 'full' &&
              hook.hook_event_name === 'PreToolUse' &&
              hook.tool_use_id
            ) {
              const text =
                (hook.tool_name ?? 'Tool') +
                '\n' +
                JSON.stringify(hook.tool_input ?? {})
              await this.send(source, 'started:' + hook.tool_use_id, {
                key: hook.tool_use_id,
                turn,
                role: 'reference',
                kind: 'tool',
                status: 'running',
                text,
              })
            }
            if (
              source.scope === 'full' &&
              hook.hook_event_name === 'PostToolUse' &&
              hook.tool_use_id
            ) {
              const text = JSON.stringify(hook.tool_response ?? {})
              await this.send(source, 'finished:' + hook.tool_use_id, {
                key: hook.tool_use_id,
                turn,
                role: 'reference',
                kind: 'tool',
                status: 'completed',
                text,
              })
            }
            if (hook.hook_event_name === 'PostToolUse' && hook.tool_use_id)
              await this.client.activity(
                source.id,
                source,
                turn,
                'idle',
                hook.tool_use_id,
              )
            if (
              hook.hook_event_name === 'Stop' ||
              hook.hook_event_name === 'Interrupt'
            ) {
              await this.scan(
                source,
                native,
                hook.hook_event_name === 'Stop' && hook.last_assistant_message
                  ? { turn, text: hook.last_assistant_message }
                  : undefined,
              )
              await this.client.activity(source.id, source, turn, 'idle')
            }
            await rm(path, { force: true })
          }
          await this.scan(source, native)
          delete source.error
          await atomicJson(this.path(source.threadId), source)
        } catch (error) {
          source.error =
            error instanceof Error ? error.message : 'Connection interrupted'
          await atomicJson(this.path(source.threadId), source)
        }
      }
    } finally {
      await native.close()
      await this.followers.tick()
    }
  }
  async confirmManagedCompletion(threadId: string, turnId: string) {
    // The managed bridge has already verified its final saved cut and closed its writer.
    if (!(await this.sources()).some((source) => source.threadId === threadId))
      return
    await this.captureHook({
      session_id: threadId,
      turn_id: turnId,
      hook_event_name: 'Stop',
    })
    await this.tick()
  }

  async tick() {
    if (this.working) return this.working
    this.working = withSharedLock(join(this.directory, 'sync-lock'), () =>
      this.sync(),
    )
    try {
      await this.working
    } finally {
      this.working = undefined
    }
  }
  async run(signal: AbortSignal) {
    const shutdown = new AbortController()
    signal = AbortSignal.any([signal, shutdown.signal])
    await privateDirectory(join(this.directory, 'worker'))
    const lock = await listenLocal(
      join(this.directory, 'worker'),
      async (command) => {
        if (
          command &&
          typeof command === 'object' &&
          'action' in command &&
          command.action === 'stop'
        ) {
          this.stopped = true
          clearTimeout(this.timer)
          await this.working?.catch(() => {})
          // Flush the control reply before closing the pipe and exiting.
          setTimeout(() => shutdown.abort(), 50)
          return { stopped: true }
        }
        return { running: !this.stopped }
      },
    )
    const next = async () => {
      if (this.stopped) return
      await this.tick().catch(() => {})
      if (!this.stopped) this.timer = setTimeout(() => void next(), 750)
    }
    void next()
    try {
      if (!signal.aborted)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
    } finally {
      this.stopped = true
      clearTimeout(this.timer)
      await this.working?.catch(() => {})
      await lock.close()
    }
  }
  async status() {
    return {
      shares: await this.client.list(),
      following: await this.followers.list(),
      sources: (await this.sources()).map(({ id, threadId, title, error }) => ({
        id,
        threadId,
        title,
        error,
      })),
    }
  }
}
