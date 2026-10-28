import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PostgresStore } from '../../../packages/storage-postgres/src/index.js'
import {
  takeoverRequest,
  projectAssignment,
  nodeRegistration,
  nodeIdentity,
  projectRegistration,
  mappingRegistration,
  handoffRequest,
  handoffUpdate,
  preflightReport,
  failureReport,
  summaryUpdate,
} from '../../../packages/protocol/src/handoff.js'

export function registerHandoffRoutes(
  app: FastifyInstance,
  store: PostgresStore,
  ns: string,
) {
  const id = (params: unknown) => z.object({ id: z.uuid() }).parse(params).id
  const sessionId = (params: unknown) =>
    z.object({ id: z.string().min(1).max(256) }).parse(params).id
  app.post('/v1/nodes/:id/offline', (req) =>
    store.offlineNode(ns, {
      nodeId: id(req.params),
      instanceId: z.object({ instanceId: z.uuid() }).parse(req.body).instanceId,
    }),
  )
  app.get('/v1/nodes', () => store.listNodes(ns))
  app.post('/v1/nodes/register', (req) =>
    store.registerNode(ns, nodeRegistration.parse(req.body)),
  )
  app.post('/v1/nodes/:id/heartbeat', (req) =>
    store.heartbeatNode(
      ns,
      nodeIdentity.parse({
        ...z.object({ instanceId: z.uuid() }).parse(req.body),
        nodeId: id(req.params),
      }),
    ),
  )
  app.get('/v1/nodes/:id/commands', (req) =>
    store.nodeCommands(ns, {
      nodeId: id(req.params),
      instanceId: z.object({ instanceId: z.uuid() }).parse(req.query)
        .instanceId,
    }),
  )
  app.get('/v1/projects', () => store.listProjects(ns))
  app.post('/v1/projects', (req) =>
    store.registerProject(ns, projectRegistration.parse(req.body)),
  )
  app.get('/v1/nodes/:id/mappings', (req) => store.mappings(ns, id(req.params)))
  app.post('/v1/mappings', (req) =>
    store.setMapping(ns, mappingRegistration.parse(req.body)),
  )
  app.post('/v1/sessions/:id/project', (req) =>
    store.assignProject(
      ns,
      sessionId(req.params),
      projectAssignment.parse(req.body),
    ),
  )
  app.get('/v1/remote-sessions', () => store.listSummaries(ns))
  app.post('/v1/sessions/:id/summary', (req) =>
    store.updateSummary(
      ns,
      sessionId(req.params),
      summaryUpdate.parse(req.body),
    ),
  )
  app.post('/v1/sessions/:id/handoffs', (req) =>
    store.requestHandoff(
      ns,
      sessionId(req.params),
      handoffRequest.parse(req.body),
    ),
  )
  app.post('/v1/sessions/:id/takeovers', (req) =>
    store.requestTakeover(
      ns,
      sessionId(req.params),
      takeoverRequest.parse(req.body),
    ),
  )
  app.get('/v1/nodes/:id/takeovers', (req) =>
    store.pendingTakeovers(ns, {
      nodeId: id(req.params),
      instanceId: z.object({ instanceId: z.uuid() }).parse(req.query)
        .instanceId,
    }),
  )
  app.get('/v1/takeovers/:id', (req) => store.getTakeover(ns, id(req.params)))
  app.post('/v1/takeovers/:id/fail', (req) =>
    store.failTakeover(
      ns,
      id(req.params),
      z
        .object({
          nodeId: z.uuid(),
          instanceId: z.uuid(),
          code: z.string().min(1).max(100),
          message: z.string().min(1).max(1000),
        })
        .parse(req.body),
    ),
  )
  app.get('/v1/handoffs/:id', (req) => store.getHandoff(ns, id(req.params)))
  app.post('/v1/handoffs/:id/preflight', (req) =>
    store.preflightHandoff(ns, id(req.params), preflightReport.parse(req.body)),
  )
  app.post('/v1/handoffs/:id/finalize', (req) =>
    store.finalizeHandoff(ns, id(req.params), handoffUpdate.parse(req.body)),
  )
  app.post('/v1/handoffs/:id/accept', (req) =>
    store.acceptHandoff(ns, id(req.params), preflightReport.parse(req.body)),
  )
  app.post('/v1/handoffs/:id/complete', (req) =>
    store.completeHandoff(
      ns,
      id(req.params),
      handoffUpdate
        .extend({ nextSeq: z.number().int().nonnegative() })
        .parse(req.body),
    ),
  )
  app.post('/v1/handoffs/:id/cancel', (req) =>
    store.cancelHandoff(ns, id(req.params), handoffUpdate.parse(req.body)),
  )
  app.post('/v1/handoffs/:id/fail', (req) =>
    store.failHandoff(ns, id(req.params), failureReport.parse(req.body)),
  )
  app.post('/v1/handoffs/:id/recover', (req) =>
    store.recoverHandoff(
      ns,
      id(req.params),
      z
        .object({
          operationId: z.uuid(),
          revision: z.number().int().nonnegative(),
          confirmStopped: z.literal(true),
        })
        .parse(req.body),
    ),
  )
}
