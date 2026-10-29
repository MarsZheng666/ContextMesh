import Fastify, { type FastifyRequest } from 'fastify'
import { registerDeviceRoutes } from './devices.js'
import { registerModelRelayRoutes } from './model-relay.js'
import { registerHandoffRoutes } from './handoff.js'
import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { PostgresStore } from '../../../packages/storage-postgres/src/index.js'
import {
  appendSchema,
  createSchema,
  integer,
  mutationSchema,
  openSchema,
  MeshError,
  PROTOCOL_VERSION,
} from '../../../packages/protocol/src/index.js'

export interface ServerOptions {
  store: PostgresStore
  token: string
  namespace?: string
  logger?: boolean
}
export function buildServer(options: ServerOptions) {
  if (options.token.length < 24)
    throw new Error('CONTEXTMESH_TOKEN must contain at least 24 characters')
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 8 * 1024 * 1024,
    requestTimeout: 15000,
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
  })
  const ns = options.namespace ?? 'personal'
  const expected = createHash('sha256').update(options.token).digest()
  const principals = new WeakMap<
    FastifyRequest,
    { id: string; nodeId: string; name: string }
  >()
  app.addHook('onRequest', async (req, reply) => {
    if (
      req.url === '/health/live' ||
      (req.method === 'POST' && req.url === '/v1/pairings/claim')
    )
      return
    const authorization = req.headers.authorization ?? ''
    const supplied = createHash('sha256')
      .update(authorization.startsWith('Bearer ') ? authorization.slice(7) : '')
      .digest()
    if (timingSafeEqual(supplied, expected)) return
    const credential = await options.store.authenticateDevice(
      ns,
      authorization.startsWith('Bearer ') ? authorization.slice(7) : '',
    )
    if (credential) {
      if (
        req.url.startsWith('/v1/pairings') ||
        req.url.startsWith('/v1/device-credentials')
      )
        return reply.code(403).send({
          code: 'OWNER_REQUIRED',
          message: 'use an owner device to manage pairing',
        })
      principals.set(req, credential)
      return
    }
    return reply
      .code(401)
      .send({ code: 'UNAUTHORIZED', message: 'valid bearer token required' })
  })
  app.addHook('preHandler', async (req, reply) => {
    const device = principals.get(req)
    if (!device) return
    const node = /^\/v1\/nodes\/([^/?]+)\//.exec(req.url)?.[1]
    const bodyNode =
      req.body && typeof req.body === 'object' && 'nodeId' in req.body
        ? req.body.nodeId
        : undefined
    if (
      (node && decodeURIComponent(node) !== device.nodeId) ||
      (bodyNode && bodyNode !== device.nodeId)
    )
      return reply.code(403).send({
        code: 'WRONG_DEVICE',
        message: 'credential belongs to another device',
      })
  })
  app.get('/v1/identity', async (req) => ({
    role: principals.has(req) ? 'device' : 'owner',
    nodeId: principals.get(req)?.nodeId ?? null,
  }))
  registerDeviceRoutes(app, options.store, ns, options.token)
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof MeshError)
      return reply
        .code(error.status)
        .send({ code: error.code, message: error.message, requestId: req.id })
    if (
      error instanceof z.ZodError ||
      (error as { validation?: unknown }).validation
    )
      return reply.code(400).send({
        code: 'INVALID_ARGUMENT',
        message: 'request did not match protocol schema',
        requestId: req.id,
      })
    if ((error as { statusCode?: number }).statusCode === 413)
      return reply.code(413).send({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'batch exceeds request limit',
        requestId: req.id,
      })
    req.log.error(
      { requestId: req.id, code: (error as { code?: string }).code },
      'storage request failed',
    )
    return reply.code(503).send({
      code: 'UNAVAILABLE',
      message: 'storage unavailable; operation result may be unknown',
      requestId: req.id,
    })
  })
  const instance = (query: unknown) =>
    z.object({ instanceId: z.uuid() }).parse(query).instanceId
  const id = (params: unknown) =>
    z.object({ id: z.string().min(1).max(256) }).parse(params).id
  const schema = (body: z.ZodType) => ({
    body: z.toJSONSchema(body, { target: 'draft-7' }),
  })
  registerHandoffRoutes(app, options.store, ns)
  registerModelRelayRoutes(app, options.store, ns)
  app.get('/health/live', async () => ({ ok: true }))
  app.get('/health/ready', async () => {
    await options.store.pool.query('SELECT 1')
    return {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      leaseMs: options.store.leaseMs,
      features: [
        'handoff-v1',
        'takeover-v1',
        'project-setup-v1',
        'directory-handoff-v1',
        'model-relay-v1',
        'device-pairing-v1',
      ],
      schemaVersion: 5,
    }
  })
  app.post('/v1/sessions', { schema: schema(createSchema) }, async (req) =>
    options.store.create(ns, createSchema.parse(req.body)),
  )
  app.get('/v1/sessions', async (req) => {
    const q = z
      .object({
        instanceId: z.uuid(),
        after: z.string().max(256).default(''),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query)
    return options.store.list(ns, q.instanceId, q.after, q.limit)
  })
  app.get('/v1/sessions/:id', async (req) => ({
    session: await options.store.stat(ns, id(req.params), instance(req.query)),
  }))
  app.post(
    '/v1/sessions/:id/handles',
    { schema: schema(openSchema) },
    async (req) =>
      options.store.open(ns, id(req.params), openSchema.parse(req.body)),
  )
  app.get('/v1/handles/:id/events', async (req) => {
    const q = z
      .object({
        offset: z.coerce.number().pipe(integer).default(0),
        length: z.coerce
          .number()
          .pipe(integer)
          .refine((n) => n <= 512)
          .default(512),
        end: z.coerce.number().pipe(integer).optional(),
      })
      .parse(req.query)
    return options.store.read(
      ns,
      z.uuid().parse(id(req.params)),
      q.offset,
      q.length,
      q.end,
    )
  })
  app.post(
    '/v1/handles/:id/append',
    { schema: schema(appendSchema) },
    async (req) =>
      options.store.append(
        ns,
        z.uuid().parse(id(req.params)),
        appendSchema.parse(req.body),
      ),
  )
  app.post(
    '/v1/handles/:id/flush',
    { schema: schema(mutationSchema) },
    async (req) =>
      options.store.flush(
        ns,
        z.uuid().parse(id(req.params)),
        mutationSchema.parse(req.body),
      ),
  )
  app.post('/v1/handles/:id/renew', async (req) =>
    options.store.renew(
      ns,
      z.uuid().parse(id(req.params)),
      z.object({ epoch: integer }).parse(req.body).epoch,
    ),
  )
  app.post('/v1/handles/:id/close', async (req) =>
    options.store.close(
      ns,
      z.uuid().parse(id(req.params)),
      mutationSchema.extend({ failed: z.boolean().optional() }).parse(req.body),
    ),
  )
  app.get('/v1/operations/:id', async (req) =>
    options.store.operationResult(ns, z.uuid().parse(id(req.params))),
  )
  app.post('/v1/sessions/:id/recover', async (req) => {
    const r = z
      .object({ operationId: z.uuid(), confirmStopped: z.literal(true) })
      .parse(req.body)
    return options.store.recover(ns, id(req.params), r.operationId)
  })
  return app
}
