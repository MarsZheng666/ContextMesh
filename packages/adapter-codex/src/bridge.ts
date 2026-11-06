import { readCodexContext } from '../../client/src/codex-context.js'
import { randomUUID, createHash } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { MeshClient, type ClientOptions } from '../../client/src/index.js'
import type { RemoteHandle, StoredEvent } from '../../protocol/src/index.js'
import {
  contextDigest,
  validatePortable,
  type PortableContext,
} from '../../protocol/src/portable.js'
import {
  privateDirectory,
  atomicJson,
  optionalJson,
} from '../../runtime-manager/src/files.js'
import { listenLocal } from '../../handoff-deepseek/src/local-control.js'
import { NativeCodex, targetSchema, type Target } from './native.js'
import type { CodexOptions } from './rpc.js'
import { deepSeekContext, nativeSnapshot } from './context.js'

const bindingSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string(),
    incarnation: z.uuid(),
    threadId: z.string(),
    target: targetSchema,
    codexHome: z.string().optional(),
    pending: z.uuid().optional(),
    handoffId: z.uuid().optional(),
  })
  .strict()
const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.uuid(),
  handoffId: z.uuid().optional(),
  sourceId: z.string(),
  sourceAdapter: z.enum(['deepseek', 'codex']),
  target: targetSchema,
  context: z.unknown(),
  codexHome: z.string().optional(),
  phase: z.enum([
    'creating',
    'created',
    'injecting',
    'injected',
    'archiving',
    'archived',
    'done',
    'attention',
  ]),
  threadId: z.string().optional(),
  incarnation: z.uuid().optional(),
})
type Journal = z.infer<typeof journalSchema>
export interface BridgeOptions {
  connection: Omit<ClientOptions, 'adapter'>
  stateDir: string
  native?: CodexOptions
}
export class CodexBridge {
  readonly client: MeshClient
  constructor(readonly options: BridgeOptions) {
    this.client = new MeshClient({ ...options.connection, adapter: 'codex' })
  }
  private home() {
    return this.options.native?.env?.CODEX_HOME ?? process.env.CODEX_HOME
  }
  private key(id: string) {
    return createHash('sha256').update(id).digest('hex')
  }
  private bindingPath(id: string) {
    return join(this.options.stateDir, 'bindings', this.key(id) + '.json')
  }
  private async locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const directory = join(this.options.stateDir, 'locks', this.key(key))
    await privateDirectory(directory)
    const lock = await listenLocal(directory, async () => ({ busy: true }))
    try {
      return await run()
    } finally {
      await lock.close()
    }
  }
  private async ready() {
    const ready = z
      .object({ schemaVersion: z.number(), features: z.array(z.string()) })
      .parse(await this.client.request('/health/ready'))
    if (
      ready.schemaVersion < 7 ||
      !ready.features.includes('native-agent-storage-v1')
    )
      throw new Error(
        'Upgrade the ContextMesh Server before using Codex imports',
      )
  }
  private async source(adapter: 'deepseek' | 'codex', id: string) {
    if (adapter === 'codex')
      return (await readCodexContext(this.client, id)).context
    const source = new MeshClient({ ...this.options.connection, adapter }),
      handle = await source.open(id, 'read')
    try {
      const read = await source.read(handle, 0, Number.MAX_SAFE_INTEGER)
      return deepSeekContext(
        { ...read.snapshot, nextSeq: read.end },
        read.events,
      )
    } finally {
      await source.close(handle, randomUUID())
    }
  }
  async import(input: {
    sourceId: string
    sourceAdapter?: 'deepseek' | 'codex'
    target: Target
    operationId?: string
    handoffId?: string
  }) {
    const operationId = z
      .uuid()
      .parse(input.operationId ?? randomUUID())
      .toLowerCase()
    if (
      input.handoffId &&
      z.uuid().parse(input.handoffId).toLowerCase() !== operationId
    )
      throw new Error('Handoff import must use its stable operation identity')
    return this.locked('import:' + operationId, () =>
      this.locked('run:codex:' + operationId, async () => {
        await this.ready()
        const file = join(
          this.options.stateDir,
          'imports',
          operationId + '.json',
        )
        let journal = journalSchema.optional().parse(await optionalJson(file))
        const target = await this.validateTarget(input.target)
        if (
          journal &&
          (journal.handoffId !== input.handoffId ||
            journal.sourceId !== input.sourceId ||
            journal.sourceAdapter !== (input.sourceAdapter ?? 'deepseek') ||
            JSON.stringify(journal.target) !== JSON.stringify(target) ||
            journal.codexHome !== this.home())
        )
          throw new Error(
            'Import operation was reused with different source or target settings',
          )
        if (journal?.phase === 'done') {
          if (
            (await this.client.stat('codex:' + operationId))?.incarnation !==
            journal.incarnation
          )
            throw new Error(
              'The archived import is no longer available; start a new import operation',
            )
          return {
            sessionId: 'codex:' + operationId,
            threadId: journal.threadId!,
            operationId,
          }
        }
        if (
          journal &&
          !['created', 'injected', 'archived'].includes(journal.phase)
        )
          throw new Error(
            `Import ${operationId} has an uncertain native operation; inspect its private journal before retrying`,
          )
        const native = new NativeCodex(this.options.native)
        let handle: RemoteHandle | undefined
        try {
          if (!journal) {
            const context = await this.source(
              input.sourceAdapter ?? 'deepseek',
              input.sourceId,
            )
            journal = {
              version: 1,
              handoffId: input.handoffId,
              operationId,
              sourceId: input.sourceId,
              sourceAdapter: input.sourceAdapter ?? 'deepseek',
              target,
              context,
              codexHome: this.home(),
              phase: 'creating',
            }
            await atomicJson(file, journal)
            await native.init()
            journal.threadId = await native.start(target)
            journal.phase = 'created'
            await atomicJson(file, journal)
          } else {
            await native.init()
            await native.resume(journal.threadId!, target)
          }
          const context = validatePortable(journal.context)
          if (journal.phase === 'created') {
            journal.phase = 'injecting'
            await atomicJson(file, journal)
            await native.inject(journal.threadId!, context)
            journal.phase = 'injected'
            await atomicJson(file, journal)
          }
          const sessionId = 'codex:' + operationId
          if (journal.phase === 'injected') {
            const snapshot = await native.snapshot(journal.threadId!)
            journal.phase = 'archiving'
            await atomicJson(file, journal)
            handle = await this.client.create(
              {
                id: sessionId,
                version: 1,
                createdAt: Date.now(),
                isSeeded: false,
                portable: context,
                sourceDigest: contextDigest(context),
                nativeThreadId: journal.threadId!,
                ...(journal.handoffId ? { handoffId: journal.handoffId } : {}),
                target: z.json().parse(target),
              },
              0,
            )
            await this.client.append(
              handle,
              [
                {
                  seq: 0,
                  type: 'codex/snapshot',
                  time: Date.now(),
                  snapshot: z.json().parse(snapshot),
                },
              ],
              randomUUID(),
            )
            await this.client.flush(handle, randomUUID())
            journal.incarnation = handle.session.incarnation
            await this.client.close(handle, randomUUID())
            handle = undefined
            journal.phase = 'archived'
            await atomicJson(file, journal)
          }
          await atomicJson(this.bindingPath(sessionId), {
            version: 1,
            sessionId,
            incarnation: journal.incarnation!,
            threadId: journal.threadId!,
            target,
            codexHome: journal.codexHome,
            handoffId: journal.handoffId,
          })
          journal.phase = 'done'
          await atomicJson(file, journal)
          return { sessionId, threadId: journal.threadId!, operationId }
        } catch (error) {
          if (handle)
            await this.client.close(handle, randomUUID(), true).catch(() => {})
          if (journal && !['archived', 'done'].includes(journal.phase)) {
            journal.phase = 'attention'
            await atomicJson(file, journal)
          }
          throw new Error(
            `Codex import ${operationId} did not complete. ${error instanceof Error ? error.message : 'Inspect its private journal.'}`,
          )
        } finally {
          await native.close()
        }
      }),
    )
  }
  private async validateTarget(input: Target) {
    const { realpath, stat } = await import('node:fs/promises')
    const target = targetSchema.parse(input),
      cwd = await realpath(target.cwd)
    if (!(await stat(cwd)).isDirectory())
      throw new Error('Choose an existing directory on this device')
    return { ...target, cwd }
  }
  async status(id: string) {
    if (id.startsWith('codex:')) {
      const binding = bindingSchema
        .optional()
        .parse(await optionalJson(this.bindingPath(id)))
      if (!binding) throw new Error('No local Codex binding for this session')
      return {
        sessionId: binding.sessionId,
        threadId: binding.threadId,
        target: binding.target,
        pendingOperationId: binding.pending ?? null,
        phase: binding.pending ? 'needs-review' : 'ready',
      }
    }
    const operationId = z.uuid().parse(id).toLowerCase()
    const journal = journalSchema.parse(
      await optionalJson(
        join(this.options.stateDir, 'imports', operationId + '.json'),
      ),
    )
    return {
      operationId,
      phase: journal.phase,
      sourceId: journal.sourceId,
      target: journal.target,
      threadId: journal.threadId ?? null,
      sessionId: ['archived', 'done'].includes(journal.phase)
        ? 'codex:' + operationId
        : null,
    }
  }
  async reconcile(id: string, confirmStopped: true) {
    if (confirmStopped !== true)
      throw new Error(
        'Confirm the previous Codex process and its tools have stopped',
      )
    return this.locked('run:' + id, async () => {
      await this.ready()
      const file = this.bindingPath(id),
        binding = bindingSchema.parse(await optionalJson(file))
      if (binding.codexHome !== this.home())
        throw new Error('Use the original local Codex home for recovery')
      if (!binding.pending)
        return { sessionId: id, reconciled: true, replayed: false }
      const native = new NativeCodex(this.options.native)
      let handle: RemoteHandle | undefined
      try {
        // Preflight native terminal state before changing the remote writer. This never starts a turn.
        await native.init()
        await native.resume(
          binding.threadId,
          await this.validateTarget(binding.target),
        )
        const snapshot = await native.snapshot(binding.threadId)
        const observation = await this.client.stat(id)
        if (
          !observation ||
          observation.incarnation !== binding.incarnation ||
          observation.header.nativeThreadId !== binding.threadId
        )
          throw new Error('Session identity changed; recovery is blocked')
        await this.client.request(
          `/v1/sessions/${encodeURIComponent(id)}/recover`,
          { operationId: randomUUID(), confirmStopped: true, adapter: 'codex' },
        )
        handle = await this.client.open(id, 'write')
        if (handle.session.incarnation !== binding.incarnation)
          throw new Error('Session identity changed during recovery')
        const cut = await this.client.read(handle, 0, Number.MAX_SAFE_INTEGER)
        const prior = cut.events.findLast((e) => e.type === 'codex/snapshot')
        const current = { turns: snapshot.turns, items: snapshot.items }
        const old = prior && nativeSnapshot.parse(prior.snapshot)
        const changed =
          !old ||
          JSON.stringify({ turns: old.turns, items: old.items }) !==
            JSON.stringify(current)
        if (changed)
          await this.client.append(
            handle,
            [
              {
                seq: cut.end,
                type: 'codex/snapshot',
                time: Date.now(),
                runOperationId: binding.pending,
                snapshot: z.json().parse(snapshot),
              },
            ],
            randomUUID(),
          )
        await this.client.flush(handle, randomUUID())
        await this.client.close(handle, randomUUID())
        handle = undefined
        delete binding.pending
        await atomicJson(file, binding)
        return { sessionId: id, reconciled: true, replayed: false, changed }
      } catch (error) {
        if (handle)
          await this.client.close(handle, randomUUID(), true).catch(() => {})
        throw error
      } finally {
        await native.close()
      }
    })
  }
  async run(
    id: string,
    message: string,
    timeoutMs?: number,
    control?: {
      beforeDispatch(handle: RemoteHandle, operationId: string): Promise<void>
    },
  ) {
    if (!message.trim() || Buffer.byteLength(message) > 1024 * 1024)
      throw new Error(
        'Provide a nonempty instruction within the message size limit',
      )
    return this.locked('run:' + id, async () => {
      await this.ready()
      const file = this.bindingPath(id),
        binding = bindingSchema.optional().parse(await optionalJson(file))
      if (!binding)
        throw new Error(
          'Import this session on this device before continuing it with Codex',
        )
      if (binding.codexHome !== this.home())
        throw new Error('Use the same local Codex home as the imported thread')
      if (binding.pending)
        throw new Error(
          `Previous Codex operation ${binding.pending} needs review; do not resend uncertain work`,
        )
      if (binding.handoffId && !control) {
        const h = z
          .object({
            state: z.literal('completed'),
            targetSessionId: z.literal(id),
            executionState: z.enum(['none', 'completed', 'failed']),
          })
          .safeParse(
            await this.client.request('/v1/handoffs/' + binding.handoffId),
          )
        if (!h.success)
          throw new Error(
            'This confirmed takeover still needs its one-time continuation or explicit reconciliation',
          )
      }
      const native = new NativeCodex(this.options.native)
      let handle: RemoteHandle | undefined,
        renewal: NodeJS.Timeout | undefined,
        renewing: Promise<void> | undefined,
        lost = false,
        dispatched = false
      try {
        await native.init()
        await native.resume(
          binding.threadId,
          await this.validateTarget(binding.target),
        )
        handle = await this.client.open(id, 'write')
        if (
          handle.session.incarnation !== binding.incarnation ||
          handle.session.header.version !== 1 ||
          handle.session.header.nativeThreadId !== binding.threadId
        )
          throw new Error(
            'Remote session identity changed; import a fresh snapshot',
          )
        if (
          handle.session.header.sourceDigest !==
          contextDigest(validatePortable(handle.session.header.portable))
        )
          throw new Error('Portable archive digest does not match')
        const old = await this.client.read(handle, 0, Number.MAX_SAFE_INTEGER)
        const last = old.events.findLast((e) => e.type === 'codex/snapshot')
        const local = await native.snapshot(binding.threadId)
        if (
          !last ||
          JSON.stringify({
            turns: nativeSnapshot.parse(last.snapshot).turns,
            items: nativeSnapshot.parse(last.snapshot).items,
          }) !== JSON.stringify({ turns: local.turns, items: local.items })
        )
          throw new Error(
            'The native Codex thread changed outside ContextMesh; import its reviewed history before continuing',
          )
        await this.client.renew(handle)
        const lease = await this.client.capabilities()
        renewal = setInterval(
          () => {
            if (renewing) return
            renewing = this.client
              .renew(handle!)
              .catch(() => {
                lost = true
                void native.close()
              })
              .finally(() => {
                renewing = undefined
              })
          },
          Math.max(100, Math.floor(lease.leaseMs / 3)),
        )
        binding.pending = randomUUID()
        await atomicJson(file, binding)
        await control?.beforeDispatch(handle, binding.pending)
        dispatched = true
        const turn = await native.execute(
          binding.threadId,
          message,
          timeoutMs,
          binding.pending,
        )
        if (lost)
          throw new Error('ContextMesh writer ownership could not be renewed')
        const snapshot = await native.snapshot(binding.threadId)
        const event: StoredEvent = {
          seq: old.end,
          runOperationId: binding.pending,
          type: 'codex/snapshot',
          time: Date.now(),
          snapshot: z.json().parse(snapshot),
        }
        await this.client.append(handle, [event], randomUUID())
        await this.client.flush(handle, randomUUID())
        clearInterval(renewal)
        renewal = undefined
        await renewing
        if (lost)
          throw new Error(
            'ContextMesh writer ownership changed before completion',
          )
        await this.client.close(handle, randomUUID())
        handle = undefined
        delete binding.pending
        await atomicJson(file, binding)
        const text = snapshot.items
          .filter((i) => i.turnId === turn.id && i.item.type === 'agentMessage')
          .map((i) => String(i.item.text))
          .join('\n')
        return {
          sessionId: id,
          threadId: binding.threadId,
          turnId: turn.id,
          status: turn.status,
          text,
        }
      } catch (error) {
        if (handle)
          await this.client
            .close(handle, randomUUID(), dispatched)
            .catch(() => {})
        throw error
      } finally {
        if (renewal) clearInterval(renewal)
        await renewing
        await native.close()
      }
    })
  }
}
