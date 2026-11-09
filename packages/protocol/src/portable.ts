import { z } from 'zod'
import { createHash } from 'node:crypto'
import { integer, nativeAdapterId, nativeId } from './index.js'

export const portableContextMaxBytes = 1024 * 1024
export const portableContextMaxMessages = 10000

export const portableMessage = z
  .object({
    role: z.enum(['user', 'assistant', 'reference']),
    text: z.string().max(portableContextMaxBytes),
  })
  .strict()
export const portableContext = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        adapter: nativeAdapterId,
        id: nativeId,
        incarnation: z.uuid(),
        eventCount: integer,
      })
      .strict(),
    messages: z.array(portableMessage).max(portableContextMaxMessages),
  })
  .strict()
export type PortableContext = z.infer<typeof portableContext>
export function validatePortable(input: unknown): PortableContext {
  const parsed = portableContext.parse(input)
  if (Buffer.byteLength(JSON.stringify(parsed)) > portableContextMaxBytes)
    throw new Error(
      'Context exceeds the portable import limit; no history was truncated',
    )
  return parsed
}
export const contextDigest = (context: PortableContext) =>
  createHash('sha256')
    .update(JSON.stringify(validatePortable(context)))
    .digest('hex')
