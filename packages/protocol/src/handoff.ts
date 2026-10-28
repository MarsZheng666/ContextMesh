import { z } from 'zod'

export const operation = z.object({ operationId: z.uuid() })
export const nodeIdentity = z.object({ nodeId: z.uuid(), instanceId: z.uuid() })
export const nodeRegistration = operation.extend({
  nodeId: z.uuid(),
  instanceId: z.uuid(),
  name: z.string().trim().min(1).max(100),
  capabilities: z.object({
    controlVersion: z.literal(1),
    takeoverVersion: z.literal(1).optional(),
    projectSetupVersion: z.literal(1).optional(),
    directoryHandoffVersion: z.literal(1).optional(),
    harness: z.literal('0.2.1-rc.3'),
    adapter: z.literal('deepseek'),
  }),
})
export const projectRegistration = operation.extend({
  projectId: z.uuid(),
  name: z.string().trim().min(1).max(100),
})
export const mappingRegistration = operation.extend({
  ifAbsent: z.boolean().optional(),
  projectId: z.uuid(),
  nodeId: z.uuid(),
  root: z.string().min(1).max(4096),
})
export const modelRoute = z.object({
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  reasoningEffort: z.string().min(1).max(100).optional(),
})
export const workspaceProof = z
  .object({
    kind: z.enum(['git', 'directory']).optional(),
    projectId: z.uuid(),
    commit: z
      .string()
      .regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
      .nullable(),
    relativeCwd: z
      .string()
      .max(4096)
      .refine(
        (p) =>
          p === '' ||
          (!p.startsWith('/') &&
            !p.includes('\\') &&
            p.split('/').every((s) => s !== '..' && s !== '.' && s !== '')),
      ),
    mappingRevision: z.number().int().positive(),
  })
  .refine((proof) => (proof.kind === 'directory') === (proof.commit === null), {
    message: 'directory proof needs null commit; Git proof needs a commit',
    path: ['commit'],
  })
export const handoffManifest = z.object({
  version: z.literal(1),
  sandbox: z.object({
    mode: z.enum(['read-only', 'workspace-write', 'danger-full-access']),
    relativeRoot: workspaceProof.shape.relativeCwd,
  }),
  workspace: workspaceProof,
  model: modelRoute,
  preset: z.string().min(1).max(200).optional(),
  harness: z.literal('0.2.1-rc.3'),
  adapter: z.literal('deepseek'),
})
export type HandoffManifest = z.infer<typeof handoffManifest>
export const handoffRequest = operation.extend({
  takeoverId: z.uuid().optional(),
  sourceNodeId: z.uuid(),
  sourceInstanceId: z.uuid(),
  targetNodeId: z.uuid(),
  sourceHandleId: z.uuid(),
  sourceEpoch: z.number().int().positive(),
  manifest: handoffManifest,
})
export const handoffUpdate = operation.extend({
  revision: z.number().int().nonnegative(),
  nodeId: z.uuid(),
  instanceId: z.uuid(),
})
export const preflightReport = handoffUpdate.extend({ proof: workspaceProof })
export const failureReport = handoffUpdate.extend({
  phase: z.string().min(1).max(100),
  message: z.string().min(1).max(1000),
  confirmClosed: z.boolean().default(false),
})
export const summaryUpdate = operation.extend({
  instanceId: z.uuid(),
  incarnation: z.uuid(),
  nextSeq: z.number().int().nonnegative(),
  title: z.string().max(500),
  projectId: z.uuid(),
  nodeId: z.uuid(),
  lastActivity: z.number().int().nonnegative(),
})
export const handoffState = z.enum([
  'requested',
  'preparing',
  'ready',
  'activating',
  'completed',
  'cancelled',
  'failed',
  'recovery_required',
])
export type HandoffState = z.infer<typeof handoffState>
export interface HandoffRecord {
  id: string
  sessionId: string
  incarnation: string
  sourceNodeId: string
  sourceInstanceId: string
  targetNodeId: string
  targetInstanceId: string | null
  state: HandoffState
  revision: number
  manifest: HandoffManifest
  finalNextSeq: number | null
  finalGeneration: number | null
  targetHandleId: string | null
  error: string | null
}

export const takeoverRequest = operation.extend({
  nodeId: z.uuid(),
  instanceId: z.uuid(),
  expectedSourceNodeId: z.uuid(),
  confirmed: z.literal(true),
})
export const takeoverRecord = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  incarnation: z.uuid(),
  sourceNodeId: z.uuid(),
  sourceInstanceId: z.uuid(),
  sourceHandleId: z.uuid(),
  sourceEpoch: z.number().int().positive(),
  targetNodeId: z.uuid(),
  targetInstanceId: z.uuid(),
  handoffOperationId: z.uuid(),
  state: z.enum(['requested', 'linked', 'failed']),
  handoffId: z.uuid().nullable(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  expiresAt: z.number(),
})
export type TakeoverRecord = z.infer<typeof takeoverRecord>

export const projectAssignment = operation.extend({
  nodeId: z.uuid(),
  instanceId: z.uuid(),
  incarnation: z.uuid(),
  expectedSourceNodeId: z.uuid(),
  projectId: z.uuid(),
})
