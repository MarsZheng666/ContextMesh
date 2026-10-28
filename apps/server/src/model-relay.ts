import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PostgresStore } from '../../../packages/storage-postgres/src/index.js'
import { nodeIdentity } from '../../../packages/protocol/src/handoff.js'
import { modelRelayRequest } from '../../../packages/protocol/src/model-relay.js'

export function registerModelRelayRoutes(
  app: FastifyInstance,
  store: PostgresStore,
  ns: string,
) {
  const id = (params: unknown) =>
    z.object({ id: z.string().min(1).max(256) }).parse(params).id
  app.post('/v1/sessions/:id/model-relays', (req) =>
    store.prepareModelRelay(
      ns,
      id(req.params),
      modelRelayRequest.parse(req.body),
    ),
  )
  app.get('/v1/model-relays/:id', (req) =>
    store.getModelRelay(ns, z.uuid().parse(id(req.params))),
  )
  app.get('/v1/nodes/:id/model-relays', (req) =>
    store.pendingModelRelays(ns, z.uuid().parse(id(req.params))),
  )
  app.post('/v1/model-relays/:id/finish', (req) =>
    store.finishModelRelay(
      ns,
      z.uuid().parse(id(req.params)),
      nodeIdentity.extend({ cancel: z.boolean().optional() }).parse(req.body),
    ),
  )
}
