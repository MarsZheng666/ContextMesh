import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  archiveBlock,
  archiveBlockBytes,
  archiveIdSchema,
  archiveManifest,
  archiveSearch,
} from '../../../packages/protocol/src/archives.js'
import type { PostgresStore } from '../../../packages/storage-postgres/src/index.js'

const sequence = z.coerce.number().int().nonnegative()
const id = z.object({ id: archiveIdSchema })
const entry = id.extend({ seq: sequence })
const range = z.object({
  offset: sequence.default(0),
  length: sequence.min(1).max(archiveBlockBytes).default(archiveBlockBytes),
})
const index = z.object({
  after: sequence.optional(),
  limit: sequence.min(1).max(64).default(32),
  order: z.enum(['asc', 'desc']).default('asc'),
  role: z.enum(['user', 'assistant', 'reference']).optional(),
  terms: z
    .string()
    .max(2400)
    .optional()
    .transform((value) => (value ? value.split(' ') : []))
    .pipe(archiveSearch),
  textOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

export function registerArchiveRoutes(
  app: FastifyInstance,
  store: PostgresStore,
  ns: string,
  principal: (request: FastifyRequest) => string,
  quota: number,
) {
  app.post('/v2/archive-uploads', { bodyLimit: 8192 }, (req) =>
    store.beginArchive(
      ns,
      principal(req),
      archiveManifest.parse(req.body),
      quota,
    ),
  )
  app.get('/v2/archive-uploads/:id', (req) =>
    store.archiveUpload(ns, principal(req), id.parse(req.params).id),
  )
  app.post(
    '/v2/archive-uploads/:id/blocks/:seq',
    { bodyLimit: 720 * 1024 },
    (req) => {
      const params = entry.parse(req.params)
      return store.putArchiveBlock(
        ns,
        principal(req),
        params.id,
        params.seq,
        archiveBlock.parse(req.body),
      )
    },
  )
  app.post('/v2/archive-uploads/:id/commit', { bodyLimit: 4096 }, (req) =>
    store.commitArchive(ns, principal(req), id.parse(req.params).id),
  )
  app.get('/v2/archives', (req) => {
    const { after } = z
      .object({ after: archiveIdSchema.optional() })
      .parse(req.query)
    return store.archiveCatalog(ns, after)
  })
  app.get('/v2/archives/:id', (req) =>
    store.archiveInfo(ns, id.parse(req.params).id),
  )
  app.get('/v2/archives/:id/records', (req) =>
    store.archiveIndex(ns, id.parse(req.params).id, index.parse(req.query)),
  )
  app.get('/v2/archives/:id/records/:seq/content', (req) => {
    const params = entry.parse(req.params)
    const { offset, length } = range.parse(req.query)
    return store.archiveRecordContent(ns, params.id, params.seq, offset, length)
  })
  let timer: ReturnType<typeof setInterval> | undefined
  app.addHook('onReady', async () => {
    timer = setInterval(
      () => {
        void store
          .pruneArchiveUploads(ns)
          .catch(() => app.log.warn('Archive staging cleanup failed'))
      },
      5 * 60 * 1000,
    )
    timer.unref()
  })
  app.addHook('onClose', async () => clearInterval(timer))
}
