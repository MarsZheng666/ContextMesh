import { createHash, randomUUID } from 'node:crypto'
import {
  deriveEventMessage,
  foldSurface,
  SESSION_FORMAT_VERSION,
  TOOL_OUTCOME_UNKNOWN,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { MeshClient } from '../../client/src/index.js'
import type { ArchiveIndexQuery } from '../../client/src/archives.js'
import {
  indexArchiveRecord,
  type ArchiveRecord,
} from '../../client/src/archive-record.js'
import {
  archiveBlockBytes,
  archiveSha256,
  type ArchiveEntry,
  type ArchiveInfo,
} from '../../protocol/src/archives.js'
import type { RemoteHandle } from '../../protocol/src/index.js'

function recordsFor(event: SessionEvent, turn: string) {
  const message = deriveEventMessage(event)
  const records: ArchiveRecord[] = []
  const calls: string[] = []
  if (!message || message.role === 'system' || message.role === 'developer')
    return { records, calls, result: undefined, uncertain: false }
  const body: string[] = []
  for (const part of message.content) {
    if (part.type === 'text') body.push(part.text)
    else if (part.type === 'tool-call') {
      calls.push(part.id)
      records.push({
        turn,
        role: 'reference',
        kind: 'tool-call',
        text: JSON.stringify({
          id: part.id,
          name: part.name,
          arguments: part.arguments,
        }),
      })
    } else if (part.type !== 'reasoning') {
      records.push({
        turn,
        role: 'reference',
        kind: 'attachment-notice',
        text:
          'A native ' + part.type + ' part is recorded in the source session.',
      })
    }
  }
  const uncertain = body.some((text) => text.includes(TOOL_OUTCOME_UNKNOWN))
  const origin =
    message.source?.kind === 'contextmesh-import'
      ? message.source.sourceRole
      : undefined
  if (message.role === 'tool')
    body.unshift('[Tool result ' + message.toolCallId + ']')
  if (body.length)
    records.unshift({
      turn,
      kind: event.type,
      role:
        origin === 'user' || origin === 'assistant' || origin === 'reference'
          ? origin
          : message.role === 'tool'
            ? 'reference'
            : message.role,
      ...(message.role === 'tool'
        ? { status: message.isError ? 'failed' : 'completed' }
        : {}),
      text: body.join('\n'),
    })
  return {
    records,
    calls,
    uncertain,
    result: message.role === 'tool' ? message.toolCallId : undefined,
  }
}

function foldMetadata(event: SessionEvent): SessionEvent {
  // The canonical fold needs sequence/replacement metadata and tool identity.
  // The historical body is read again only for records chosen by the planner.
  if (event.type === 'request/header' || event.type === 'developer/message')
    return event
  if (event.type === 'tool/result')
    return {
      ...event,
      data: { ...event.data, message: { ...event.data.message, content: [] } },
    }
  return { ...event, data: null } as unknown as SessionEvent
}

interface SourceRecord {
  entry: ArchiveEntry
  sourceSeq: number
  part: number
}

export class DshArchiveView {
  private constructor(
    private readonly client: MeshClient,
    private readonly handle: RemoteHandle,
    private readonly metadata: ArchiveInfo,
    private readonly cut: number,
    private readonly records: SourceRecord[],
  ) {}
  static async open(client: MeshClient, id: string) {
    const handle = await client.open(id, 'read')
    try {
      const snapshot = handle.session
      if (
        snapshot.adapter !== 'deepseek' ||
        snapshot.header.version !== SESSION_FORMAT_VERSION
      )
        throw new Error('Unsupported source session format')
      const cut = snapshot.nextSeq
      const items: SessionEvent[] = []
      const views = new Map<
        number,
        {
          entries: ArchiveEntry[]
          calls: string[]
          result?: string
          uncertain: boolean
        }
      >()
      const digest = createHash('sha256')
      let busy = false
      let turn = 'opening'
      let title = 'DeepSeek Harness conversation'
      for (let offset = 0; offset < cut;) {
        const page = await client.read(handle, offset, 32, undefined, cut)
        if (!page.events.length)
          throw new Error('The DSH archive page did not advance')
        for (const raw of page.events) {
          const event = raw as unknown as SessionEvent
          digest.update(JSON.stringify(event)).update('\n')
          if (event.type === 'turn/start') {
            busy = true
            turn = String(event.seq)
          }
          if (event.type === 'turn/end') busy = false
          if (event.type === 'session/title')
            title = event.data.title.trim().slice(0, 160) || title
          items.push(foldMetadata(event))
          const { records, calls, result, uncertain } = recordsFor(event, turn)
          if (records.length || calls.length || result)
            views.set(Number(event.seq), {
              entries: records.map((record, part) =>
                indexArchiveRecord(part, record, Buffer.from(record.text)),
              ),
              calls,
              result,
              uncertain,
            })
        }
        offset += page.events.length
      }
      if (busy)
        throw new Error(
          'Finish or stop the DSH task before importing its saved history',
        )
      const fold = foldSurface(items)
      const records: SourceRecord[] = []
      const pending = new Set<string>()
      let bytes = 0
      for (const sourceSeq of fold.nodes) {
        const view = views.get(Number(sourceSeq))
        if (!view) continue
        if (view.uncertain)
          throw new Error(
            'Resolve uncertain historical tool effects before importing',
          )
        if (view.result) pending.delete(view.result)
        for (const call of view.calls) pending.add(call)
        for (const [part, entry] of view.entries.entries()) {
          records.push({
            sourceSeq: Number(sourceSeq),
            part,
            entry: { ...entry, seq: records.length },
          })
          bytes += entry.bytes
        }
      }
      if (pending.size)
        throw new Error('Resolve pending source tool calls before importing')
      if (!records.length)
        throw new Error('The DSH session has no saved context')
      const contentDigest = digest.digest('hex')
      const viewId =
        'archive:' +
        archiveSha256(
          JSON.stringify([id, snapshot.incarnation, cut, contentDigest]),
        )
      return new DshArchiveView(
        client,
        handle,
        {
          id: viewId,
          createdAt: Number(snapshot.header.createdAt) || 0,
          manifest: {
            header: {
              version: 2,
              title,
              scope: 'full',
              omittedAttachments: 0,
              unrecognizedItems: 0,
              interrupted: false,
              source: {
                adapter: 'deepseek',
                id,
                incarnation: snapshot.incarnation,
                eventCount: cut,
              },
            },
            bytes: Math.max(1, bytes),
            records: records.length,
            blocks: Math.max(1, Math.ceil(bytes / archiveBlockBytes)),
            digest: contentDigest,
          },
        },
        cut,
        records,
      )
    } catch (error) {
      await client.close(handle, randomUUID())
      throw error
    }
  }
  get id() {
    return this.metadata.id
  }
  async info(id: string) {
    if (id !== this.id) throw new Error('The DSH archive identity changed')
    return this.metadata
  }
  async index(id: string, q: ArchiveIndexQuery = {}) {
    await this.info(id)
    const descending = q.order === 'desc'
    const terms = new Set(q.terms ?? [])
    const count = q.limit ?? 32
    const records: ArchiveEntry[] = []
    for (
      let at = descending
        ? (q.after ?? this.records.length) - 1
        : (q.after ?? -1) + 1;
      at >= 0 && at < this.records.length;
      at += descending ? -1 : 1
    ) {
      const { entry } = this.records[at]!
      if (q.textOnly && entry.role === 'reference') continue
      if (q.role && entry.role !== q.role) continue
      if (
        terms.size &&
        ![
          ...entry.terms,
          ...entry.anchors.flatMap((anchor) => anchor.terms),
        ].some((term) => terms.has(term))
      )
        continue
      records.push(entry)
      if (records.length > count) break
    }
    return {
      records: records.slice(0, count),
      next: records.length > count ? records[count - 1]!.seq : null,
    }
  }
  async text(id: string, seq: number, offset = 0, length = 16384) {
    await this.info(id)
    const record = this.records[seq]
    if (!record) throw new Error('The DSH archive record is unavailable')
    const page = await this.client.read(
      this.handle,
      record.sourceSeq,
      1,
      undefined,
      this.cut,
    )
    const event = page.events[0] as unknown as SessionEvent | undefined
    const content =
      event && recordsFor(event, record.entry.turn).records[record.part]
    if (!content) throw new Error('The DSH archive record changed')
    const bytes = Buffer.from(content.text)
    if (bytes.length !== record.entry.bytes || offset > bytes.length)
      throw new Error('The DSH archive record changed')
    const end = Math.min(bytes.length, offset + length)
    while (offset < end && (bytes[offset]! & 0xc0) === 0x80) offset++
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      bytes.subarray(offset, end),
      { stream: end < bytes.length },
    )
    return { text, next: end < bytes.length ? end : null }
  }
  close() {
    return this.client.close(this.handle, randomUUID())
  }
}
