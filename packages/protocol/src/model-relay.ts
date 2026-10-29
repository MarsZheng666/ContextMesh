import { z } from 'zod'
import { modelRoute, nodeIdentity } from './handoff.js'

export const modelRelayRequest = nodeIdentity.extend({
  operationId: z.uuid(),
  handleId: z.uuid(),
  epoch: z.number().int().positive(),
  incarnation: z.uuid(),
  historyCut: z.number().int().nonnegative(),
  source: modelRoute.nullable(),
  target: modelRoute,
})
export const modelRelayRecord = modelRelayRequest.extend({
  id: z.uuid(),
  sessionId: z.string(),
  state: z.enum(['prepared', 'completed', 'failed']),
  selectionSeq: z.number().int().nonnegative().nullable(),
})
export type ModelRoute = z.infer<typeof modelRoute>
export type ModelRelayRequest = z.infer<typeof modelRelayRequest>
export type ModelRelayRecord = z.infer<typeof modelRelayRecord>
