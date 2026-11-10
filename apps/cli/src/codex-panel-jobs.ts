import { captureCodexArchive } from '../../../packages/adapter-codex/src/archive-export.js'
import { CodexSharedSync } from '../../../packages/adapter-codex/src/shared-sync.js'
import { callLocal } from '../../../packages/handoff-deepseek/src/local-control.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { ArchiveSpool } from '../../../packages/adapter-codex/src/archive-spool.js'
import { ArchiveClient } from '../../../packages/client/src/archives.js'
import {
  archiveFeature,
  archiveResumeOptions,
} from '../../../packages/protocol/src/archives.js'
import { readdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  CodexBridge,
  type BridgeOptions,
} from '../../../packages/adapter-codex/src/bridge.js'
import {
  CodexArchiveTextFallback,
  NativeCodex,
  startTargetSchema,
} from '../../../packages/adapter-codex/src/native.js'
import { ConfirmedCodexTakeover } from '../../../packages/adapter-codex/src/takeover.js'
import { listenLocal } from '../../../packages/handoff-deepseek/src/local-control.js'
import {
  HandoffClient,
  type remoteSessionSchema,
} from '../../../packages/client/src/handoff.js'
import {
  codexArchives,
  settledCodexArchive,
} from '../../../packages/client/src/codex-context.js'
import {
  atomicJson,
  optionalJson,
  privateDirectory,
} from '../../../packages/runtime-manager/src/files.js'
import {
  codexArchiveScope,
  type CodexArchiveScope,
} from '../../../packages/protocol/src/codex-context.js'
import { nativeId } from '../../../packages/protocol/src/index.js'

const transferTitle = z.string().trim().min(1).max(160).optional()

const receiveAction = z
  .object({
    sourceId: nativeId,
    target: startTargetSchema.refine((value) => isAbsolute(value.cwd)),
    title: transferTitle,
    confirmed: z.literal(true),
  })
  .strict()

export const confirmedAction = z.discriminatedUnion('kind', [
  receiveAction.extend({ kind: z.literal('takeover') }),
  receiveAction.extend({
    kind: z.literal('import'),
    sourceAdapter: z.enum(['deepseek', 'codex']),
    resume: archiveResumeOptions.optional(),
  }),
  z
    .object({
      kind: z.literal('publish'),
      threadId: z.uuid(),
      title: transferTitle,
      scope: codexArchiveScope.optional(),
      captureId: z.uuid().optional(),
      confirmed: z.literal(true),
    })
    .strict(),
])

function sessionStatus(session: z.infer<typeof remoteSessionSchema>) {
  if (session.successorSessionId) return 'transferred'
  if (session.recoveryRequired || session.handoffState === 'recovery_required')
    return 'recovery'
  if (
    session.handoffId &&
    !['completed', 'cancelled', 'failed'].includes(session.handoffState ?? '')
  )
    return 'busy'
  if (!session.nextSeq) return 'empty'
  return session.activeNodeId ? 'takeover' : 'import'
}

type Action = z.infer<typeof confirmedAction>
const jobSchema = z.object({
  id: z.uuid(),
  action: confirmedAction,
  createdAt: z.number(),
  state: z.enum(['queued', 'running', 'completed', 'failed', 'attention']),
  message: z.string(),
  suggestion: z.literal('publish-text').optional(),
  pid: z.number().int().positive().optional(),
  threadId: z.uuid().optional(),
  archiveId: z.string().optional(),
  progress: z.object({ sent: z.number(), total: z.number() }).optional(),
})
type Job = z.infer<typeof jobSchema>

export class CodexPanelJobs {
  readonly shared: CodexSharedSync
  readonly bridge: CodexBridge
  private readonly directory: string
  readonly archives: ArchiveClient
  constructor(readonly options: BridgeOptions & { deviceId?: string }) {
    this.shared = new CodexSharedSync(options)
    this.bridge = new CodexBridge(options)
    this.archives = new ArchiveClient(this.bridge.client)
    this.directory = join(options.stateDir, 'panel-jobs')
  }
  async startSync() {
    if (
      !(await this.shared.sources()).length &&
      !(await this.shared.followers.list()).length
    )
      return
    try {
      await callLocal(join(this.shared.directory, 'worker'), {}, 500)
      return
    } catch {}
    const worker = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, 'codex', 'sync-worker'],
      { detached: true, stdio: 'ignore' },
    )
    await new Promise<void>((resolve, reject) => {
      worker.once('spawn', resolve)
      worker.once('error', reject)
    })
    worker.unref()
  }
  private path(id: string) {
    return join(this.directory, z.uuid().parse(id) + '.json')
  }
  private requireConnection() {
    if (!this.options.connection.token)
      throw new Error(
        'Connect this device to the ContextMesh Server with contextmesh setup, then reopen the panel.',
      )
  }
  async checkConnection() {
    this.requireConnection()
    await this.bridge.client.request(
      '/health/ready',
      undefined,
      AbortSignal.timeout(3500),
    )
    return { connected: true }
  }
  async catalog() {
    this.requireConnection()
    const { features = [] } = await this.bridge.client.capabilities()
    const [sessions, archives] = await Promise.all([
      new HandoffClient(this.bridge.client, '').sessions(),
      codexArchives(this.bridge.client, features),
    ])
    return {
      publishAvailable:
        features.includes(archiveFeature) ||
        features.includes('codex-gui-archive-v1'),
      chunkedArchives: features.includes(archiveFeature),
      takeoverAvailable: features.includes('cross-agent-takeover-v1'),
      importAvailable: features.includes('native-agent-storage-v1'),
      sessions: [
        ...sessions.map((session) => ({
          id: session.id,
          title: session.title,
          activeNodeName: session.activeNodeName,
          adapter: 'deepseek',
          status: sessionStatus(session),
        })),
        ...archives.map((archive) => ({
          id: archive.id,
          title: archive.title,
          format: archive.format,
          bytes: archive.bytes,
          activeNodeName: null,
          adapter: 'codex',
          status: archive.recoveryRequired
            ? 'recovery'
            : archive.busy
              ? 'busy'
              : !archive.nextSeq
                ? 'empty'
                : 'import',
        })),
      ],
    }
  }
  async localChoices() {
    const native = new NativeCodex(this.options.native)
    try {
      await native.init()
      return { threads: await native.savedThreads() }
    } finally {
      await native.close()
    }
  }
  async list() {
    const files = await readdir(this.directory).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    await Promise.all(
      files
        .filter((name) => z.uuid().safeParse(name).success)
        .map(async (id) => {
          const age = await stat(this.spool(id).directory).catch(
            () => undefined,
          )
          if (age && Date.now() - age.mtimeMs > 24 * 60 * 60 * 1000)
            await this.discardCapture(id).catch(() => {})
        }),
    )
    const jobs = await Promise.all(
      files
        .filter(
          (file) =>
            z.uuid().safeParse(file.slice(0, -5)).success &&
            file.endsWith('.json'),
        )
        .map((file) => this.read(file.slice(0, -5))),
    )
    return jobs.sort((a, b) => b.createdAt - a.createdAt).slice(0, 25)
  }
  private async read(id: string): Promise<Job> {
    const job = jobSchema.parse(await optionalJson(this.path(id)))
    // Older installed runtimes only recorded the recovery hint in the message.
    if (
      !job.suggestion &&
      job.state === 'failed' &&
      job.action.kind === 'publish' &&
      job.action.scope !== 'text' &&
      (job.message === 'Native snapshot exceeds the archive limit' ||
        job.message.endsWith(
          'Choose Conversation text only to share the saved conversation.',
        ))
    )
      return { ...job, suggestion: 'publish-text' }
    if (job.state === 'running' && job.pid) {
      try {
        process.kill(job.pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH')
          return {
            ...job,
            state: 'attention',
            message:
              'Worker stopped before recording a result. Inspect the operation before starting another takeover.',
          }
      }
    }
    if (job.state === 'queued' && Date.now() - job.createdAt > 30000)
      return {
        ...job,
        state: 'attention',
        message:
          'No worker result was received. Inspect this operation before retrying.',
      }
    return job
  }
  async enqueue(value: Action) {
    this.requireConnection()
    const action = confirmedAction.parse(value)
    const capture = action.kind === 'publish' ? action.captureId : undefined
    const job: Job = {
      id: capture ?? randomUUID(),
      action,
      createdAt: Date.now(),
      state: 'queued',
      message: 'Waiting for the local worker…',
    }
    if (capture && action.kind === 'publish') {
      const accepted = await this.withCaptureLock(capture, async () => {
        const prior = jobSchema
          .optional()
          .parse(await optionalJson(this.path(capture)))
        if (prior) {
          if (JSON.stringify(prior.action) !== JSON.stringify(action))
            throw new Error(
              'This prepared archive was already confirmed with different settings',
            )
          return false
        }
        const saved = await this.spool(capture).saved()
        if (
          !saved ||
          saved.manifest.header.source.id !== action.threadId ||
          saved.manifest.header.scope !== (action.scope ?? 'full')
        )
          throw new Error(
            'Review the conversation and archive contents again before publishing',
          )
        await atomicJson(this.path(job.id), job)
        return true
      })
      if (!accepted) return { id: capture }
    } else await atomicJson(this.path(job.id), job)
    return this.startWorker(job)
  }
  private async withCaptureLock<T>(id: string, work: () => Promise<T>) {
    const directory = join(
      this.directory,
      z.uuid().parse(id),
      'capture-control',
    )
    await privateDirectory(directory)
    const lock = await listenLocal(directory, async () => ({ busy: true }))
    try {
      return await work()
    } finally {
      await lock.close()
    }
  }
  async retryPublish(id: string) {
    const job = await this.read(id)
    if (
      job.action.kind !== 'publish' ||
      !['attention', 'failed'].includes(job.state)
    )
      throw new Error('This publication cannot be retried right now')
    return this.startWorker(job)
  }
  private async startWorker(job: Job) {
    const worker = spawn(
      process.execPath,
      [...process.execArgv, process.argv[1]!, 'codex', 'panel-worker', job.id],
      { detached: true, stdio: 'ignore' },
    )
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('spawn', resolve)
        worker.once('error', reject)
      })
      worker.unref()
    } catch {
      await atomicJson(this.path(job.id), {
        ...job,
        state: 'failed',
        message: 'The local worker could not start.',
      })
    }
    return { id: job.id }
  }
  async run(id: string) {
    const file = this.path(id)
    const directory = join(this.directory, id)
    await privateDirectory(directory)
    const lock = await listenLocal(directory, async () => ({ busy: true }))
    try {
      await this.runJob(file, id)
    } finally {
      await lock.close()
    }
  }
  private async runJob(file: string, id: string) {
    const job = await this.read(id)
    if (
      job.state !== 'queued' &&
      !(
        job.action.kind === 'publish' &&
        ['failed', 'attention'].includes(job.state)
      )
    )
      throw new Error('This panel operation has already started')
    job.state = 'running'
    delete job.suggestion
    job.message =
      job.action.kind === 'takeover'
        ? 'Checking the receiver and transferring the task…'
        : 'Reading the saved conversation…'
    job.pid = process.pid
    await atomicJson(file, job)
    try {
      if (job.action.kind === 'takeover') {
        const result = await new ConfirmedCodexTakeover(this.options).takeover({
          ...job.action,
          operationId: id,
        })
        const target = result.handoff.targetSessionId
        if (!target) throw new Error('No local Codex thread was linked')
        const binding = await this.bridge.status(target)
        job.threadId = z.uuid().parse(binding.threadId)
        job.state =
          result.handoff.executionState === 'failed' ? 'failed' : 'completed'
        job.message =
          job.state === 'completed'
            ? 'The task is available in Codex.'
            : 'Ownership transferred. The continued turn failed. Open the Codex thread to review it.'
      } else if (job.action.kind === 'import') {
        const { sourceAdapter, sourceId, target } = job.action
        if (sourceAdapter === 'codex') {
          await settledCodexArchive(this.bridge.client, sourceId)
        } else {
          const sessions = await new HandoffClient(
            this.bridge.client,
            '',
          ).sessions()
          const source = sessions.find((session) => session.id === sourceId)
          if (!source || sessionStatus(source) !== 'import')
            throw new Error(
              'This session is no longer available to import. Refresh the list to see its current status.',
            )
        }
        const result = await this.bridge.import({
          sourceAdapter,
          sourceId,
          target,
          resume: job.action.resume,
          operationId: id,
        })
        job.threadId = z.uuid().parse(result.threadId)
        job.state = 'completed'
        job.message =
          'Imported into a new Codex conversation. Open it to send your next message.'
      } else {
        const { threadId, scope } = job.action
        const spool = this.spool(id)
        if ((await spool.saved()) || (await this.archives.supported())) {
          if (job.action.captureId && !(await spool.saved()))
            throw new Error(
              'Review the conversation again to prepare a new copy',
            )
          const result = await this.publishChunked(
            threadId,
            id,
            scope,
            async (sent, total) => {
              if (
                sent === total ||
                !job.progress ||
                sent - job.progress.sent >= Math.max(1, Math.floor(total / 20))
              ) {
                job.progress = { sent, total }
                job.message = `Uploading archive blocks (${sent}/${total})…`
                await atomicJson(file, job)
              }
            },
          )
          job.archiveId = result.id
        } else {
          job.archiveId = (await this.publish(threadId, id, scope)).id
        }
        job.state = 'completed'
        job.message =
          scope === 'text'
            ? 'Published conversation text. Open this archive in ContextMesh on the receiving device.'
            : 'Published. Open this archive in ContextMesh on the receiving device with a compatible agent.'
      }
    } catch (error) {
      job.state = job.action.kind === 'publish' ? 'failed' : 'attention'
      if (
        job.action.kind === 'publish' &&
        error instanceof CodexArchiveTextFallback
      )
        job.suggestion = 'publish-text'
      job.message = (
        error instanceof Error ? error.message : 'The operation did not finish.'
      ).slice(0, 500)
    }
    delete job.pid
    await atomicJson(file, job)
    if (job.state === 'completed' && job.action.kind === 'publish')
      await rm(this.spool(id).directory, {
        recursive: true,
        force: true,
      }).catch(() => {})
  }
  private spool(id: string) {
    return new ArchiveSpool(
      join(this.directory, z.uuid().parse(id), 'archive'),
      this.bridge.client.endpoint,
    )
  }
  async discardCapture(id: string) {
    return this.withCaptureLock(id, async () => {
      if (!(await optionalJson(this.path(id))))
        await rm(this.spool(id).directory, { recursive: true, force: true })
      return {}
    })
  }
  async preparePublish(threadId: string, scope: CodexArchiveScope) {
    if (!(await this.archives.supported())) return null
    const id = randomUUID()
    try {
      const { manifest } = await this.capture(threadId, id, scope)
      return {
        id,
        bytes: manifest.bytes,
        records: manifest.records,
        omittedAttachments: manifest.header.omittedAttachments,
        unrecognizedItems: manifest.header.unrecognizedItems,
        interrupted: manifest.header.interrupted,
      }
    } catch (error) {
      await this.discardCapture(id)
      throw error
    }
  }
  private async capture(
    threadId: string,
    id: string,
    scope: CodexArchiveScope,
  ) {
    const spool = this.spool(id)
    const saved = await spool.saved()
    if (saved) return captureCodexArchive(spool, threadId, scope)
    const inherited = await this.bridge.importedContextForThread(threadId)
    return captureCodexArchive(
      spool,
      threadId,
      scope,
      this.options.native,
      inherited,
    )
  }
  async publishChunked(
    threadId: string,
    operationId: string,
    scope: CodexArchiveScope = 'full',
    progress?: (sent: number, total: number) => Promise<void>,
  ) {
    await this.capture(threadId, operationId, scope)
    return this.spool(operationId).upload(this.archives, progress)
  }
  async publish(
    threadId: string,
    operationId: string,
    scope: CodexArchiveScope = 'full',
  ) {
    if (
      !(await this.bridge.client.capabilities()).features?.includes(
        'codex-gui-archive-v1',
      )
    )
      throw new Error(
        'Upgrade the ContextMesh Server to publish Codex desktop snapshots',
      )
    const native = new NativeCodex(this.options.native)
    try {
      await native.init()
      const imported = await this.bridge.importedContextForThread(threadId)
      const { thread, context } = await native.savedArchive(
        threadId,
        imported?.messages ?? [],
        scope,
      )
      const title = [thread.name, thread.preview]
        .find(
          (value): value is string =>
            typeof value === 'string' && Boolean(value.trim()),
        )
        ?.trim()
        .slice(0, 160)
      return z.object({ id: z.string() }).parse(
        await this.bridge.client.request('/v1/codex-archives', {
          operationId,
          nativeThreadId: threadId,
          cliVersion: thread.cliVersion,
          title,
          context,
        }),
      )
    } finally {
      await native.close()
    }
  }
  async open(id: string) {
    const job = await this.read(id)
    if (!job.threadId || !['completed', 'failed'].includes(job.state))
      throw new Error('The Codex thread is not available yet')
    const url = 'codex://threads/' + job.threadId
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' })
      child.once('error', reject)
      child.once('exit', (code) =>
        code === 0
          ? resolve()
          : reject(new Error('Could not open the Codex thread')),
      )
    })
    return { opened: true }
  }
}
