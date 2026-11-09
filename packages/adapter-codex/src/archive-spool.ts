import { open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  archiveBlockBytes,
  archiveDigest,
  archiveFrame,
  archiveIdentity,
  archiveManifest,
  archiveSha256,
  archiveStartDigest,
  type ArchiveHeader,
} from '../../protocol/src/archives.js'
import { ArchiveClient } from '../../client/src/archives.js'
import {
  indexArchiveRecord,
  type ArchiveRecord,
} from '../../client/src/archive-record.js'
import {
  atomicJson,
  optionalJson,
  privateDirectory,
} from '../../runtime-manager/src/files.js'

const savedArchive = z.object({
  endpoint: z.string(),
  manifest: archiveManifest,
})
export type SavedArchive = z.infer<typeof savedArchive>

export class ArchiveSpool {
  constructor(
    readonly directory: string,
    private readonly endpoint: string,
  ) {}

  async saved() {
    const saved = savedArchive
      .optional()
      .parse(await optionalJson(join(this.directory, 'manifest.json')))
    if (saved && saved.endpoint !== this.endpoint)
      throw new Error(
        'Use the original Server connection to resume this upload',
      )
    return saved
  }

  async prepare(
    capture: (
      append: (record: ArchiveRecord) => Promise<void>,
    ) => Promise<ArchiveHeader>,
  ) {
    const saved = await this.saved()
    if (saved) return saved
    await privateDirectory(this.directory)
    const temporary = join(this.directory, 'records.partial')
    await rm(temporary, { force: true })
    const file = await open(temporary, 'wx', 0o600)
    const block = Buffer.alloc(archiveBlockBytes)
    let used = 0
    let bytes = 0
    let blocks = 0
    let records = 0
    let digest = archiveStartDigest
    const flush = async () => {
      if (!used) return
      const data = block.subarray(0, used)
      await file.writeFile(data)
      bytes += used
      blocks++
      digest = archiveDigest(digest, archiveSha256(data))
      used = 0
    }
    const append = async (data: Buffer) => {
      for (let offset = 0; offset < data.length;) {
        const count = data.copy(
          block,
          used,
          offset,
          offset + archiveBlockBytes - used,
        )
        used += count
        offset += count
        if (used === archiveBlockBytes) await flush()
      }
    }
    try {
      const header = await capture(async (record) => {
        const text = Buffer.from(record.text)
        await append(archiveFrame(indexArchiveRecord(records++, record, text)))
        await append(text)
      })
      if (!records) throw new Error('There are no saved records to publish')
      await flush()
      const manifest = archiveManifest.parse({
        header,
        bytes,
        blocks,
        records,
        digest,
      })
      await file.sync()
      await rename(temporary, join(this.directory, 'records'))
      const result = { endpoint: this.endpoint, manifest }
      await atomicJson(join(this.directory, 'manifest.json'), result)
      return result
    } finally {
      await file.close()
      await rm(temporary, { force: true })
    }
  }

  async upload(
    client: ArchiveClient,
    progress?: (sent: number, blocks: number) => Promise<void>,
  ) {
    const saved = await this.saved()
    if (!saved) throw new Error('The local archive copy is unavailable')
    const { manifest } = saved
    const status = await client.begin(manifest)
    if (
      status.id !== archiveIdentity(manifest) ||
      status.next > manifest.blocks
    )
      throw new Error('Server returned a different archive upload')
    if (status.committed) return { id: status.id }
    const file = await open(join(this.directory, 'records'), 'r')
    try {
      for (let seq = status.next; seq < manifest.blocks; seq++) {
        const position = seq * archiveBlockBytes
        const data = Buffer.alloc(
          Math.min(archiveBlockBytes, manifest.bytes - position),
        )
        let read = 0
        while (read < data.length) {
          const { bytesRead } = await file.read(
            data,
            read,
            data.length - read,
            position + read,
          )
          if (!bytesRead)
            throw new Error('The local archive copy is incomplete')
          read += bytesRead
        }
        const accepted = await client.put(
          status.id,
          seq,
          data,
          archiveSha256(data),
        )
        if (accepted.id !== status.id || accepted.next < seq + 1)
          throw new Error('Server did not acknowledge the archive block')
        await progress?.(seq + 1, manifest.blocks)
      }
      const result = await client.commit(status.id)
      if (!result.committed || result.id !== status.id)
        throw new Error('Server did not confirm archive publication')
      return { id: status.id }
    } finally {
      await file.close()
    }
  }
}
