import { createHash } from 'node:crypto'
import { z } from 'zod'
import { MeshError } from './index.js'
import { contextDigest, portableContext, validatePortable } from './portable.js'

export const archiveFeature = 'chunked-archives-v2'
export const archiveBlockBytes = 512 * 1024
const archiveHeaderBytes = 32 * 1024
const uint = z.int().nonnegative()
const hash = z.string().regex(/^[0-9a-f]{64}$/)
export const archiveIdSchema = z.string().regex(/^archive:[0-9a-f]{64}$/)
export const isArchiveId = (id: string) => archiveIdSchema.safeParse(id).success
export const archiveScope = z.enum(['full', 'text'])
const term = z
  .string()
  .min(2)
  .max(96)
  .regex(/^[\p{L}\p{N}_./@-]+$/u)
export const archiveSearch = z.array(term).max(24)
const terms = z.array(term).max(64)
const anchor = z
  .object({
    offset: uint,
    bytes: z.int().min(1).max(4096),
    line: z.int().positive(),
    terms: z.array(term).max(8),
  })
  .strict()

export const archiveEntry = z
  .object({
    seq: uint,
    turn: z.string().min(1).max(160),
    role: z.enum(['user', 'assistant', 'reference']),
    kind: z.string().min(1).max(80),
    status: z.string().max(48).optional(),
    preview: z.string().max(240),
    bytes: uint,
    terms,
    anchors: z.array(anchor).max(24),
  })
  .strict()
  .refine(
    (entry) => entry.anchors.every((a) => a.offset + a.bytes <= entry.bytes),
    'Archive anchor is outside its record',
  )
export type ArchiveEntry = z.infer<typeof archiveEntry>

export const archiveHeader = z
  .object({
    version: z.literal(2),
    title: z.string().min(1).max(160),
    source: portableContext.shape.source,
    scope: archiveScope,
    parent: archiveIdSchema.optional(),
    nativeDigest: hash.optional(),
    nativeSource: portableContext.shape.source.optional(),
    omittedAttachments: uint.default(0),
    unrecognizedItems: uint.default(0),
    interrupted: z.boolean().default(false),
  })
  .strict()

export const archiveManifest = z
  .object({
    header: archiveHeader,
    bytes: z.int().positive(),
    records: z.int().positive(),
    blocks: z.int().positive(),
    digest: hash,
  })
  .strict()
  .refine(
    (manifest) =>
      manifest.blocks === Math.ceil(manifest.bytes / archiveBlockBytes),
    'Invalid archive block count',
  )
export type ArchiveManifest = z.infer<typeof archiveManifest>
export type ArchiveHeader = z.infer<typeof archiveHeader>

export const archiveBlock = z
  .object({
    sha256: hash,
    data: z
      .string()
      .min(4)
      .max(Math.ceil(archiveBlockBytes / 3) * 4),
  })
  .strict()

export const archiveUploadStatus = z.object({
  id: archiveIdSchema,
  next: uint,
  committed: z.boolean(),
})
export const archiveInfo = z.object({
  id: archiveIdSchema,
  createdAt: z.number().int(),
  manifest: archiveManifest,
})
export type ArchiveInfo = z.infer<typeof archiveInfo>

export const archiveEntries = z.object({
  records: z.array(archiveEntry).max(64),
  next: uint.nullable(),
})
export const archiveContent = z.object({
  data: z.string().max(Math.ceil(archiveBlockBytes / 3) * 4),
  next: uint.nullable(),
})

export const archiveStartDigest = '0'.repeat(64)
export const archiveSha256 = (value: Buffer | string) =>
  createHash('sha256').update(value).digest('hex')

export function archiveDigest(previous: string, blockHash: string) {
  return archiveSha256(Buffer.from(previous + blockHash, 'hex'))
}

export function archiveIdentity(manifest: ArchiveManifest) {
  return (
    'archive:' + archiveSha256(JSON.stringify(archiveManifest.parse(manifest)))
  )
}

export function archiveFrame(entry: ArchiveEntry) {
  const header = Buffer.from(JSON.stringify(archiveEntry.parse(entry)))
  if (header.length > archiveHeaderBytes)
    throw new MeshError(
      'ARCHIVE_RECORD_HEADER',
      'Archive record index is too large',
      400,
    )
  const size = Buffer.alloc(4)
  size.writeUInt32BE(header.length)
  return Buffer.concat([size, header])
}

export interface ArchiveScan {
  partial: Buffer
  remaining: number
  records: number
}

export function scanArchiveBlock(
  data: Buffer,
  start: number,
  state: ArchiveScan,
  scope: ArchiveHeader['scope'],
) {
  let { partial, remaining, records } = state
  let offset = 0
  const entries: { entry: ArchiveEntry; position: number }[] = []
  while (offset < data.length) {
    if (remaining) {
      const skipped = Math.min(remaining, data.length - offset)
      remaining -= skipped
      offset += skipped
      continue
    }
    const tail = data.subarray(offset)
    const header = partial.length ? Buffer.concat([partial, tail]) : tail
    if (header.length < 4) {
      partial = header
      break
    }
    const size = header.readUInt32BE()
    if (!size || size > archiveHeaderBytes)
      throw new MeshError(
        'ARCHIVE_RECORD_HEADER',
        'Invalid archive record header size',
        400,
      )
    if (header.length < 4 + size) {
      partial = header
      break
    }
    let entry: ArchiveEntry
    try {
      entry = archiveEntry.parse(
        JSON.parse(header.toString('utf8', 4, 4 + size)),
      )
    } catch {
      throw new MeshError(
        'ARCHIVE_RECORD_HEADER',
        'Invalid archive record header',
        400,
      )
    }
    if (
      entry.seq !== records ||
      (scope === 'text' && entry.role === 'reference')
    )
      throw new MeshError(
        'ARCHIVE_RECORD_SEQUENCE',
        'Record is out of order or outside the declared scope',
        409,
      )
    offset += 4 + size - partial.length
    partial = Buffer.alloc(0)
    remaining = entry.bytes
    entries.push({ entry, position: start + offset })
    records++
  }
  return { partial, remaining, records, entries }
}

export const archiveSelection = z
  .object({
    id: archiveIdSchema,
    seq: uint,
    offset: uint,
    length: z.int().min(1).max(archiveBlockBytes),
  })
  .strict()

export const archiveResumeOptions = z
  .object({
    query: z.string().trim().max(16000).optional(),
    include: z.array(archiveSelection).max(8).optional(),
    contextWindow: z.int().positive().max(10000000).optional(),
    planDigest: hash.optional(),
  })
  .strict()
export type ArchiveResumeOptions = z.infer<typeof archiveResumeOptions>

export const archiveResumeContext = z
  .object({
    version: z.literal(2),
    source: portableContext.shape.source,
    archiveId: archiveIdSchema,
    archiveDigest: hash,
    nativeSource: z.literal(true).optional(),
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant', 'reference']),
            text: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
export type ArchiveResumeContext = z.infer<typeof archiveResumeContext>
export type ResumeContext =
  z.infer<typeof portableContext> | ArchiveResumeContext

export function isArchiveContext(
  context: unknown,
): context is ArchiveResumeContext {
  return (
    typeof context === 'object' &&
    context !== null &&
    'version' in context &&
    context.version === 2
  )
}

export function validateResumeContext(context: unknown): ResumeContext {
  return isArchiveContext(context)
    ? archiveResumeContext.parse(context)
    : validatePortable(context)
}

export function resumeContextDigest(context: ResumeContext) {
  return isArchiveContext(context)
    ? archiveSha256(JSON.stringify(archiveResumeContext.parse(context)))
    : contextDigest(context)
}
