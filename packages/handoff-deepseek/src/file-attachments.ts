import type { Context } from '@deepseek-ai/cordis'
import {
  AttachmentId,
  type FileAttachmentRef,
} from '@deepseek-ai/dsh-attachment'
import { MeshError } from '../../protocol/src/index.js'
import {
  fileRef,
  MAX_FILE_BYTES,
  MAX_TRANSFER_BYTES,
  type TransferBundle,
} from '../../protocol/src/transfers.js'
import { sha256 } from '../../protocol/src/transfer-hash.js'
export function fileReferences(value: unknown) {
  const refs = new Map<string, ReturnType<typeof fileRef.parse>>()
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(walk)
      return
    }
    if (!value || typeof value !== 'object') return
    const row = Object.fromEntries(Object.entries(value))
    if (row.type === 'file' && row.attachment) {
      const ref = fileRef.parse(row.attachment)
      refs.set(JSON.stringify(ref), ref)
      return
    }
    if (
      ['image', 'spill'].includes(String(row.type)) ||
      'spillId' in row ||
      'attachmentId' in row
    )
      throw new MeshError(
        'UNSUPPORTED_RESOURCE',
        'images, spill and unknown attachment references cannot transfer',
      )
    Object.values(row).forEach(walk)
  }
  walk(value)
  if (refs.size > 32)
    throw new MeshError(
      'TRANSFER_TOO_LARGE',
      'at most 32 file attachments can transfer',
    )
  return [...refs.values()].sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  )
}
const nativeRef = (
  ref: ReturnType<typeof fileRef.parse>,
): FileAttachmentRef => ({
  ...ref,
  attachmentId: AttachmentId(ref.attachmentId),
})
export async function exportAttachments(ctx: Context, events: unknown) {
  const refs = fileReferences(events)
  if (!refs.length) return []
  const store = ctx.get('attachments')
  if (!store)
    throw new MeshError(
      'UNSUPPORTED_RESOURCE',
      'a native file attachment backend is required',
    )
  const out: TransferBundle['attachments'] = []
  let total = 0
  for (const ref of refs) {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of store.readFileStream(nativeRef(ref))) {
      size += chunk.byteLength
      total += chunk.byteLength
      if (size > MAX_FILE_BYTES || total > MAX_TRANSFER_BYTES)
        throw new MeshError(
          'TRANSFER_TOO_LARGE',
          'file attachments exceed the transfer limit',
        )
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    if (
      data.length !== ref.bytes ||
      'sha256:' + sha256(data) !== ref.attachmentId
    )
      throw new MeshError(
        'TRANSFER_CORRUPT',
        'attachment bytes do not match the session reference',
      )
    out.push({ ref, data: data.toString('base64') })
  }
  return out
}
export async function importAttachments(
  ctx: Context,
  attachments: TransferBundle['attachments'],
) {
  if (!attachments.length) return
  const store = ctx.get('attachments')
  if (!store)
    throw new MeshError(
      'UNSUPPORTED_RESOURCE',
      'target needs a native file attachment backend',
    )
  for (const a of attachments) {
    const result = await store.saveFile({
      data: Buffer.from(a.data, 'base64'),
      name: a.ref.name,
    })
    if (
      result.attachmentId !== a.ref.attachmentId ||
      result.name !== a.ref.name ||
      result.bytes !== a.ref.bytes
    )
      throw new MeshError(
        'TRANSFER_CORRUPT',
        'target attachment backend changed the original reference',
      )
  }
}
export async function verifyAttachments(
  ctx: Context,
  events: unknown,
  bundle: TransferBundle,
) {
  const current = await exportAttachments(ctx, events)
  if (JSON.stringify(current) !== JSON.stringify(bundle.attachments))
    throw new MeshError(
      'TRANSFER_CHANGED',
      'session attachments changed; export a new file transfer',
    )
}
