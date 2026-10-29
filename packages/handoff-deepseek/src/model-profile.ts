import { z } from 'zod'
export const modelProfile = z.object({
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  contextWindow: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  textInput: z.boolean().optional(),
  tools: z.boolean().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
})
export type ModelProfile = z.infer<typeof modelProfile>
export type CapacityMode = 'conservative' | 'estimated'
export const capacityMode = z.enum(['conservative', 'estimated'])
