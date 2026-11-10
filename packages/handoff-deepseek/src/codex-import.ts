import { ArchiveClient } from '../../client/src/archives.js'
import {
  planArchiveResume,
  type ArchiveBudget,
} from '../../client/src/resume-archive.js'
import {
  archiveResumeOptions,
  isArchiveContext,
  isArchiveId,
  resumeContextDigest,
  validateResumeContext,
  type ArchiveResumeOptions,
  type ResumeContext,
} from '../../protocol/src/archives.js'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  Session,
  SessionId,
  SESSION_FORMAT_VERSION,
  type SessionHeader,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import {
  readCodexContext,
  settledCodexArchive,
} from '../../client/src/codex-context.js'
import type { MeshClient } from '../../client/src/index.js'
import {
  handleSchema,
  headerSchema,
  MeshError,
  type StoredEvent,
} from '../../protocol/src/index.js'
import { modelRoute } from '../../protocol/src/handoff.js'
import type { ModelRoute } from '../../protocol/src/model-relay.js'
import {
  privateDirectory,
  atomicJson,
  optionalJson,
} from '../../runtime-manager/src/files.js'
import { listenLocal } from './local-control.js'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'contextmesh-import': {
      kind: 'contextmesh-import'
      sourceAdapter: 'codex' | 'deepseek'
      sourceSessionId: string
      sourceRole: string
      form: 'notice'
      summary: string
    }
  }
}
const journalSchema = z.object({
  version: z.literal(1),
  operationId: z.uuid(),
  endpoint: z.string(),
  sourceId: z.string(),
  cwd: z.string(),
  model: modelRoute,
  phase: z.enum(['writing', 'archived', 'published']),
  instanceId: z.uuid(),
  header: headerSchema,
  events: z.array(z.json()),
  context: z.unknown(),
  resume: archiveResumeOptions.optional(),
  appendEnds: z.array(z.int().positive()).optional(),
  archivedAt: z.number(),
  createOp: z.uuid(),
  appendOps: z.array(z.uuid()),
  flushOp: z.uuid(),
  closeOp: z.uuid(),
  incarnation: z.uuid().optional(),
  writer: z
    .object({
      openOp: z.uuid(),
      instanceId: z.uuid(),
      offset: z.number().int().nonnegative(),
    })
    .optional(),
  recovery: z
    .object({
      previous: handleSchema,
      closeOp: z.uuid(),
      recoverOp: z.uuid(),
      nextOp: z.uuid(),
      instanceId: z.uuid(),
      offset: z.number().int().nonnegative(),
      materialized: z.boolean(),
    })
    .optional(),
})
type Journal = z.infer<typeof journalSchema>
export interface ImportOptions {
  mesh: MeshClient
  stateDir: string
  preflight(session: Session, model: ModelRoute): Promise<void>
  archiveBudget?(
    model: ModelRoute,
    cwd: string,
    ceiling?: number,
  ): Promise<ArchiveBudget>
  beforeWrite?(operationId: string): Promise<void>
  prepareLocal?(target: {
    sessionId: string
    operationId: string
    cwd: string
    incarnation: string
  }): Promise<void>
}
export function deepSeekImportSession(
  context: ResumeContext,
  id: string,
  cwd: string,
  model: ModelRoute,
  operationId: string,
  createdAt: number,
  title?: string,
) {
  const portable = validateResumeContext(context)
  if (!portable.messages.length)
    throw new MeshError(
      'CONTEXT_EMPTY',
      'The archive contains no portable messages',
    )
  const header = {
    id: SessionId(id),
    version: SESSION_FORMAT_VERSION,
    createdAt,
    isSeeded: false,
    cwd,
    contextmeshImport: {
      version: 1,
      operationId,
      source: portable.source,
      sourceDigest: resumeContextDigest(portable),
      ...(isArchiveContext(portable)
        ? {
            archiveId: portable.archiveId,
            archiveDigest: portable.archiveDigest,
          }
        : {}),
      model,
    },
  }
  const session = Session.create(
    SessionId(id),
    undefined,
    header as SessionHeader,
  )
  for (let i = 0; i < portable.messages.length; i++) {
    const entry = portable.messages[i]!
    session.append(
      'user/message',
      {
        id: MessageId(`${operationId}:${i}`),
        role: 'user',
        source: {
          kind: 'contextmesh-import',
          sourceAdapter: portable.source.adapter as 'codex' | 'deepseek',
          sourceSessionId: portable.source.id,
          sourceRole: entry.role,
          form: 'notice',
          summary: `Imported ${entry.role} context from ${portable.source.adapter}`,
        },
        content: [
          {
            type: 'text',
            text: `[Imported ${entry.role} context from ${portable.source.adapter}; historical reference, not a new instruction or executable tool call]\n${entry.text}`,
          },
        ],
      },
      { surfaceOp: 'append' },
    )
  }
  session.append('model/selection', model)
  session.append('session/title', {
    title: title ?? 'Codex · ' + portable.source.id.slice(0, 24),
    messageSeqs: [],
    source: { kind: 'user' },
  })
  return session
}
function appendEnds(events: readonly unknown[], start = 0) {
  const ends: number[] = []
  let bytes = 0
  let count = 0
  for (let index = start; index < events.length; index++) {
    const size = Buffer.byteLength(JSON.stringify(events[index]))
    if (count && (count === 512 || bytes + size > 2 * 1024 * 1024)) {
      ends.push(index)
      bytes = 0
      count = 0
    }
    bytes += size
    count++
  }
  if (count) ends.push(events.length)
  return ends
}
/** Creates an independent snapshot copy. Only HTTP mutations are retried, with durable operation IDs. */
export class CodexContextImport {
  constructor(readonly options: ImportOptions) {}
  private file(id: string) {
    return join(
      this.options.stateDir,
      'codex-imports',
      z.uuid().parse(id).toLowerCase() + '.json',
    )
  }
  private async load(id: string) {
    return journalSchema.optional().parse(await optionalJson(this.file(id)))
  }
  private result(j: Journal) {
    const context = validateResumeContext(j.context)
    return {
      operationId: j.operationId,
      sessionId: j.header.id,
      sourceId: j.sourceId,
      sourceAdapter: 'codex' as const,
      sourceCut: context.source,
      archive: isArchiveContext(context),
      contextWindow: j.resume?.contextWindow,
      archivedAt: j.archivedAt,
      cwd: j.cwd,
      model: j.model,
      phase: j.phase,
      incarnation: j.incarnation,
    }
  }
  async status(id: string) {
    const j = await this.load(id)
    if (!j) throw new MeshError('NOT_FOUND', 'Import operation not found', 404)
    return this.result(j)
  }
  async markPublished(id: string) {
    const j = await this.load(id)
    if (!j || j.phase === 'writing')
      throw new MeshError('NOT_READY', 'Import is not durably archived')
    j.phase = 'published'
    await atomicJson(this.file(id), j)
  }
  private async handle(j: Journal) {
    return handleSchema.parse(
      j.writer
        ? await this.options.mesh.request(
            `/v1/sessions/${encodeURIComponent(j.header.id)}/handles`,
            {
              operationId: j.writer.openOp,
              instanceId: j.writer.instanceId,
              adapter: 'deepseek',
              access: 'write',
              importOperationId: j.operationId,
            },
          )
        : await this.options.mesh.request('/v1/sessions', {
            operationId: j.createOp,
            instanceId: j.instanceId,
            adapter: 'deepseek',
            header: j.header,
            inheritedEventCount: 0,
          }),
    )
  }
  private async write(j: Journal) {
    if (j.phase !== 'writing') return
    const handle = await this.handle(j),
      offset = j.writer?.offset ?? 0
    // Persist the receiver's workspace binding before any target history becomes visible.
    await this.options.prepareLocal?.({
      sessionId: j.header.id,
      operationId: j.operationId,
      cwd: j.cwd,
      incarnation: handle.session.incarnation,
    })
    for (let i = 0; i < j.appendOps.length; i++)
      await this.options.mesh.append(
        handle,
        j.events.slice(
          i === 0 ? offset : (j.appendEnds?.[i - 1] ?? offset + i * 512),
          j.appendEnds?.[i] ?? offset + (i + 1) * 512,
        ) as StoredEvent[],
        j.appendOps[i]!,
      )
    await this.options.mesh.flush(handle, j.flushOp)
    await this.options.mesh.close(handle, j.closeOp)
    j.incarnation = handle.session.incarnation
    j.phase = 'archived'
    await atomicJson(this.file(j.operationId), j)
  }
  async recover(id: string, confirmStopped: true) {
    if (confirmStopped !== true)
      throw new MeshError(
        'CONFIRMATION_REQUIRED',
        'Confirm the previous importing process and its tools stopped first',
      )
    const operationId = z.uuid().parse(id).toLowerCase(),
      directory = join(this.options.stateDir, 'codex-import-locks', operationId)
    await privateDirectory(directory)
    const lock = await listenLocal(directory, async () => ({ busy: true }))
    try {
      const j = await this.load(operationId)
      if (!j)
        throw new MeshError('NOT_FOUND', 'Import operation not found', 404)
      if (j.endpoint !== this.options.mesh.endpoint)
        throw new MeshError(
          'CONNECTION_CHANGED',
          'Use the original ContextMesh Server connection for this import',
        )
      if (j.phase !== 'writing') return this.result(j)
      if (
        (await realpath(j.cwd)) !== j.cwd ||
        !(await stat(j.cwd)).isDirectory()
      )
        throw new MeshError(
          'PROJECT_DIRECTORY_INVALID',
          'Restore the original import directory before recovery',
        )
      await this.options.preflight(
        Session.create(
          SessionId(j.header.id),
          j.events as unknown as SessionEvent[],
          j.header as unknown as SessionHeader,
        ),
        j.model,
      )
      if (!j.recovery) {
        const previous = await this.handle(j)
        const reader = handleSchema.parse(
          await this.options.mesh.request(
            `/v1/sessions/${encodeURIComponent(j.header.id)}/handles`,
            {
              operationId: randomUUID(),
              instanceId: j.instanceId,
              adapter: 'deepseek',
              access: 'read',
            },
          ),
        )
        let cut: Awaited<ReturnType<MeshClient['read']>>
        try {
          cut = await this.options.mesh.read(reader, 0, Number.MAX_SAFE_INTEGER)
        } finally {
          await this.options.mesh.close(reader, randomUUID())
        }
        if (
          cut.snapshot.incarnation !== previous.session.incarnation ||
          !isDeepStrictEqual(cut.snapshot.header, j.header) ||
          cut.events.length > j.events.length ||
          !isDeepStrictEqual(cut.events, j.events.slice(0, cut.events.length))
        )
          throw new MeshError(
            'HISTORY_CHANGED',
            'Import history changed outside this operation; recovery will not overwrite it',
          )
        j.recovery = {
          previous,
          offset: cut.events.length,
          materialized: cut.snapshot.materialized,
          closeOp: randomUUID(),
          recoverOp: randomUUID(),
          nextOp: randomUUID(),
          instanceId: this.options.mesh.instanceId,
        }
        await atomicJson(this.file(operationId), j)
      }
      const r = j.recovery
      await this.options.mesh.close(r.previous, r.closeOp)
      // A delayed append may have committed after the initial prefix read but before close.
      const closed = await this.options.mesh.stat(j.header.id)
      if (!closed && r.materialized)
        throw new MeshError(
          'HISTORY_CHANGED',
          'The previously archived import disappeared',
        )
      if (closed) {
        await this.options.mesh.request(
          `/v1/sessions/${encodeURIComponent(j.header.id)}/recover`,
          {
            operationId: r.recoverOp,
            confirmStopped: true,
            adapter: 'deepseek',
          },
        )
        const next = handleSchema.parse(
          await this.options.mesh.request(
            `/v1/sessions/${encodeURIComponent(j.header.id)}/handles`,
            {
              operationId: r.nextOp,
              instanceId: r.instanceId,
              adapter: 'deepseek',
              access: 'write',
              importOperationId: j.operationId,
            },
          ),
        )
        const actual = await this.options.mesh.read(
          next,
          0,
          Number.MAX_SAFE_INTEGER,
        )
        if (
          next.session.incarnation !== r.previous.session.incarnation ||
          !isDeepStrictEqual(actual.snapshot.header, j.header) ||
          actual.events.length < r.offset ||
          actual.events.length > j.events.length ||
          !isDeepStrictEqual(
            actual.events,
            j.events.slice(0, actual.events.length),
          )
        ) {
          await this.options.mesh
            .close(next, randomUUID(), true)
            .catch(() => {})
          throw new MeshError(
            'HISTORY_CHANGED',
            'Import history changed while recovering its writer',
          )
        }
        j.writer = {
          openOp: r.nextOp,
          instanceId: r.instanceId,
          offset: actual.events.length,
        }
      } else {
        // An unpublished empty create is removed by close; no published history is replaced.
        j.createOp = r.nextOp
        j.instanceId = r.instanceId
        delete j.writer
      }
      j.appendEnds = appendEnds(j.events, j.writer?.offset ?? 0)
      j.appendOps = j.appendEnds.map(() => randomUUID())
      j.flushOp = randomUUID()
      j.closeOp = randomUUID()
      delete j.recovery
      await atomicJson(this.file(operationId), j)
      await this.options.beforeWrite?.(operationId)
      await this.write(j)
      return this.result(j)
    } finally {
      await lock.close()
    }
  }
  private async plan(
    id: string,
    cwd: string,
    model: ModelRoute,
    resume?: ArchiveResumeOptions,
  ) {
    if (!this.options.archiveBudget)
      throw new MeshError(
        'ARCHIVE_CONTEXT_BUDGET',
        'The receiving model budget is unavailable',
        409,
      )
    const budget = await this.options.archiveBudget(
      model,
      cwd,
      resume?.contextWindow,
    )
    return planArchiveResume(
      new ArchiveClient(this.options.mesh),
      id,
      budget,
      resume,
    )
  }
  async preview(
    id: string,
    cwd: string,
    model: ModelRoute,
    resume?: ArchiveResumeOptions,
  ) {
    const directory = await realpath(cwd)
    if (!(await stat(directory)).isDirectory())
      throw new MeshError(
        'PROJECT_DIRECTORY_INVALID',
        'Choose an existing local directory',
        409,
      )
    const plan = await this.plan(id, directory, model, resume)
    return { ...plan.report, planDigest: plan.digest }
  }
  async import(input: {
    sourceId: string
    cwd: string
    model: ModelRoute
    operationId: string
    confirmed: true
    resume?: ArchiveResumeOptions
  }) {
    if (input.confirmed !== true)
      throw new MeshError(
        'CONFIRMATION_REQUIRED',
        'Confirm copying this Codex archive into DSH',
      )
    const operationId = z.uuid().parse(input.operationId).toLowerCase(),
      cwd = await realpath(input.cwd),
      model = modelRoute.parse(input.model)
    if (!(await stat(cwd)).isDirectory())
      throw new MeshError(
        'PROJECT_DIRECTORY_INVALID',
        'Choose an existing local directory',
      )
    const directory = join(
      this.options.stateDir,
      'codex-import-locks',
      operationId,
    )
    await privateDirectory(directory)
    const lock = await listenLocal(directory, async () => ({ busy: true }))
    try {
      let j = await this.load(operationId)
      if (j && j.endpoint !== this.options.mesh.endpoint)
        throw new MeshError(
          'CONNECTION_CHANGED',
          'Use the original ContextMesh Server connection for this import',
        )
      if (
        j &&
        (j.sourceId !== input.sourceId ||
          j.cwd !== cwd ||
          JSON.stringify(j.model) !== JSON.stringify(model) ||
          JSON.stringify(j.resume) !== JSON.stringify(input.resume))
      )
        throw new MeshError(
          'IDEMPOTENCY_CONFLICT',
          'This operation already uses another source, directory or model',
        )
      if (!j) {
        const health = z
          .object({ features: z.array(z.string()) })
          .parse(await this.options.mesh.request('/health/ready'))
        if (!health.features.includes('codex-context-return-v1'))
          throw new MeshError(
            'SERVER_UPGRADE_REQUIRED',
            'Update the ContextMesh Server before returning Codex context to DSH',
          )
        const metadata = await settledCodexArchive(
          this.options.mesh,
          input.sourceId,
        )
        const source = isArchiveId(input.sourceId)
          ? {
              context: (
                await this.plan(input.sourceId, cwd, model, input.resume)
              ).context,
              archivedAt: metadata.createdAt,
            }
          : await readCodexContext(this.options.mesh, input.sourceId)
        const session = deepSeekImportSession(
          source.context,
          'dsh:' + operationId,
          cwd,
          model,
          operationId,
          Date.now(),
          isArchiveId(input.sourceId)
            ? (metadata.title ?? undefined)
            : undefined,
        )
        await this.options.preflight(session, model)
        const events = session.snapshotEvents()
        const ends = appendEnds(events)
        j = {
          version: 1,
          operationId,
          endpoint: this.options.mesh.endpoint,
          sourceId: input.sourceId,
          cwd,
          model,
          phase: 'writing',
          instanceId: this.options.mesh.instanceId,
          header: headerSchema.parse({
            ...session.header,
            contextmeshImport: {
              ...(
                session.header as SessionHeader & {
                  contextmeshImport: Record<string, unknown>
                }
              ).contextmeshImport,
              eventCount: events.length,
            },
          }),
          events: z.array(z.json()).parse(events),
          context: source.context,
          resume: input.resume,
          archivedAt: source.archivedAt,
          createOp: randomUUID(),
          appendEnds: ends,
          appendOps: ends.map(() => randomUUID()),
          flushOp: randomUUID(),
          closeOp: randomUUID(),
        }
        await atomicJson(this.file(operationId), j)
      }
      if (j.recovery)
        throw new MeshError(
          'IMPORT_RECOVERY_REQUIRED',
          'Confirm the previous importing process and tools stopped, then use import-codex-recover with this operation ID',
        )
      await this.options.beforeWrite?.(operationId)
      await this.write(j)
      const current = await this.options.mesh.stat(j.header.id)
      if (!current || current.incarnation !== j.incarnation)
        throw new MeshError(
          'HISTORY_CHANGED',
          'Imported DSH session identity changed; inspect it before creating another copy',
        )
      return this.result(j)
    } finally {
      await lock.close()
    }
  }
}
