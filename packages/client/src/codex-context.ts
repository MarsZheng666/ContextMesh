import { ArchiveClient } from './archives.js'
import {
  archiveFeature,
  isArchiveId,
  type ArchiveInfo,
} from '../../protocol/src/archives.js'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { MeshClient } from './index.js'
import { handleSchema, MeshError } from '../../protocol/src/index.js'
import { validatePortable, contextDigest } from '../../protocol/src/portable.js'
import {
  nativeSnapshot,
  extendCodexContext,
} from '../../protocol/src/codex-context.js'

/** Read the last complete native snapshot at open time, without collecting every older full snapshot. */
export async function readCodexContext(
  client: MeshClient,
  id: string,
  signal?: AbortSignal,
) {
  const handle = handleSchema.parse(
    await client.request(
      `/v1/sessions/${encodeURIComponent(id)}/handles`,
      {
        operationId: randomUUID(),
        instanceId: client.instanceId,
        adapter: 'codex',
        access: 'read',
      },
      signal,
    ),
  )
  try {
    if (
      handle.session.header.version !== 1 ||
      handle.session.adapter !== 'codex'
    )
      throw new MeshError(
        'FORMAT_UNSUPPORTED',
        'Unsupported Codex storage envelope',
      )
    const base = validatePortable(handle.session.header.portable)
    if (contextDigest(base) !== handle.session.header.sourceDigest)
      throw new MeshError('CORRUPTION', 'Portable source digest does not match')
    const offset = handle.session.nextSeq - 1
    if (offset < 0)
      throw new MeshError(
        'NOT_READY',
        'No complete Codex snapshot has been archived',
      )
    const read = await client.read(handle, offset, 1, signal),
      event = read.events[0]
    if (!event || event.type !== 'codex/snapshot')
      throw new MeshError(
        'FORMAT_UNSUPPORTED',
        'The last Codex archive entry is not a supported native snapshot',
      )
    const native = nativeSnapshot.parse(event.snapshot)
    if (native.thread.id !== handle.session.header.nativeThreadId)
      throw new MeshError(
        'CORRUPTION',
        'Codex native thread identity does not match its archive',
      )
    const context = validatePortable({
      ...extendCodexContext(base, native),
      source: {
        adapter: 'codex',
        id,
        incarnation: handle.session.incarnation,
        eventCount: event.seq + 1,
      },
    })
    return { context, archivedAt: event.time, nativeThreadId: native.thread.id }
  } finally {
    await client.close(handle, randomUUID())
  }
}

export const codexArchiveSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  incarnation: z.uuid(),
  nextSeq: z.number().int().nonnegative(),
  createdAt: z.number(),
  busy: z.boolean(),
  recoveryRequired: z.boolean(),
  format: z.literal(2).optional(),
  bytes: z.number().optional(),
})
function chunkedSummary(info: ArchiveInfo): z.infer<typeof codexArchiveSchema> {
  return {
    id: info.id,
    title: info.manifest.header.title,
    incarnation: info.manifest.header.source.incarnation,
    nextSeq: info.manifest.records,
    createdAt: info.createdAt,
    busy: false,
    recoveryRequired: false,
    format: 2,
    bytes: info.manifest.bytes,
  }
}
async function listChunkedArchives(client: ArchiveClient) {
  const rows: ArchiveInfo[] = []
  const cursors = new Set<string>()
  let after: string | undefined
  do {
    const page = await client.list(after)
    rows.push(...page.archives)
    after = page.next ?? undefined
    if (after && cursors.has(after))
      throw new Error('Archive catalog cursor did not advance')
    if (after) cursors.add(after)
  } while (after)
  return rows
}
export async function codexArchives(client: MeshClient, advertised?: string[]) {
  const features = advertised ?? (await client.capabilities()).features ?? []
  const [legacy, chunked] = await Promise.all([
    features.includes('codex-context-return-v1')
      ? client
          .request('/v1/codex-archives')
          .then((value) => z.array(codexArchiveSchema).parse(value))
      : [],
    features.includes(archiveFeature)
      ? listChunkedArchives(new ArchiveClient(client))
      : [],
  ])
  return [...legacy, ...chunked.map(chunkedSummary)].sort(
    (a, b) => b.createdAt - a.createdAt,
  )
}
export async function settledCodexArchive(client: MeshClient, id: string) {
  if (isArchiveId(id))
    return chunkedSummary(await new ArchiveClient(client).info(id))
  const row = codexArchiveSchema.parse(
    await client.request('/v1/codex-archives/' + encodeURIComponent(id)),
  )
  if (row.busy || row.recoveryRequired)
    throw new MeshError(
      'CODEX_SOURCE_NOT_SETTLED',
      'Finish or reconcile the source Codex operation before importing; no source process was stopped',
    )
  return row
}
