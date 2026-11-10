import type { FastifyInstance, FastifyRequest } from 'fastify'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { PostgresStore } from '../../../packages/storage-postgres/src/index.js'
import {
  sharedCreate,
  sharedAppend,
  sharedActivity,
  sharedSource,
} from '../../../packages/protocol/src/shared.js'
import {
  archiveBlock,
  archiveBlockBytes,
  archiveIdSchema,
} from '../../../packages/protocol/src/archives.js'

export function registerSharedRoutes(
  app: FastifyInstance,
  store: PostgresStore,
  ns: string,
  principal: (req: FastifyRequest) => string,
  quota: number,
) {
  const id = z.object({ id: z.uuid() })
  const count = z.coerce.number().int().nonnegative()
  app.get('/v2/shared-sessions', async () => ({
    shares: await store.listShared(ns),
  }))
  app.get('/v2/shared-sessions/find', (req) => {
    const input = sharedSource.omit({ incarnation: true }).parse(req.query)
    return store.findShared(ns, input.adapter, input.id)
  })
  app.post('/v2/shared-sessions', { bodyLimit: 4096 }, (req) =>
    store.createShared(ns, principal(req), sharedCreate.parse(req.body)),
  )
  app.post('/v2/shared-blocks/:digest', { bodyLimit: 720 * 1024 }, (req) => {
    const { digest } = z
      .object({ digest: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(req.params)
    const { data } = archiveBlock.parse(req.body)
    return store.putSharedBlock(ns, digest, Buffer.from(data, 'base64'), quota)
  })
  app.post(
    '/v2/shared-sessions/:id/events',
    { bodyLimit: 8 * 1024 * 1024 },
    (req) =>
      store.appendShared(
        ns,
        principal(req),
        id.parse(req.params).id,
        sharedAppend.parse(req.body),
      ),
  )
  app.post('/v2/shared-sessions/:id/activity', { bodyLimit: 4096 }, (req) =>
    store.sharedActivity(
      ns,
      principal(req),
      id.parse(req.params).id,
      sharedActivity.parse(req.body),
    ),
  )
  app.post('/v2/shared-sessions/:id/adopt-codex', (req) =>
    store.adoptSharedCodex(
      ns,
      principal(req),
      id.parse(req.params).id,
      z
        .object({
          generation: count,
          targetSessionId: z.string().min(1),
          threadId: z.uuid(),
          writerToken: z.string().min(32).max(128),
        })
        .strict()
        .parse(req.body),
    ),
  )
  app.post('/v2/shared-sessions/:id/reserve', (req) =>
    store.reserveShared(
      ns,
      id.parse(req.params).id,
      z
        .object({
          generation: count,
          operationId: z.uuid(),
          cut: count,
          archiveId: archiveIdSchema,
        })
        .strict()
        .parse(req.body),
    ),
  )
  app.post('/v2/shared-sessions/:id/commit-dsh', (req) =>
    store.commitSharedDsh(
      ns,
      id.parse(req.params).id,
      z
        .object({ operationId: z.uuid(), targetSessionId: z.string().min(1) })
        .strict()
        .parse(req.body),
    ),
  )
  const stopping = new AbortController()
  app.addHook('onClose', async () => stopping.abort())
  app.get('/v2/shared-sessions/:id/events', async (req) => {
    const input = z
      .object({ after: count.default(0), wait: count.max(4000).default(0) })
      .parse(req.query)
    const key = id.parse(req.params).id
    const deadline = Date.now() + input.wait
    let page = await store.pullShared(ns, key, input.after)
    while (
      !page.events.length &&
      !page.more &&
      Date.now() < deadline &&
      !stopping.signal.aborted &&
      !req.raw.destroyed
    ) {
      await delay(Math.min(250, deadline - Date.now()), undefined, {
        signal: stopping.signal,
      }).catch(() => {})
      if (stopping.signal.aborted) break
      page = await store.pullShared(ns, key, input.after)
    }
    return page
  })
  app.get('/v2/shared-sessions/:id/events/:seq/content', (req) => {
    const params = id.extend({ seq: count }).parse(req.params)
    const range = z
      .object({
        offset: count.default(0),
        length: count.min(1).max(archiveBlockBytes).default(16384),
      })
      .parse(req.query)
    return store.sharedText(
      ns,
      params.id,
      params.seq,
      range.offset,
      range.length,
    )
  })
}
