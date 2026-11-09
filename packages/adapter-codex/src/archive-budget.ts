import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  archiveTokenBound,
  type ArchiveBudget,
} from '../../client/src/resume-archive.js'
import { optionalJson } from '../../runtime-manager/src/files.js'
import type { NativeCodex, StartTarget, Target } from './native.js'

const size = z.int().positive().max(10000000)
const configSchema = z.object({
  model: z.string().nullable().optional(),
  model_provider: z.string().nullable().optional(),
  model_context_window: size.nullable().optional(),
  model_auto_compact_token_limit: size.nullable().optional(),
  instructions: z.string().nullable().optional(),
  developer_instructions: z.string().nullable().optional(),
})
const cacheSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      context_window: size.optional(),
      effective_context_window_percent: z.number().gt(0).max(100).optional(),
    }),
  ),
})

export async function resolveArchiveTarget(
  native: NativeCodex,
  requested: StartTarget,
  explicit?: number,
) {
  const config = z.object({ config: configSchema }).parse(
    await native.rpc.request('config/read', {
      cwd: requested.cwd,
      includeLayers: false,
    }),
  ).config
  const { target } = await native.start(
    requested,
    {
      'features.hooks': false,
      'features.plugins': false,
      'features.apps': false,
    },
    undefined,
    true,
  )
  return {
    target,
    budget: await codexArchiveBudget(native, target, explicit, config),
  }
}

export async function codexArchiveBudget(
  native: NativeCodex,
  target: Target,
  explicit?: number,
  resolved?: z.infer<typeof configSchema>,
): Promise<ArchiveBudget> {
  const config =
    resolved ??
    z.object({ config: configSchema }).parse(
      await native.rpc.request('config/read', {
        cwd: target.cwd,
        includeLayers: false,
      }),
    ).config
  const sameRoute =
    (!config.model || config.model === target.model) &&
    (!config.model_provider || config.model_provider === target.provider)
  const configured = sameRoute ? config.model_context_window : undefined
  const cache =
    target.provider === 'openai'
      ? cacheSchema.safeParse(
          await optionalJson(
            join(
              native.rpc.options.env?.CODEX_HOME ??
                process.env.CODEX_HOME ??
                join(homedir(), '.codex'),
              'models_cache.json',
            ),
          ).catch(() => undefined),
        )
      : undefined
  const model = cache?.success
    ? cache.data.models.find((model) => model.slug === target.model)
    : undefined
  const cached = model?.context_window
    ? Math.floor(
        (model.context_window *
          (model.effective_context_window_percent ?? 100)) /
          100,
      )
    : undefined
  const localLimit = size
    .optional()
    .parse(
      explicit ??
        (process.env.CONTEXTMESH_CODEX_CONTEXT_WINDOW
          ? Number(process.env.CONTEXTMESH_CODEX_CONTEXT_WINDOW)
          : undefined),
    )
  const windows = [configured, cached, localLimit].filter(
    (value): value is number => typeof value === 'number',
  )
  if (!windows.length)
    throw new Error(
      'Codex did not report a context window for this model. Set a conservative context window for this import.',
    )
  const contextWindow = Math.min(
    ...windows,
    sameRoute ? (config.model_auto_compact_token_limit ?? Infinity) : Infinity,
  )
  return {
    contextWindow,
    outputReserve: Math.min(8192, Math.floor(contextWindow / 5)),
    fixedTokens:
      Math.min(8192, Math.floor(contextWindow / 5)) +
      archiveTokenBound([config.instructions, config.developer_instructions]),
    route: target.provider + '/' + target.model,
  }
}
