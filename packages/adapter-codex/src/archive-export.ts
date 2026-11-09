import {
  isArchiveContext,
  type ArchiveHeader,
  type ResumeContext,
} from '../../protocol/src/archives.js'
import { NativeCodex } from './native.js'
import type { CodexOptions } from './rpc.js'
import type { ArchiveSpool } from './archive-spool.js'

async function withPages<T>(
  options: CodexOptions | undefined,
  work: (native: NativeCodex, limit: number) => Promise<T>,
) {
  for (const limit of [32, 8, 2, 1]) {
    const native = new NativeCodex(options)
    try {
      await native.init()
      return await work(native, limit)
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes('Codex response exceeds the protocol limit')
      )
        throw error
      if (limit === 1)
        throw new Error(
          'Codex could not export one native record within its transport limit',
        )
    } finally {
      await native.close()
    }
  }
  throw new Error('Could not read the saved Codex conversation')
}

export function readCodexCut(threadId: string, options?: CodexOptions) {
  return withPages(options, (native, limit) =>
    native.savedCutDigest(threadId, limit),
  )
}

export async function captureCodexArchive(
  spool: ArchiveSpool,
  threadId: string,
  scope: ArchiveHeader['scope'],
  nativeOptions?: CodexOptions,
  inherited?: ResumeContext,
  replyTurn?: string,
) {
  const saved = await spool.saved()
  if (saved) {
    if (
      saved.manifest.header.source.id !== threadId ||
      saved.manifest.header.scope !== scope
    )
      throw new Error(
        'This saved archive belongs to a different conversation or scope',
      )
    return { ...saved, replyText: '' }
  }
  const parent =
    isArchiveContext(inherited) && !inherited.nativeSource
      ? inherited.archiveId
      : undefined
  const nativeSource =
    isArchiveContext(inherited) && inherited.nativeSource
      ? inherited.source
      : undefined
  return withPages(nativeOptions, async (native, limit) => {
    const replies: string[] = []
    const saved = await spool.prepare(async (append) => {
      for (const message of parent ? [] : (inherited?.messages ?? []))
        if (scope === 'full' || message.role !== 'reference')
          await append({ ...message, turn: 'imported', kind: 'imported' })
      const { thread, eventCount, ...coverage } = await native.captureArchive(
        threadId,
        scope,
        async (record) => {
          if (
            replyTurn &&
            record.turn === replyTurn &&
            record.role === 'assistant'
          )
            replies.push(record.text)
          await append(record)
        },
        limit,
      )
      const title =
        [thread.name, thread.preview]
          .find(
            (value): value is string =>
              typeof value === 'string' && Boolean(value.trim()),
          )
          ?.trim()
          .slice(0, 160) || 'Codex conversation'
      return {
        version: 2,
        title,
        scope,
        parent,
        nativeSource,
        ...coverage,
        source: {
          adapter: 'codex',
          id: threadId,
          incarnation: threadId,
          eventCount,
        },
      }
    })
    return { ...saved, replyText: replies.join('\n') }
  })
}
