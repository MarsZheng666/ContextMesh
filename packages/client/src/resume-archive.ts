import {
  archiveResumeContext,
  archiveBlockBytes,
  archiveSha256,
  type ArchiveEntry,
  type ArchiveInfo,
  type ArchiveResumeOptions,
} from '../../protocol/src/archives.js'
import { MeshError } from '../../protocol/src/index.js'
import { archiveTerms } from './archive-record.js'
import type { ArchiveClient } from './archives.js'

type ArchiveReader = Pick<ArchiveClient, 'info' | 'index' | 'text'>

export interface ArchiveBudget {
  contextWindow: number
  outputReserve: number
  fixedTokens: number
  messageOverhead?: number
  route: string
}

interface Candidate {
  id: string
  depth: number
  entry: ArchiveEntry
}

export function archiveTokenBound(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function capacity(message: string) {
  return new MeshError('ARCHIVE_CONTEXT_BUDGET', message, 409)
}

function termsMatch(terms: string[], query: Set<string>) {
  return terms.reduce((score, term) => {
    if (!query.has(term)) return score
    return score + (/[/._-]|^e(?:conn|time|addr|noent)/.test(term) ? 4 : 1)
  }, 0)
}

function key(c: Candidate) {
  return c.id + '/' + c.entry.seq
}

export async function planArchiveResume(
  reader: ArchiveReader,
  id: string,
  budget: ArchiveBudget,
  options: ArchiveResumeOptions = {},
  nativeSource = false,
) {
  const historyBudget =
    budget.contextWindow -
    budget.outputReserve -
    budget.fixedTokens -
    1024 -
    (options.query ? archiveTokenBound(options.query) : 1024)
  if (historyBudget <= 256)
    throw capacity('The receiving model has no room for the task context')

  const info = await reader.info(id)
  const chain: { info: ArchiveInfo; textOnly: boolean }[] = [
    { info, textOnly: info.manifest.header.scope === 'text' },
  ]
  while (chain.length < 16) {
    const parent = chain.at(-1)!
    if (!parent.info.manifest.header.parent) break
    const ancestor = await reader.info(parent.info.manifest.header.parent)
    if (chain.some((item) => item.info.id === ancestor.id))
      throw new Error('Archive ancestry contains a cycle')
    chain.push({
      info: ancestor,
      textOnly: parent.textOnly || ancestor.manifest.header.scope === 'text',
    })
  }

  const pages = await Promise.all(
    chain.map((item, depth) =>
      reader.index(item.info.id, {
        order: 'desc',
        limit: depth === 0 ? 24 : 8,
        textOnly: item.textOnly,
      }),
    ),
  )
  const recent = pages.map((page, depth) =>
    page.records.map((entry) => ({ id: chain[depth]!.info.id, depth, entry })),
  )
  let goal: Candidate | undefined
  for (const [depth, item] of chain.entries()) {
    const page = await reader.index(item.info.id, {
      order: 'desc',
      role: 'user',
      limit: 1,
    })
    if (page.records[0]) {
      goal = { id: item.info.id, depth, entry: page.records[0] }
      break
    }
  }
  const latest = (
    await reader.index(id, { order: 'desc', role: 'assistant', limit: 1 })
  ).records[0]
  const query = new Set(
    archiveTerms(options.query ?? goal?.entry.preview ?? ''),
  )
  const related = query.size
    ? (
        await Promise.all(
          chain.map(async (item, depth) => {
            const page = await reader.index(item.info.id, {
              order: 'desc',
              limit: 16,
              textOnly: item.textOnly,
              terms: [...query],
            })
            return page.records.map((entry) => ({
              id: item.info.id,
              depth,
              entry,
            }))
          }),
        )
      )
        .flat()
        .sort((a, b) => {
          const score = (value: Candidate) =>
            termsMatch(value.entry.terms, query) +
            Math.max(
              0,
              ...value.entry.anchors.map((anchor) =>
                termsMatch(anchor.terms, query),
              ),
            )
          return (
            score(b) - score(a) ||
            a.depth - b.depth ||
            b.entry.seq - a.entry.seq
          )
        })
    : []

  const candidates = new Map(
    [...recent.flat(), ...related].map((entry) => [key(entry), entry]),
  )
  const selected: {
    candidate: Candidate
    offset: number
    length: number
    text: string
  }[] = []
  const used = new Set<string>()
  let inputTokens = 0
  const add = async (
    c: Candidate,
    required = false,
    range?: { offset: number; length: number },
  ) => {
    if (!range && used.has(key(c))) return
    const entry = c.entry
    const available = historyBudget - inputTokens
    let offset = range?.offset ?? 0
    let length = range
      ? Math.min(range.length, entry.bytes - offset)
      : entry.bytes
    if (
      range &&
      selected.some(
        (item) =>
          key(item.candidate) === key(c) &&
          offset >= item.offset &&
          offset + length <= item.offset + item.length,
      )
    )
      return
    if (length < 0)
      throw new MeshError(
        'ARCHIVE_RANGE',
        'The selected excerpt is outside this record',
        416,
      )
    if (
      !range &&
      !required &&
      (entry.role === 'reference' || length > available - 192)
    ) {
      const hit = entry.anchors
        .slice()
        .sort(
          (a, b) =>
            termsMatch(b.terms, query) - termsMatch(a.terms, query) ||
            b.line - a.line,
        )[0]
      if (hit) {
        offset = hit.offset
        length = hit.bytes
      } else if (length > 4096) {
        length = 4096
        offset = entry.role === 'reference' ? entry.bytes - length : 0
      }
    }
    const overhead = budget.messageOverhead ?? 96
    if (length > available - overhead - 32 || length > archiveBlockBytes) {
      if (required)
        throw capacity(
          'The task instruction or selected excerpt is too large for this model',
        )
      return
    }
    const raw = length
      ? (await reader.text(c.id, entry.seq, offset, length)).text
      : ''
    const excerpt = offset > 0 || length < entry.bytes
    const text =
      entry.role === 'reference' || excerpt
        ? `[Archived ${entry.kind}${excerpt ? ' excerpt' : ''}, ${nativeSource ? info.manifest.header.source.id : c.id}, record ${entry.seq}, byte ${offset}]\n${raw}`
        : raw
    // Count the destination framing, including the historical-reference annotation.
    const estimated = archiveTokenBound({ role: entry.role, text }) + overhead
    if (estimated > available) {
      if (required)
        throw capacity(
          'The task instruction or selected excerpt is too large for this model',
        )
      return
    }
    selected.push({ candidate: c, offset, length, text })
    used.add(key(c))
    inputTokens += estimated
  }

  if (goal) await add(goal, true)
  for (const pick of options.include ?? []) {
    const depth = chain.findIndex((item) => item.info.id === pick.id)
    if (depth < 0)
      throw new MeshError(
        'ARCHIVE_SELECTION',
        'Selected content is outside this archive',
        409,
      )
    let candidate = candidates.get(pick.id + '/' + pick.seq)
    if (!candidate) {
      const page = await reader.index(pick.id, {
        ...(pick.seq ? { after: pick.seq - 1 } : {}),
        limit: 1,
        textOnly: chain[depth]!.textOnly,
      })
      const entry = page.records.find((entry) => entry.seq === pick.seq)
      if (!entry)
        throw new MeshError(
          'ARCHIVE_SELECTION',
          'The selected record is unavailable',
          409,
        )
      candidate = { id: pick.id, depth, entry }
    }
    await add(candidate, true, pick)
  }
  if (latest) await add({ id, depth: 0, entry: latest })
  for (const candidate of [
    ...recent[0]!.slice(0, 8),
    ...related,
    ...recent.flat(),
  ])
    await add(candidate)
  for (const [depth, item] of chain.entries()) {
    let after = pages[depth]!.next
    while (after !== null && historyBudget - inputTokens > 256) {
      const page = await reader.index(item.info.id, {
        after,
        order: 'desc',
        limit: 24,
        textOnly: item.textOnly,
      })
      const before = selected.length
      for (const entry of page.records)
        await add({ id: item.info.id, depth, entry })
      if (page.next === after || selected.length === before) break
      after = page.next
    }
  }
  if (!selected.length)
    throw capacity('No archive records fit this receiving model')

  selected.sort(
    (a, b) =>
      b.candidate.depth - a.candidate.depth ||
      a.candidate.entry.seq - b.candidate.entry.seq ||
      a.offset - b.offset,
  )
  const selection = selected.map(({ candidate, offset, length }) => ({
    id: candidate.id,
    seq: candidate.entry.seq,
    role: candidate.entry.role,
    kind: candidate.entry.kind,
    offset,
    length,
    totalBytes: candidate.entry.bytes,
  }))
  const context = archiveResumeContext.parse({
    version: 2,
    archiveId: id,
    archiveDigest: info.manifest.digest,
    ...(nativeSource ? { nativeSource: true } : {}),
    source: {
      ...info.manifest.header.source,
      id: nativeSource ? info.manifest.header.source.id : id,
    },
    messages: selected.map(({ candidate, text }) => ({
      role: candidate.entry.role,
      text,
    })),
  })
  const digest = archiveSha256(
    JSON.stringify({ budget, selection, context, query: options.query ?? '' }),
  )
  if (options.planDigest && options.planDigest !== digest)
    throw new MeshError(
      'ARCHIVE_PLAN_CHANGED',
      'The model or selected context changed; review the import again',
      409,
    )
  return {
    context,
    digest,
    report: {
      id,
      title: info.manifest.header.title,
      archivedBytes: info.manifest.bytes,
      archivedRecords: info.manifest.records,
      inputTokens,
      historyBudget,
      contextWindow: budget.contextWindow,
      outputReserve: budget.outputReserve,
      route: budget.route,
      selected: selection,
    },
  }
}
