import { afterEach, inject, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { PostgresStore } from '../packages/storage-postgres/src/index.js'
import { buildServer } from '../apps/server/src/app.js'
import { MeshClient } from '../packages/client/src/index.js'
import * as Plugin from '../packages/adapter-deepseek/src/index.js'

export const TOKEN = 'contextmesh-test-token-at-least-24-characters'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse())
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  if (errors.length) throw new AggregateError(errors, 'fixture cleanup failed')
})
export async function fixture() {
  const namespace = `test-${randomUUID()}`
  const store = new PostgresStore({ connectionString: inject('databaseUrl') })
  await store.init()
  const app = buildServer({ store, token: TOKEN, namespace })
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 })
  const contexts: Context[] = []
  const mount = async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(Plugin, {
      endpoint,
      token: TOKEN,
      batchDelayMs: 200,
      renewalMs: 15000,
      timeoutMs: 2000,
    })
    return ctx
  }
  cleanups.push(async () => {
    const results = await Promise.allSettled(
      contexts.map((c) => c.fiber.dispose()),
    )
    await app.close()
    for (const table of [
      'cm_session_summaries',
      'cm_handoffs',
      'cm_project_mappings',
      'cm_projects',
      'cm_nodes',
      'cm_events',
      'cm_handles',
      'cm_operations',
      'cm_sessions',
    ])
      await store.pool.query(`DELETE FROM ${table} WHERE namespace=$1`, [
        namespace,
      ])
    await store.stop()
    const errors = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : [],
    )
    if (errors.length)
      throw new AggregateError(errors, 'context teardown failed')
  })
  return {
    defer: (cleanup: () => Promise<void>) => {
      cleanups.push(cleanup)
    },
    store,
    app,
    namespace,
    endpoint,
    mount,
    client: new MeshClient({ endpoint, token: TOKEN, timeoutMs: 2000 }),
  }
}
