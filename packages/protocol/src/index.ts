import { z } from 'zod'

export const PROTOCOL_VERSION = 1
export const nativeId = z.string().min(1).max(256)
export const integer = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
export const eventSchema = z
  .object({ seq: integer, type: z.string().min(1), time: integer })
  .catchall(z.json())
export type StoredEvent = z.infer<typeof eventSchema>
export const headerSchema = z
  .object({
    id: nativeId,
    version: integer,
    createdAt: integer,
    isSeeded: z.boolean(),
  })
  .catchall(z.json())
export type StoredHeader = z.infer<typeof headerSchema>
export const sessionSchema = z.object({
  id: nativeId,
  incarnation: z.uuid(),
  adapter: z.literal('deepseek'),
  header: headerSchema,
  inheritedEventCount: integer,
  nextSeq: integer,
  generation: integer,
  materialized: z.boolean(),
})
export type SessionSnapshot = z.infer<typeof sessionSchema>
export const createSchema = z.object({
  operationId: z.uuid(),
  instanceId: z.uuid(),
  adapter: z.literal('deepseek'),
  header: headerSchema,
  inheritedEventCount: integer,
})
export const openSchema = z.object({
  operationId: z.uuid(),
  instanceId: z.uuid(),
  access: z.enum(['read', 'write']),
})
export const handleSchema = z.object({
  handleId: z.uuid(),
  session: sessionSchema,
  access: z.enum(['read', 'write']),
  epoch: integer,
})
export type RemoteHandle = z.infer<typeof handleSchema>
export const mutationSchema = z.object({
  operationId: z.uuid(),
  epoch: integer,
})
export const appendSchema = mutationSchema.extend({
  expectedNextSeq: integer,
  events: z.array(eventSchema).max(512),
})
export const readSchema = z.object({
  session: sessionSchema,
  events: z.array(eventSchema),
  end: integer,
  nextOffset: integer,
})
export const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  requestId: z.string().optional(),
})

export class MeshError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly operationId?: string,
  ) {
    super(message)
    this.name = 'MeshError'
  }
}
export function safeInteger(value: unknown, label: string): number {
  const result = integer.safeParse(value)
  if (!result.success)
    throw new MeshError(
      'INVALID_ARGUMENT',
      `${label} must be a non-negative safe integer`,
      400,
    )
  return result.data
}
