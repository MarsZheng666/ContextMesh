import { join } from 'node:path'
import { SharedClient } from '../../client/src/shared.js'
import { ArchiveClient } from '../../client/src/archives.js'
import { ArchiveSpool } from '../../adapter-codex/src/archive-spool.js'
import type { SharedEvent } from '../../protocol/src/shared.js'

/** Capture an immutable cut. Reservation later checks that the source has not advanced. */
export async function prepareSharedArchive(
  client: SharedClient,
  directory: string,
  id: string,
) {
  let page = await client.pull(id)
  const generation = page.share.generation
  const records = new Map<string, SharedEvent>()
  for (;;) {
    if (page.share.generation !== generation)
      throw new Error('The conversation moved; prepare it again')
    for (const event of page.events) records.set(event.key, event)
    if (!page.more) break
    page = await client.pull(id, page.next)
  }
  const share = page.share,
    cut = page.next
  if (share.source.adapter !== 'codex' || share.activity !== 'idle')
    throw new Error('Wait for the current turn and its tools to finish')
  const spool = new ArchiveSpool(
    join(directory, id, String(generation), String(cut)),
    client.mesh.endpoint,
  )
  await spool.prepare(async (append) => {
    for (const record of records.values()) {
      let text = '',
        offset: number | null = 0
      while (offset !== null) {
        const part = await client.text(id, record.seq, offset, 512 * 1024)
        text += part.text
        offset = part.next
      }
      await append({
        turn: record.turn.slice(0, 160) || 'unscoped',
        role: record.role,
        kind: record.kind,
        status: record.status,
        text,
      })
    }
    return {
      version: 2,
      title: share.title,
      scope: share.scope,
      source: { ...share.source, eventCount: cut },
      omittedAttachments: 0,
      unrecognizedItems: 0,
      interrupted: false,
    }
  })
  const archive = new ArchiveClient(client.mesh)
  const uploaded = await spool.upload(archive)
  const info = await archive.info(uploaded.id)
  return {
    id,
    generation,
    cut,
    archiveId: uploaded.id,
    entry: {
      id: uploaded.id,
      title: share.title,
      incarnation: share.source.incarnation,
      nextSeq: info.manifest.records,
      createdAt: info.createdAt,
      busy: false,
      recoveryRequired: false,
      format: 2 as const,
      bytes: info.manifest.bytes,
    },
  }
}
