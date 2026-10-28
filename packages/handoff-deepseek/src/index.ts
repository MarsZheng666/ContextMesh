import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { HandoffCoordinator } from './coordinator.js'
import { listenLocal } from './local-control.js'

export const name = 'contextmesh-handoff'
export const inject = [
  'agentLoop',
  'agents',
  'contextmesh',
  'sessions',
  'workingDirectory',
  'llm',
  'sandboxPolicy',
]
export interface Config {
  stateDir?: string
  nodeName?: string
  pollMs?: number
  heartbeatMs?: number
  waitIdleMs?: number
}
export const Config: schema<Config> = schema.object({
  stateDir: schema.string(),
  nodeName: schema.string(),
  pollMs: schema.natural().min(50).default(2000),
  heartbeatMs: schema.natural().min(100).default(15000),
  waitIdleMs: schema.natural().min(100).default(30000),
})
declare module '@deepseek-ai/cordis' {
  interface Context {
    contextmeshHandoff: HandoffCoordinator
  }
}

export async function apply(ctx: Context, config: Config) {
  const home = process.env.DSH_HOME
  const stateDir =
    config.stateDir ?? (home ? join(home, 'contextmesh') : undefined)
  if (!stateDir)
    throw new Error('Set DSH_HOME or configure ContextMesh stateDir')
  const service = await HandoffCoordinator.start(ctx, {
    stateDir,
    nodeName: config.nodeName ?? hostname(),
    pollMs: config.pollMs ?? 2000,
    heartbeatMs: config.heartbeatMs ?? 15000,
    waitIdleMs: config.waitIdleMs ?? 30000,
  })
  let local: Awaited<ReturnType<typeof listenLocal>> | undefined
  ctx.effect(
    () => async () => {
      try {
        await service.close()
      } finally {
        await local?.close()
      }
    },
    'contextmesh: controller shutdown',
  )
  local = await listenLocal(stateDir, (command) => service.command(command))
  ctx.provide('contextmeshHandoff', service)
  ctx.inject(['sessionController'], (nativeCtx) => {
    if (nativeCtx.sessionController.modelRelayVersion !== 1)
      throw new Error('Install the pinned ContextMesh model relay bridge')
    nativeCtx.effect(
      () =>
        nativeCtx.sessionController.installModelRelay(
          (request) =>
            service.command({ action: 'select-model', ...request }) as Promise<{
              selected: typeof request
            }>,
        ),
      'contextmesh: durable model selection',
    )
  })
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () =>
        connectionCtx.connection.fetch.register({
          path: '/api/contextmesh',
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            try {
              const value = await service.command(
                request.method === 'GET'
                  ? { action: 'status' }
                  : await request.json(),
              )
              return Response.json(
                { ok: true, value },
                { headers: { 'cache-control': 'no-store' } },
              )
            } catch (error) {
              return Response.json(
                {
                  ok: false,
                  error: {
                    code:
                      error && typeof error === 'object' && 'code' in error
                        ? error.code
                        : 'FAILED',
                    message:
                      error instanceof Error ? error.message : String(error),
                  },
                },
                { status: 400, headers: { 'cache-control': 'no-store' } },
              )
            }
          },
        }),
      'contextmesh: authenticated control route',
    )
  })
}
