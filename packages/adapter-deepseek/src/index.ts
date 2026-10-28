import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { isDeepStrictEqual } from 'node:util'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { isAbsolute } from 'node:path'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionPersistenceNotFoundError,
  SessionReadOnlyError,
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError,
  assertVersion,
  assertStoredId,
  assertContiguous,
  materializeCreateHeader,
  materializeAppendBatch,
  validateStoredEvents,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceStatOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceSnapshot,
  type SessionHandle,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
} from '@deepseek-ai/dsh-session-persistence'
import {
  SessionLogOffset,
  SessionId as makeSessionId,
  SESSION_FORMAT_VERSION,
  type Session,
  type SessionHeader,
  type SessionId,
  type SessionEvent,
} from '@deepseek-ai/dsh-session'
import { MeshClient } from '../../client/src/index.js'
import {
  headerSchema,
  eventSchema,
  MeshError,
  type RemoteHandle,
  type SessionSnapshot,
  type StoredEvent,
} from '../../protocol/src/index.js'

export const name = 'contextmesh-session-persistence'
export const inject = ['sessions']
export interface Config {
  endpoint: string
  token?: string
  tokenEnv?: string
  batchDelayMs?: number
  timeoutMs?: number
  renewalMs?: number
  allowInsecureHttp?: boolean
}
export const Config: schema<Config> = schema.object({
  endpoint: schema.string().default('http://127.0.0.1:8787'),
  token: schema.string(),
  tokenEnv: schema.string().default('CONTEXTMESH_TOKEN'),
  batchDelayMs: schema.natural().min(1).default(200),
  timeoutMs: schema.natural().min(100).default(10000),
  renewalMs: schema.natural().min(100).default(15000),
  allowInsecureHttp: schema.boolean().default(false),
})
function mapped(error: unknown, id: SessionId, op: string): unknown {
  if (!(error instanceof MeshError)) return error
  switch (error.code) {
    case 'NOT_FOUND':
      return new SessionPersistenceNotFoundError(id)
    case 'ALREADY_EXISTS':
      return new SessionAlreadyExistsError(id)
    case 'ALREADY_OWNED':
      return new SessionAlreadyOwnedError(id)
    case 'HANDLE_CLOSED':
      return new SessionHandleClosedError(id, op)
    case 'READ_ONLY':
      return new SessionReadOnlyError(id, op)
    case 'OWNERSHIP_LOST':
      return new SessionOwnershipLostError(id)
    case 'FORMAT_UNSUPPORTED':
      return new SessionFormatUnsupportedError(error.message)
    case 'CORRUPTION':
      return new SessionPersistenceCorruptionError(error.message, {
        cause: error,
      })
    default:
      return error
  }
}
const nativeHeader = z
  .object({
    id: z.string().transform(makeSessionId),
    version: z.literal(SESSION_FORMAT_VERSION),
    createdAt: z.number().int().nonnegative(),
    isSeeded: z.boolean(),
    cwd: z.string().refine(isAbsolute).optional(),
    parentSession: z.string().transform(makeSessionId).optional(),
    origin: z.literal('subagent').optional(),
    delegationDepth: z.number().int().nonnegative().optional(),
    agentPreset: z.string().optional(),
  })
  .passthrough()
function storedHeader(snapshot: SessionSnapshot): SessionHeader {
  assertVersion({
    id: makeSessionId(snapshot.header.id),
    version: snapshot.header.version,
  })
  return materializeCreateHeader(nativeHeader.parse(snapshot.header))
}
function decodedEvents(header: SessionHeader, input: unknown): SessionEvent[] {
  // The native public validator owns the merge-extensible event grammar at this wire boundary.
  const events = input as SessionEvent[]
  validateStoredEvents(header, events)
  return events
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    contextmesh: RemoteSessionPersistence
  }
}
export class RemoteSessionPersistence extends SessionPersistence {
  private readonly claims = new AsyncLocalStorage<{
    remote: RemoteHandle
    used: boolean
  }>()
  private readonly lostListeners = new Set<(id: SessionId) => void>()
  onOwnershipLost(listener: (id: SessionId) => void): () => void {
    this.lostListeners.add(listener)
    return () => {
      this.lostListeners.delete(listener)
    }
  }
  ownershipLost(id: SessionId): void {
    for (const listener of this.lostListeners) {
      try {
        listener(id)
      } catch (error) {
        this.report(`ownership listener failed: ${String(error)}`)
      }
    }
  }
  writerClaim(id: SessionId): RemoteHandle {
    const writer = this.writers.get(id)
    if (!writer) throw new SessionOwnershipLostError(id)
    return writer.claim()
  }
  async withClaim<T>(remote: RemoteHandle, run: () => Promise<T>): Promise<T> {
    if (remote.access !== 'write' || this.writers.has(remote.session.id))
      throw new Error('handoff claim is not available for adoption')
    const slot = { remote, used: false }
    return this.claims.run(slot, async () => {
      try {
        const result = await run()
        if (!slot.used) throw new Error('resume did not consume handoff claim')
        return result
      } finally {
        if (!slot.used) await this.client.close(remote, randomUUID())
      }
    })
  }

  readonly handles = new Set<RemoteSessionHandle>()
  readonly writers = new Map<string, RemoteSessionHandle>()
  private readonly acquisitions = new Set<Promise<SessionHandle>>()
  private stopping = false
  constructor(
    ctx: Context,
    readonly client: MeshClient,
    readonly config: Config,
  ) {
    super(ctx)
  }
  private acquire(run: () => Promise<SessionHandle>): Promise<SessionHandle> {
    if (this.stopping)
      return Promise.reject(new Error('ContextMesh provider is stopping'))
    const result = run()
    this.acquisitions.add(result)
    void result.finally(() => this.acquisitions.delete(result)).catch(() => {})
    return result
  }
  async shutdown(): Promise<void> {
    this.stopping = true
    await Promise.allSettled([...this.acquisitions])
    const results = await Promise.allSettled(
      [...this.handles].map((h) => h.close()),
    )
    const errors = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : [],
    )
    if (errors.length)
      throw new AggregateError(errors, 'ContextMesh teardown failed')
  }
  report(message: string): void {
    this.ctx.logger.warn(message)
  }
  private adopt(remote: RemoteHandle): RemoteSessionHandle {
    const handle = new RemoteSessionHandle(this, remote)
    this.handles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }
  async create(
    header: SessionHeader,
    options?: SessionPersistenceCreateOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    assertVersion(snapshot)
    const count = options?.inheritedEventCount ?? 0
    if (
      !Number.isSafeInteger(count) ||
      count < 0 ||
      (!header.isSeeded && count !== 0) ||
      (header.isSeeded && options?.inheritedEventCount === undefined)
    )
      throw new TypeError('inheritedEventCount must match seeded header')
    try {
      return await this.acquire(async () =>
        this.adopt(
          await this.client.create(
            headerSchema.parse(snapshot),
            count,
            options?.signal,
          ),
        ),
      )
    } catch (error) {
      throw mapped(error, header.id, 'create')
    }
  }
  async open(
    id: SessionId,
    access: 'read' | 'write',
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    return this.acquire(() => this.openHandle(id, access, options))
  }
  private async openHandle(
    id: SessionId,
    access: 'read' | 'write',
    options?: SessionPersistenceOpenOptions,
  ): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    let handle: RemoteSessionHandle | undefined
    let remote: RemoteHandle | undefined
    try {
      const slot = this.claims.getStore()
      if (access === 'write' && slot) {
        if (slot.used || slot.remote.session.id !== id)
          throw new Error(
            'handoff claim must be consumed exactly once by its Session',
          )
        slot.used = true
        remote = slot.remote
        await this.client.renew(remote)
      } else remote = await this.client.open(id, access, options?.signal)
      assertStoredId(id, storedHeader(remote.session))
      handle = this.adopt(remote)
      // A write open validates the complete log before returning ownership to a driver.
      if (access === 'write') await handle.read(0, undefined, options)
      return handle
    } catch (error) {
      if (handle) await handle.close()
      else if (remote) await this.client.close(remote, randomUUID())
      throw mapped(error, id, 'open')
    }
  }
  private observation(snapshot: SessionSnapshot): SessionPersistenceSnapshot {
    return {
      header: structuredClone(storedHeader(snapshot)),
      revision: SessionPersistenceRevision(
        `${snapshot.incarnation}:${snapshot.generation}`,
      ),
      eventCount: snapshot.nextSeq,
      formatStatus: 'current',
    }
  }
  async stat(
    id: SessionId,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> {
    const snapshot = await this.client.stat(id, options?.signal)
    return snapshot ? this.observation(snapshot) : undefined
  }
  async list(
    options?: SessionPersistenceListOptions,
  ): Promise<readonly SessionPersistenceSnapshot[]> {
    return (await this.client.list(options?.signal)).map((s) =>
      this.observation(s),
    )
  }
  async flush(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.writers.values()].map((h) => h.closing ?? h.flush()),
    )
    const errors = results.flatMap((r) =>
      r.status === 'rejected' ? [r.reason] : [],
    )
    if (errors.length)
      throw new AggregateError(errors, 'ContextMesh flush failed')
  }
  /** One storage primitive shared by explicit and routed append; exposed for backend fault injection. */
  async persistBatch(
    _header: SessionHeader,
    handle: RemoteHandle,
    events: StoredEvent[],
    operationId: string,
  ): Promise<number> {
    return (await this.client.append(handle, events, operationId)).nextSeq
  }
  forget(handle: RemoteSessionHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
  }
}

class RemoteSessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly access: 'read' | 'write'
  readonly inheritedEventCount: SessionLogOffset
  closing: Promise<void> | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private buffer: SessionEvent[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private draining: Promise<void> | undefined
  private paused = false
  private lost = false
  private observed = 0
  private cursor: number
  private unknownAppend:
    { events: StoredEvent[]; operationId: string } | undefined
  private pendingLive: { events: SessionEvent[] } | undefined
  constructor(
    private readonly owner: RemoteSessionPersistence,
    private readonly remote: RemoteHandle,
  ) {
    this.header = storedHeader(remote.session)
    this.id = this.header.id
    this.access = remote.access
    assertStoredId(this.id, this.header)
    this.inheritedEventCount = SessionLogOffset(
      remote.session.inheritedEventCount,
    )
    this.cursor = remote.session.nextSeq
    if (this.access === 'write') {
      let renewing = false
      this.heartbeat = setInterval(() => {
        if (renewing || this.closing || this.lost) return
        renewing = true
        void this.owner.client
          .renew(this.remote)
          .catch(() => {
            this.markLost()
            this.owner.report(
              `contextmesh: session "${this.id}" lost write ownership; stop this agent and recover explicitly`,
            )
          })
          .finally(() => {
            renewing = false
          })
      }, owner.config.renewalMs ?? 15000)
      this.heartbeat.unref()
    }
  }
  claim(): RemoteHandle {
    this.assertOpen('claim')
    this.assertWrite('claim')
    return structuredClone(this.remote)
  }
  private markLost(): void {
    if (this.lost) return
    this.lost = true
    this.owner.ownershipLost(this.id)
  }
  private assertOpen(op: string): void {
    if (this.closing) throw new SessionHandleClosedError(this.id, op)
  }
  private assertWrite(op: string): void {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, op)
    if (this.lost) throw new SessionOwnershipLostError(this.id)
  }
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn)
    this.chain = next.catch(() => {})
    return next
  }
  async read(
    offset = 0,
    length = Number.MAX_SAFE_INTEGER,
    options?: SessionHandleReadOptions,
  ): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0
    )
      throw new TypeError(
        'read offset and length must be a non-negative safe integer',
      )
    try {
      const result = await this.owner.client.read(
        this.remote,
        offset,
        length,
        options?.signal,
      )
      assertStoredId(this.id, storedHeader(result.snapshot))
      if (result.end < this.observed)
        throw new MeshError(
          'CORRUPTION',
          'stored log shrank below the observed prefix',
          422,
        )
      this.observed = Math.max(this.observed, result.end)
      const events = decodedEvents(this.header, result.events)
      assertContiguous(this.id, events, offset)
      return { eventState: 'detached', events }
    } catch (error) {
      throw mapped(error, this.id, 'read')
    }
  }
  async append(
    events: readonly SessionEvent[],
    options?: SessionHandleAppendOptions,
  ): Promise<void> {
    this.assertOpen('append')
    this.assertWrite('append')
    options?.signal?.throwIfAborted()
    const snapshot = materializeAppendBatch(events)
    return this.enqueue(async () => {
      options?.signal?.throwIfAborted()
      await this.write(snapshot)
    })
  }
  private async retryUnknown(): Promise<void> {
    if (!this.unknownAppend) return
    this.assertWrite('append')
    const pending = this.unknownAppend
    try {
      this.cursor = await this.owner.persistBatch(
        this.header,
        this.remote,
        pending.events,
        pending.operationId,
      )
      this.remote.session.nextSeq = this.cursor
      this.unknownAppend = undefined
    } catch (error) {
      if (error instanceof MeshError && error.code === 'OWNERSHIP_LOST')
        this.markLost()
      throw mapped(error, this.id, 'append')
    }
  }
  private async write(events: readonly SessionEvent[]): Promise<void> {
    this.assertWrite('append')
    if (this.unknownAppend) {
      const same = isDeepStrictEqual(events, this.unknownAppend.events)
      await this.retryUnknown()
      if (same) return
    }
    if (!events.length) return
    assertContiguous(this.id, events, this.cursor)
    for (let i = 0; i < events.length; i += 512) {
      const batch = z.array(eventSchema).parse(events.slice(i, i + 512))
      this.unknownAppend = { events: batch, operationId: randomUUID() }
      await this.retryUnknown()
    }
  }
  route(event: SessionEvent): void {
    this.buffer.push(structuredClone(event))
    if (this.timer || this.paused) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain().catch((error) =>
        this.owner.report(
          `session-persistence: background write for session "${this.id}" failed (buffered events retained): ${String(error)}`,
        ),
      )
    }, this.owner.config.batchDelayMs ?? 200)
    this.timer.unref()
  }
  private drain(): Promise<void> {
    return (this.draining ??= (async () => {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      this.paused = false
      while (this.pendingLive || this.buffer.length) {
        this.pendingLive ??= { events: this.buffer.splice(0, 512) }
        const batch = this.pendingLive.events
        try {
          await this.enqueue(() => this.write(batch))
          this.pendingLive = undefined
        } catch (error) {
          this.paused = true
          throw error
        }
      }
    })().finally(() => {
      this.draining = undefined
    }))
  }
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    this.assertWrite('flush')
    options?.signal?.throwIfAborted()
    await this.drain()
    await this.enqueue(async () => {
      await this.retryUnknown()
      try {
        await this.owner.client.flush(
          this.remote,
          randomUUID(),
          options?.signal,
        )
      } catch (error) {
        throw mapped(error, this.id, 'flush')
      }
    })
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.heartbeat) clearInterval(this.heartbeat)
      let failure: unknown
      try {
        await this.drain()
        await this.chain
        if (this.access === 'write')
          await this.enqueue(() => this.retryUnknown())
      } catch (error) {
        failure = error
      }
      await this.chain
      try {
        await this.owner.client.close(
          this.remote,
          randomUUID(),
          failure !== undefined,
        )
      } catch (error) {
        failure ??= mapped(error, this.id, 'close')
      } finally {
        if (this.timer) clearTimeout(this.timer)
        this.owner.forget(this)
      }
      if (failure !== undefined)
        throw failure instanceof Error ? failure : new Error(String(failure))
    })())
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/** Keep live routing through provider-dependent consumer shutdown, then close all handles. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const token =
    config.token ?? process.env[config.tokenEnv ?? 'CONTEXTMESH_TOKEN']
  if (!token)
    throw new Error('ContextMesh token environment variable is missing')
  const client = new MeshClient({ ...config, token })
  const capabilities = await client.capabilities()
  if ((config.renewalMs ?? 15000) * 3 > capabilities.leaseMs)
    throw new Error('renewalMs must be at most one third of server leaseMs')
  let serviceFiber!: Fiber
  let service: RemoteSessionPersistence | undefined
  ctx.effect(function* () {
    yield async () => {
      await service?.shutdown()
    }
    yield ctx.on('session/event', (session: Session, event: SessionEvent) =>
      service?.writers.get(session.id)?.route(event),
    )
    yield ctx.on('session/flush', (session: Session) =>
      service?.writers.get(session.id)?.flush(),
    )
    yield ctx.on('session/disposed', (session: Session) => {
      const handle = service?.writers.get(session.id)
      if (handle)
        void handle
          .close()
          .catch((error) =>
            ctx.logger.warn(
              `session-persistence: final drain for session "${session.id}" failed: ${String(error)}`,
            ),
          )
    })
    serviceFiber = ctx.plugin({
      name: 'contextmesh-persistence-service',
      apply(serviceCtx: Context) {
        service = new RemoteSessionPersistence(serviceCtx, client, config)
        serviceCtx.provide('contextmesh', service)
      },
    })
    yield serviceFiber.dispose
  })
  await serviceFiber.await()
}
