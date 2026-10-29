import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PostgresStore } from '../../../packages/storage-postgres/src/index.js'
import {
  pairingCreate,
  pairingClaim,
} from '../../../packages/protocol/src/devices.js'
export function registerDeviceRoutes(
  app: FastifyInstance,
  store: PostgresStore,
  ns: string,
  secret: string,
) {
  app.post('/v1/pairings', { bodyLimit: 4096 }, (req) =>
    store.createPairing(ns, secret, pairingCreate.parse(req.body)),
  )
  app.post('/v1/pairings/claim', { bodyLimit: 4096 }, (req) =>
    store.claimPairing(ns, secret, pairingClaim.parse(req.body)),
  )
  app.get('/v1/device-credentials', () => store.deviceCredentials(ns))
  app.post('/v1/device-credentials/:id/revoke', (req) =>
    store.revokeDevice(ns, z.object({ id: z.uuid() }).parse(req.params).id),
  )
}
