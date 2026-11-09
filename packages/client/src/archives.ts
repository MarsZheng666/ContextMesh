import { z } from 'zod'
import {
  archiveBlockBytes,
  archiveContent,
  archiveEntries,
  archiveFeature,
  archiveIdSchema,
  archiveInfo,
  archiveUploadStatus,
  type ArchiveManifest,
} from '../../protocol/src/archives.js'
import type { MeshClient } from './index.js'

const catalog = z.object({
  archives: z.array(archiveInfo).max(64),
  next: archiveIdSchema.nullable(),
})

export interface ArchiveIndexQuery {
  after?: number
  limit?: number
  order?: 'asc' | 'desc'
  terms?: string[]
  textOnly?: boolean
  role?: 'user' | 'assistant' | 'reference'
}

export class ArchiveClient {
  constructor(private readonly mesh: MeshClient) {}

  async supported() {
    return !!(await this.mesh.capabilities()).features?.includes(archiveFeature)
  }

  private path(id: string) {
    return '/v2/archives/' + encodeURIComponent(archiveIdSchema.parse(id))
  }

  private uploadPath(id: string) {
    return (
      '/v2/archive-uploads/' + encodeURIComponent(archiveIdSchema.parse(id))
    )
  }

  async begin(manifest: ArchiveManifest) {
    return archiveUploadStatus.parse(
      await this.mesh.request('/v2/archive-uploads', manifest),
    )
  }

  async put(id: string, seq: number, data: Buffer, sha256: string) {
    return archiveUploadStatus.parse(
      await this.mesh.request(this.uploadPath(id) + '/blocks/' + seq, {
        data: data.toString('base64'),
        sha256,
      }),
    )
  }

  async commit(id: string) {
    return archiveUploadStatus.parse(
      await this.mesh.request(this.uploadPath(id) + '/commit', {}),
    )
  }

  async list(after?: string) {
    return catalog.parse(
      await this.mesh.request(
        '/v2/archives' + (after ? '?after=' + encodeURIComponent(after) : ''),
      ),
    )
  }

  async info(id: string) {
    return archiveInfo.parse(await this.mesh.request(this.path(id)))
  }

  async index(id: string, q: ArchiveIndexQuery = {}) {
    const query = new URLSearchParams()
    if (q.after !== undefined) query.set('after', String(q.after))
    if (q.limit !== undefined) query.set('limit', String(q.limit))
    if (q.order) query.set('order', q.order)
    if (q.terms?.length) query.set('terms', q.terms.join(' '))
    if (q.textOnly) query.set('textOnly', 'true')
    if (q.role) query.set('role', q.role)
    return archiveEntries.parse(
      await this.mesh.request(this.path(id) + '/records?' + query),
    )
  }

  async read(id: string, seq: number, offset = 0, length = archiveBlockBytes) {
    const { data, next } = archiveContent.parse(
      await this.mesh.request(
        this.path(id) +
          '/records/' +
          seq +
          '/content?offset=' +
          offset +
          '&length=' +
          length,
      ),
    )
    const bytes = Buffer.from(data, 'base64')
    if (
      bytes.toString('base64') !== data ||
      bytes.length > length ||
      (next !== null && (!bytes.length || next !== offset + bytes.length))
    )
      throw new Error('Invalid archive content range')
    return { bytes, next }
  }

  async text(id: string, seq: number, offset = 0, length = 16384) {
    const { bytes, next } = await this.read(id, seq, offset, length)
    let start = 0
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      bytes.subarray(start),
      {
        stream: next !== null,
      },
    )
    return {
      text,
      next:
        next === null
          ? null
          : Math.max(offset + 1, offset + start + Buffer.byteLength(text)),
    }
  }
}
