import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { MeshClient } from './index.js'
import {
  archiveBlockBytes,
  archiveSha256,
} from '../../protocol/src/archives.js'
import {
  sharedInfo,
  sharedPage,
  sharedCreate,
  sharedItem,
  sharedWrite,
  type SharedItem,
} from '../../protocol/src/shared.js'

export class SharedClient {
  constructor(readonly mesh: MeshClient) {}
  private path(id: string) {
    return '/v2/shared-sessions/' + z.uuid().parse(id)
  }
  async list() {
    return z
      .object({ shares: z.array(sharedInfo) })
      .parse(await this.mesh.request('/v2/shared-sessions')).shares
  }
  async find(adapter: 'deepseek' | 'codex', id: string) {
    return sharedInfo
      .nullable()
      .parse(
        await this.mesh.request(
          '/v2/shared-sessions/find?' + new URLSearchParams({ adapter, id }),
        ),
      )
  }
  async create(input: z.infer<typeof sharedCreate>) {
    return sharedInfo.parse(
      await this.mesh.request('/v2/shared-sessions', input),
    )
  }
  async pull(id: string, after = 0, wait = 0, signal?: AbortSignal) {
    return sharedPage.parse(
      await this.mesh.request(
        this.path(id) + `/events?after=${after}&wait=${wait}`,
        undefined,
        signal,
      ),
    )
  }
  async append(
    id: string,
    writer: z.infer<typeof sharedWrite>,
    item: Omit<SharedItem, 'preview'> & { text: string },
  ) {
    const { text, ...metadata } = item
    const data = Buffer.from(text)
    const blocks: string[] = []
    for (let offset = 0; offset < data.length; offset += archiveBlockBytes) {
      const block = data.subarray(offset, offset + archiveBlockBytes)
      const digest = archiveSha256(block)
      await this.mesh.request('/v2/shared-blocks/' + digest, {
        sha256: digest,
        data: block.toString('base64'),
      })
      blocks.push(digest)
    }
    const record = {
      ...sharedItem.parse({ ...metadata, preview: text.slice(0, 240) }),
      content: { bytes: data.length, blocks },
    }
    const eventId = createHash('sha256')
      .update(JSON.stringify(record))
      .digest('hex')
    return z.object({ seq: z.number(), share: sharedInfo }).parse(
      await this.mesh.request(this.path(id) + '/events', {
        generation: writer.generation,
        writerToken: writer.writerToken,
        eventId,
        item: record,
      }),
    )
  }
  async activity(
    id: string,
    writer: z.infer<typeof sharedWrite>,
    turn: string,
    state: 'busy' | 'idle',
    tool?: string,
  ) {
    return this.mesh.request(this.path(id) + '/activity', {
      generation: writer.generation,
      writerToken: writer.writerToken,
      turn,
      state,
      tool,
    })
  }
  async adoptCodex(
    id: string,
    input: {
      generation: number
      targetSessionId: string
      threadId: string
      writerToken: string
    },
  ) {
    return sharedInfo.parse(
      await this.mesh.request(this.path(id) + '/adopt-codex', input),
    )
  }
  async reserve(
    id: string,
    input: {
      generation: number
      operationId: string
      cut: number
      archiveId: string
    },
  ) {
    return sharedInfo.parse(
      await this.mesh.request(this.path(id) + '/reserve', input),
    )
  }
  async commitDsh(
    id: string,
    input: { operationId: string; targetSessionId: string },
  ) {
    return sharedInfo.parse(
      await this.mesh.request(this.path(id) + '/commit-dsh', input),
    )
  }
  async text(id: string, seq: number, offset = 0, length = 16384) {
    if (length < 4) throw new Error('Read at least four bytes to decode UTF-8')
    const r = z
      .object({ data: z.string(), next: z.number().nullable() })
      .parse(
        await this.mesh.request(
          this.path(id) +
            `/events/${seq}/content?offset=${offset}&length=${length}`,
        ),
      )
    const bytes = Buffer.from(r.data, 'base64')
    if (bytes.toString('base64') !== r.data || bytes.length > length)
      throw new Error('Invalid shared content range')
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes, {
      stream: r.next !== null,
    })
    return {
      text,
      next: r.next === null ? null : offset + Buffer.byteLength(text),
    }
  }
}
