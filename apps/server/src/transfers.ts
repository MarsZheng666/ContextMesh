import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PostgresStore } from '../../../packages/storage-postgres/src/index.js'
import {
  transferUpload,
  transferReceipt,
} from '../../../packages/protocol/src/transfers.js'
export function registerTransferRoutes(
  app: FastifyInstance,
  store: PostgresStore,
  ns: string,
) {
  const identity = z.object({ nodeId: z.uuid(), instanceId: z.uuid() })
  const id = (p: unknown) => z.object({ id: z.uuid() }).parse(p).id
  app.post('/v1/workspace-transfers', (req) =>
    store.uploadTransfer(ns, transferUpload.parse(req.body)),
  )
  app.post('/v1/workspace-transfers/list', { bodyLimit: 4096 }, (req) =>
    store.listTransfers(ns, identity.parse(req.body)),
  )
  app.post('/v1/workspace-transfers/:id/read', { bodyLimit: 4096 }, (req) =>
    store.readTransfer(ns, id(req.params), identity.parse(req.body)),
  )
  app.post('/v1/workspace-transfers/:id/receipt', { bodyLimit: 4096 }, (req) =>
    store.receiptTransfer(
      ns,
      id(req.params),
      transferReceipt.extend({ ready: z.boolean() }).parse(req.body),
    ),
  )
}
