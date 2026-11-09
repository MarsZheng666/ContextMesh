import type { ArchiveEntry } from '../../protocol/src/archives.js'

export type ArchiveRecord = Pick<
  ArchiveEntry,
  'turn' | 'role' | 'kind' | 'status'
> & { text: string }

export function archiveTerms(text: string, limit = 24) {
  const terms = new Set<string>()
  if (/超时|timeout|timed out/i.test(text)) terms.add('timeout')
  if (/失败|failed|failure/i.test(text)) terms.add('failed')
  if (/错误|error|exception/i.test(text)) terms.add('error')
  for (const match of text
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}_./@-]{2,96}/gu)) {
    const word = match[0].replace(/^[./@-]+|[./@-]+$/g, '')
    if (word.length < 2 || word.length > 96) continue
    terms.add(word)
    const basename = word.split('/').at(-1)!
    if (basename.length > 1 && terms.size < limit) terms.add(basename)
    if (terms.size >= limit) break
  }
  return [...terms].slice(0, limit)
}

const salient =
  /\b(?:error|fail(?:ed|ure)?|exception|timeout|timed out|E(?:CONN|TIME|ADDR|PERM|NOENT|PIPE|HOST)[A-Z]*|[A-Za-z_][\w-]*(?:\/[\w.-]+)+|[\w-]+\.(?:ts|tsx|js|py|rs|go|json|md))\b|超时|失败|错误/i

export function indexArchiveRecord(
  seq: number,
  record: ArchiveRecord,
  bytes: Buffer,
): ArchiveEntry {
  const anchors: ArchiveEntry['anchors'] = []
  const terms = new Set(archiveTerms(record.text.slice(0, 4096), 32))
  if (record.role === 'reference' && bytes.length > 1024) {
    let start = 0
    let line = 1
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const end = newline < 0 ? bytes.length : newline + 1
      for (let offset = start; offset < end; offset += 2048) {
        const size = Math.min(2048, end - offset)
        const text = bytes.toString('utf8', offset, offset + size)
        const match = salient.exec(text)
        if (!match) continue
        const nearby = text.slice(
          Math.max(0, match.index - 30),
          match.index + 220,
        )
        const words = archiveTerms(nearby, 8)
        for (const word of words) if (terms.size < 64) terms.add(word)
        const duplicate = anchors.findIndex(
          (a) => a.terms.join(' ') === words.join(' '),
        )
        if (duplicate >= 0) anchors.splice(duplicate, 1)
        if (anchors.length === 24) anchors.shift()
        anchors.push({ line, offset, bytes: size, terms: words })
      }
      line++
      start = end
    }
  }
  return {
    seq,
    turn: record.turn,
    role: record.role,
    kind: record.kind,
    ...(record.status ? { status: record.status } : {}),
    bytes: bytes.length,
    preview: record.text.slice(0, 240),
    terms: [...terms],
    anchors,
  }
}
