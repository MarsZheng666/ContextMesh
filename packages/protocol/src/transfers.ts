import { z } from 'zod'
export const MAX_TRANSFER_BYTES = 4 * 1024 * 1024
export const MAX_FILE_BYTES = 1024 * 1024
export const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const commitId = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
export const transferPath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => {
    if (p !== p.normalize('NFC') || /[\\\x00-\x1f\x7f:]/.test(p)) return false
    return p
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/^(?:\.git|\.hg|\.svn|\.ssh|\.aws|\.codex|\.dsh|node_modules|\.contextmesh|\.credentials.*|credentials(?:\..*)?|secrets?(?:\..*)?|auth\.json|tokens?\.json|\.npmrc|\.netrc|\.pypirc|\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(
            part,
          ),
      )
  }, 'unsafe or sensitive transfer path')
const encoded = z
  .string()
  .max(Math.ceil(MAX_FILE_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
export const transferFile = z.object({
  path: transferPath,
  baseHash: digest.nullable(),
  hash: digest.nullable(),
  baseMode: z.enum(['100644', '100755']).nullable(),
  mode: z.enum(['100644', '100755']).nullable(),
  data: encoded.nullable(),
})
export const fileRef = z.object({
  attachmentId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !/[\\/\x00-\x1f]/.test(n)),
  bytes: z.number().int().min(0).max(MAX_FILE_BYTES),
})
export const transferAttachment = z.object({ ref: fileRef, data: encoded })
export const transferBundle = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1).max(256),
    incarnation: z.uuid(),
    projectId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    baseCommit: commitId.nullable(),
    treeHash: digest,
    files: z.array(transferFile).max(64),
    attachments: z.array(transferAttachment).max(32),
  })
  .refine(
    (b) =>
      b.sourceNodeId !== b.targetNodeId &&
      (b.baseCommit !== null || b.files.length === 0),
  )
export type TransferBundle = z.infer<typeof transferBundle>
export type TransferFile = z.infer<typeof transferFile>
export const transferUpload = z.object({
  operationId: z.uuid(),
  nodeId: z.uuid(),
  instanceId: z.uuid(),
  bundle: transferBundle,
})
export const transferReceipt = z.object({
  nodeId: z.uuid(),
  instanceId: z.uuid(),
  digest,
})
export interface TransferRecord {
  id: string
  digest: string
  bundle: TransferBundle
  ready: boolean
  expiresAt: number
}
export const transferSummarySchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  projectId: z.uuid(),
  sourceNodeId: z.uuid(),
  targetNodeId: z.uuid(),
  digest,
  treeHash: digest,
  baseCommit: commitId.nullable(),
  ready: z.boolean(),
  expiresAt: z.number(),
  bytes: z.number().nonnegative(),
  files: z.array(
    z.object({
      path: transferPath,
      action: z.enum(['add', 'change', 'delete']),
    }),
  ),
  attachments: z.array(
    z.object({ name: z.string(), bytes: z.number().nonnegative() }),
  ),
})
export type TransferSummary = z.infer<typeof transferSummarySchema>
