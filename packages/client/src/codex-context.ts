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
  incarnation: z.uuid(),
  nextSeq: z.number().int().nonnegative(),
  createdAt: z.number(),
  busy: z.boolean(),
  recoveryRequired: z.boolean(),
})
export async function codexArchives(client: MeshClient) {
  if (
    !(await client.capabilities()).features?.includes('codex-context-return-v1')
  )
    return []
  return z
    .array(codexArchiveSchema)
    .parse(await client.request('/v1/codex-archives'))
}
export async function settledCodexArchive(client: MeshClient, id: string) {
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
