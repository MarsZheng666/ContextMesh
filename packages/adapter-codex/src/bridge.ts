import { ArchiveSpool } from './archive-spool.js'
import { captureCodexArchive, readCodexCut } from './archive-export.js'
import { DshArchiveView } from './dsh-archive-view.js'
import type { ArchiveBudget } from '../../client/src/resume-archive.js'
import { ArchiveClient } from '../../client/src/archives.js'
import {
  archiveTokenBound,
  planArchiveResume,
} from '../../client/src/resume-archive.js'
import {
  archiveResumeOptions,
  isArchiveContext,
  isArchiveId,
  resumeContextDigest,
  validateResumeContext,
  type ArchiveResumeOptions,
  type ArchiveResumeContext,
} from '../../protocol/src/archives.js'
import { codexArchiveBudget, resolveArchiveTarget } from './archive-budget.js'
import { readCodexContext } from '../../client/src/codex-context.js'
import { randomUUID, createHash } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
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
import {
  NativeCodex,
  startTargetSchema,
  targetSchema,
  type StartTarget,
} from './native.js'
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
    archiveImport: z.uuid().optional(),
  })
  .strict()
const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.uuid(),
  handoffId: z.uuid().optional(),
  sourceId: z.string(),
  sourceAdapter: z.enum(['deepseek', 'codex']),
  target: startTargetSchema,
  requestedTarget: startTargetSchema.optional(),
  context: z.unknown(),
  resume: archiveResumeOptions.optional(),
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
type Binding = z.infer<typeof bindingSchema>
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
    target: StartTarget
    operationId?: string
    handoffId?: string
    resume?: ArchiveResumeOptions
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
        const requestedTarget = await this.validateTarget(input.target)
        if (
          journal &&
          (journal.handoffId !== input.handoffId ||
            journal.sourceId !== input.sourceId ||
            journal.sourceAdapter !== (input.sourceAdapter ?? 'deepseek') ||
            JSON.stringify(journal.requestedTarget ?? journal.target) !==
              JSON.stringify(requestedTarget) ||
            journal.codexHome !== this.home() ||
            JSON.stringify(journal.resume) !== JSON.stringify(input.resume))
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
            const sourceAdapter = input.sourceAdapter ?? 'deepseek'
            const archived =
              isArchiveId(input.sourceId) ||
              (sourceAdapter === 'deepseek' &&
                !input.handoffId &&
                input.resume !== undefined)

            const resolved = archived
              ? await (async () => {
                  await native.init()
                  return resolveArchiveTarget(
                    native,
                    requestedTarget,
                    input.resume?.contextWindow,
                  )
                })()
              : undefined
            const context = resolved
              ? (
                  await this.planArchive(
                    input.sourceId,
                    sourceAdapter,
                    resolved.budget,
                    input.resume,
                  )
                ).context
              : await this.source(
                  input.sourceAdapter ?? 'deepseek',
                  input.sourceId,
                )
            journal = {
              version: 1,
              handoffId: input.handoffId,
              operationId,
              sourceId: input.sourceId,
              sourceAdapter: input.sourceAdapter ?? 'deepseek',
              target: requestedTarget,
              ...(archived || requestedTarget.model === undefined
                ? { requestedTarget }
                : {}),
              context,
              resume: input.resume,
              codexHome: this.home(),
              phase: 'creating',
            }
            await atomicJson(file, journal)
            if (!resolved) await native.init()
            const started = await native.start(
              resolved?.target ?? requestedTarget,
            )
            journal.threadId = started.threadId
            if (journal.requestedTarget) journal.target = started.target
            journal.phase = 'created'
            await atomicJson(file, journal)
          } else {
            await native.init()
            await native.resume(
              journal.threadId!,
              targetSchema.parse(journal.target),
            )
          }
          const target = targetSchema.parse(journal.target)
          const context = validateResumeContext(journal.context)
          if (journal.phase === 'created') {
            journal.phase = 'injecting'
            await atomicJson(file, journal)
            await native.inject(journal.threadId!, context)
            journal.phase = 'injected'
            await atomicJson(file, journal)
          }
          const sessionId = 'codex:' + operationId
          if (journal.phase === 'injected') {
            const event: StoredEvent = isArchiveContext(context)
              ? {
                  seq: 0,
                  type: 'codex/archive-cut',
                  time: Date.now(),
                  cut: await native.savedCutDigest(journal.threadId!, 32),
                }
              : {
                  seq: 0,
                  type: 'codex/snapshot',
                  time: Date.now(),
                  snapshot: z
                    .json()
                    .parse(await native.snapshot(journal.threadId!)),
                }
            journal.phase = 'archiving'
            await atomicJson(file, journal)
            handle = await this.client.create(
              {
                id: sessionId,
                version: 1,
                createdAt: Date.now(),
                isSeeded: false,
                ...(isArchiveContext(context)
                  ? {
                      contextmeshArchive: {
                        id: context.archiveId,
                        digest: context.archiveDigest,
                      },
                    }
                  : { portable: context }),
                sourceDigest: resumeContextDigest(context),
                nativeThreadId: journal.threadId!,
                ...(journal.handoffId ? { handoffId: journal.handoffId } : {}),
                target: z.json().parse(target),
              },
              0,
            )
            await this.client.append(handle, [event], randomUUID())
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
            archiveImport: isArchiveContext(context) ? operationId : undefined,
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
  private async planArchive(
    id: string,
    sourceAdapter: 'codex' | 'deepseek',
    budget: ArchiveBudget,
    resume?: ArchiveResumeOptions,
  ) {
    if (isArchiveId(id))
      return planArchiveResume(
        new ArchiveClient(this.client),
        id,
        budget,
        resume,
      )
    if (sourceAdapter !== 'deepseek')
      throw new Error('Choose a version 2 archive or a saved DSH conversation')
    const source = new MeshClient({
      ...this.options.connection,
      adapter: 'deepseek',
    })
    const view = await DshArchiveView.open(source, id)
    try {
      return await planArchiveResume(view, view.id, budget, resume, true)
    } finally {
      await view.close()
    }
  }
  async previewArchive(
    id: string,
    target: StartTarget,
    resume?: ArchiveResumeOptions,
    sourceAdapter: 'codex' | 'deepseek' = 'codex',
  ) {
    const native = new NativeCodex(this.options.native)
    try {
      await native.init()
      const resolved = await resolveArchiveTarget(
        native,
        await this.validateTarget(target),
        resume?.contextWindow,
      )
      const plan = await this.planArchive(
        id,
        sourceAdapter,
        resolved.budget,
        resume,
      )
      return { ...plan.report, planDigest: plan.digest }
    } finally {
      await native.close()
    }
  }
  private async validateTarget(input: StartTarget) {
    const { realpath, stat } = await import('node:fs/promises')
    const target = startTargetSchema.parse(input),
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
  async importedContextForThread(threadId: string) {
    const directory = join(this.options.stateDir, 'imports')
    const files = await readdir(directory).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const home = resolve(this.home() ?? join(homedir(), '.codex'))
    for (const file of files) {
      if (!file.endsWith('.json')) continue
      const raw = await optionalJson(join(directory, file))
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('threadId' in raw) ||
        raw.threadId !== threadId
      )
        continue
      const journal = journalSchema.parse(raw)
      if (resolve(journal.codexHome ?? join(homedir(), '.codex')) !== home)
        continue
      if (journal.phase !== 'done')
        throw new Error(
          'Finish or reconcile the original Codex import before publishing',
        )
      const binding = await this.status('codex:' + journal.operationId)
      if ('pendingOperationId' in binding && binding.pendingOperationId)
        throw new Error(
          'Finish or reconcile the previous Codex operation before publishing',
        )
      return validateResumeContext(journal.context)
    }
    return undefined
  }
  private async archiveBinding(binding: Binding) {
    if (!binding.archiveImport) return undefined
    const journal = journalSchema.parse(
      await optionalJson(
        join(this.options.stateDir, 'imports', binding.archiveImport + '.json'),
      ),
    )
    const context = validateResumeContext(journal.context)
    if (
      !isArchiveContext(context) ||
      journal.phase !== 'done' ||
      journal.threadId !== binding.threadId
    )
      throw new Error('Imported archive binding is invalid')
    return { context, ceiling: journal.resume?.contextWindow }
  }
  private runSpool(id: string) {
    return new ArchiveSpool(
      join(this.options.stateDir, 'archive-runs', z.uuid().parse(id)),
      this.client.endpoint,
    )
  }
  private async archiveEvent(
    binding: Binding,
    context: ArchiveResumeContext,
    sequence: number,
    turnId?: string,
    expectedCut?: string,
  ) {
    const operationId = binding.pending!
    const spool = this.runSpool(operationId)
    const saved = await captureCodexArchive(
      spool,
      binding.threadId,
      'full',
      this.options.native,
      context,
      turnId,
    )
    const cut = saved.manifest.header.nativeDigest
    if (!cut || (expectedCut && expectedCut !== cut))
      throw new Error(
        'Saved Codex work changed while preparing the archive. Review the previous operation before retrying.',
      )
    const { id } = await spool.upload(new ArchiveClient(this.client))
    const event: StoredEvent = {
      seq: sequence,
      type: 'codex/archive-cut',
      time: Date.now(),
      cut,
      archiveId: id,
      runOperationId: operationId,
    }
    return { event, text: saved.replyText }
  }
  private async lastArchiveCut(handle: RemoteHandle) {
    const read = await this.client.read(
      handle,
      Math.max(0, handle.session.nextSeq - 1),
      1,
    )
    const last = read.events.at(-1)
    if (
      !last ||
      last.type !== 'codex/archive-cut' ||
      typeof last.cut !== 'string'
    )
      throw new Error('The remote Codex archive checkpoint is unavailable')
    return { last, end: read.end }
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
          await native.target(binding.target),
        )
        const archived = await this.archiveBinding(binding)
        const snapshot = archived
          ? undefined
          : await native.snapshot(binding.threadId)
        const localCut = archived
          ? await readCodexCut(binding.threadId, this.options.native)
          : undefined
        const observation = await this.client.stat(id)
        if (
          !observation ||
          observation.incarnation !== binding.incarnation ||
          observation.header.nativeThreadId !== binding.threadId
        )
          throw new Error('Session identity changed; recovery is blocked')
        let prepared: StoredEvent | undefined
        let archivedSequence: number | undefined
        if (archived) {
          const reader = await this.client.open(id, 'read')
          try {
            if (reader.session.incarnation !== binding.incarnation)
              throw new Error('Session identity changed during recovery')
            const prior = await this.lastArchiveCut(reader)
            archivedSequence = prior.end
            if (prior.last.cut !== localCut)
              prepared = (
                await this.archiveEvent(
                  binding,
                  archived.context,
                  prior.end,
                  undefined,
                  localCut,
                )
              ).event
          } finally {
            await this.client.close(reader, randomUUID())
          }
        }
        await this.client.request(
          `/v1/sessions/${encodeURIComponent(id)}/recover`,
          { operationId: randomUUID(), confirmStopped: true, adapter: 'codex' },
        )
        handle = await this.client.open(id, 'write')
        if (handle.session.incarnation !== binding.incarnation)
          throw new Error('Session identity changed during recovery')
        let changed = false
        if (archived) {
          const { end } = await this.lastArchiveCut(handle)
          if (end !== archivedSequence)
            throw new Error('Remote archive history changed during recovery')
          if (prepared) {
            await this.client.append(handle, [prepared], randomUUID())
            changed = true
          }
        } else {
          const cut = await this.client.read(handle, 0, Number.MAX_SAFE_INTEGER)
          const prior = cut.events.findLast((e) => e.type === 'codex/snapshot')
          const current = { turns: snapshot!.turns, items: snapshot!.items }
          const old = prior && nativeSnapshot.parse(prior.snapshot)
          changed =
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
        }
        await this.client.flush(handle, randomUUID())
        await this.client.close(handle, randomUUID())
        handle = undefined
        const finished = binding.pending
        delete binding.pending
        await atomicJson(file, binding)
        if (archived)
          await rm(this.runSpool(finished!).directory, {
            recursive: true,
            force: true,
          }).catch(() => {})
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
          await native.target(binding.target),
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
        const archived = await this.archiveBinding(binding)
        let end: number
        if (archived) {
          if (
            handle.session.header.sourceDigest !==
            resumeContextDigest(archived.context)
          )
            throw new Error('Imported archive digest does not match')
          const prior = await this.lastArchiveCut(handle)
          end = prior.end
          if (
            prior.last.cut !==
            (await readCodexCut(binding.threadId, this.options.native))
          )
            throw new Error(
              'The native Codex thread changed outside ContextMesh; review its saved history before continuing',
            )
          if (!prior.last.archiveId) {
            const budget = await codexArchiveBudget(
              native,
              binding.target,
              archived.ceiling,
            )
            const usage =
              archiveTokenBound([archived.context.messages, message]) +
              96 * archived.context.messages.length
            if (
              usage + budget.fixedTokens + budget.outputReserve + 1024 >
              budget.contextWindow
            )
              throw new Error(
                'The receiving model has insufficient context capacity. Prepare the archive again with a smaller selection.',
              )
          }
        } else {
          if (
            handle.session.header.sourceDigest !==
            contextDigest(validatePortable(handle.session.header.portable))
          )
            throw new Error('Portable archive digest does not match')
          const old = await this.client.read(handle, 0, Number.MAX_SAFE_INTEGER)
          end = old.end
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
        }
        if (lost)
          throw new Error('ContextMesh writer ownership could not be renewed')
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
        let event: StoredEvent
        let text: string
        if (archived) {
          const saved = await this.archiveEvent(
            binding,
            archived.context,
            end,
            turn.id,
          )
          event = saved.event
          text = saved.text
        } else {
          const snapshot = await native.snapshot(binding.threadId)
          event = {
            seq: end,
            runOperationId: binding.pending,
            type: 'codex/snapshot',
            time: Date.now(),
            snapshot: z.json().parse(snapshot),
          }
          text = snapshot.items
            .filter(
              (i) => i.turnId === turn.id && i.item.type === 'agentMessage',
            )
            .map((i) => String(i.item.text))
            .join('\n')
        }
        if (lost)
          throw new Error('ContextMesh writer ownership could not be renewed')
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
        const finished = binding.pending
        delete binding.pending
        await atomicJson(file, binding)
        if (archived)
          await rm(this.runSpool(finished!).directory, {
            recursive: true,
            force: true,
          }).catch(() => {})
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
