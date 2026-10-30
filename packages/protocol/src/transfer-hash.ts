import { createHash } from 'node:crypto'
import { MeshError } from './index.js'
import {
  MAX_FILE_BYTES,
  MAX_TRANSFER_BYTES,
  transferBundle,
  type TransferBundle,
  type TransferRecord,
  type TransferSummary,
} from './transfers.js'
export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex')
export function treeHash(files: TransferBundle['files']) {
  return sha256(
    JSON.stringify(
      files.map(({ path, baseHash, hash, baseMode, mode }) => ({
        path,
        baseHash,
        hash,
        baseMode,
        mode,
      })),
    ),
  )
}
export function validateBundle(input: unknown): TransferBundle {
  const b = transferBundle.parse(input)
  let total = 0
  const names = new Set<string>()
  for (const f of b.files) {
    const key = f.path.toLocaleLowerCase('en-US')
    if (
      names.has(key) ||
      [...names].some((n) => n.startsWith(key + '/') || key.startsWith(n + '/'))
    )
      throw new MeshError(
        'TRANSFER_INVALID',
        'duplicate or overlapping file paths',
      )
    names.add(key)
    if (
      (f.hash === null) !== (f.data === null) ||
      (f.hash === null) !== (f.mode === null) ||
      (f.baseHash === null) !== (f.baseMode === null) ||
      (!f.hash && !f.baseHash)
    )
      throw new MeshError('TRANSFER_INVALID', 'invalid file operation')
    if (f.data !== null) {
      const bytes = Buffer.from(f.data, 'base64')
      if (
        bytes.toString('base64') !== f.data ||
        sha256(bytes) !== f.hash ||
        bytes.length > MAX_FILE_BYTES
      )
        throw new MeshError(
          'TRANSFER_CORRUPT',
          'file content does not match its digest',
        )
      total += bytes.length
    }
  }
  if (b.files.some((f, i) => i > 0 && b.files[i - 1]!.path >= f.path))
    throw new MeshError('TRANSFER_INVALID', 'file paths must be sorted')
  const refs = new Set<string>()
  for (const a of b.attachments) {
    const bytes = Buffer.from(a.data, 'base64'),
      key = JSON.stringify(a.ref)
    if (
      refs.has(key) ||
      bytes.toString('base64') !== a.data ||
      bytes.length !== a.ref.bytes ||
      'sha256:' + sha256(bytes) !== a.ref.attachmentId
    )
      throw new MeshError(
        'TRANSFER_CORRUPT',
        'attachment does not match its reference',
      )
    refs.add(key)
    total += bytes.length
  }
  if (total > MAX_TRANSFER_BYTES || treeHash(b.files) !== b.treeHash)
    throw new MeshError(
      'TRANSFER_INVALID',
      'transfer is too large or has an invalid tree digest',
    )
  return b
}
export function bundleDigest(b: TransferBundle) {
  return sha256(JSON.stringify(validateBundle(b)))
}
export function transferSummary(r: TransferRecord): TransferSummary {
  const b = r.bundle
  return {
    id: r.id,
    digest: r.digest,
    sessionId: b.sessionId,
    projectId: b.projectId,
    sourceNodeId: b.sourceNodeId,
    targetNodeId: b.targetNodeId,
    treeHash: b.treeHash,
    baseCommit: b.baseCommit,
    ready: r.ready,
    expiresAt: r.expiresAt,
    bytes:
      b.files.reduce(
        (n, f) => n + (f.data ? Buffer.from(f.data, 'base64').length : 0),
        0,
      ) + b.attachments.reduce((n, a) => n + a.ref.bytes, 0),
    files: b.files.map((f) => ({
      path: f.path,
      action:
        f.hash === null ? 'delete' : f.baseHash === null ? 'add' : 'change',
    })),
    attachments: b.attachments.map((a) => ({
      name: a.ref.name,
      bytes: a.ref.bytes,
    })),
  }
}
