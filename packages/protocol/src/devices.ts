import { z } from 'zod'
export const deviceName = z.string().trim().min(1).max(80)
export const pairingCreate = z.object({
  operationId: z.uuid(),
  name: deviceName,
  ttlSeconds: z.number().int().min(30).max(600).default(600),
})
export const pairingClaim = z.object({
  code: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  claimId: z.uuid(),
})
export const deviceConnection = z.object({
  version: z.literal(1),
  endpoint: z.string().url(),
  token: z.string().min(24),
  nodeId: z.uuid(),
  name: deviceName,
})
export type DeviceConnection = z.infer<typeof deviceConnection>
