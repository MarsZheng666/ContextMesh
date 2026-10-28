import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  errorSchema,
  handleSchema,
  MeshError,
  readSchema,
  sessionSchema,
  type RemoteHandle,
  type StoredHeader,
  type StoredEvent,
} from '../../protocol/src/index.js'

export interface ClientOptions {
  endpoint: string
  token: string
  timeoutMs?: number
  retries?: number
  allowInsecureHttp?: boolean
  fetch?: typeof fetch
}
export class MeshClient {
  readonly instanceId = randomUUID()
  readonly endpoint: string
  private readonly transport: typeof fetch
  constructor(private readonly config: ClientOptions) {
    const url = new URL(config.endpoint)
    if (url.username || url.password || url.search || url.hash)
      throw new Error(
        'endpoint must not contain credentials, query or fragment',
      )
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
          config.allowInsecureHttp)
      )
    )
      throw new Error(
        'remote endpoint requires HTTPS; explicitly allow insecure HTTP only on a trusted test network',
      )
    this.endpoint = config.endpoint.replace(/\/$/, '')
    this.transport = config.fetch ?? fetch
  }
  async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let last: unknown
    for (let attempt = 0; attempt <= (this.config.retries ?? 2); attempt++) {
      signal?.throwIfAborted()
      try {
        const response = await this.transport(`${this.endpoint}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            authorization: `Bearer ${this.config.token}`,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.any([
            AbortSignal.timeout(this.config.timeoutMs ?? 10000),
            ...(signal ? [signal] : []),
          ]),
        })
        const data: unknown = await response.json()
        if (!response.ok) {
          const e = errorSchema.parse(data)
          throw new MeshError(e.code, e.message, response.status)
        }
        return data
      } catch (error) {
        last = error
        if (signal?.aborted) throw signal.reason
        if (error instanceof MeshError && error.status < 500) throw error
        if (attempt < (this.config.retries ?? 2))
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt))
      }
    }
    const operation =
      typeof body === 'object' &&
      body !== null &&
      'operationId' in body &&
      typeof body.operationId === 'string'
        ? body.operationId
        : undefined
    if (last instanceof MeshError)
      throw new MeshError(last.code, last.message, last.status, operation)
    throw new MeshError(
      'UNAVAILABLE',
      `remote result unknown; query operation ${operation ?? '(read-only request)'}`,
      503,
      operation,
    )
  }
  async capabilities() {
    return z
      .object({
        protocolVersion: z.literal(1),
        leaseMs: z.number().int().positive(),
        features: z.array(z.string()).optional(),
      })
      .parse(await this.request('/health/ready'))
  }
  async create(
    header: StoredHeader,
    inheritedEventCount: number,
    signal?: AbortSignal,
  ): Promise<RemoteHandle> {
    return handleSchema.parse(
      await this.request(
        '/v1/sessions',
        {
          operationId: randomUUID(),
          instanceId: this.instanceId,
          adapter: 'deepseek',
          header,
          inheritedEventCount,
        },
        signal,
      ),
    )
  }
  async open(
    id: string,
    access: 'read' | 'write',
    signal?: AbortSignal,
  ): Promise<RemoteHandle> {
    return handleSchema.parse(
      await this.request(
        `/v1/sessions/${encodeURIComponent(id)}/handles`,
        { operationId: randomUUID(), instanceId: this.instanceId, access },
        signal,
      ),
    )
  }
  async stat(id: string, signal?: AbortSignal) {
    return z
      .object({ session: sessionSchema.nullable() })
      .parse(
        await this.request(
          `/v1/sessions/${encodeURIComponent(id)}?instanceId=${this.instanceId}`,
          undefined,
          signal,
        ),
      ).session
  }
  async list(signal?: AbortSignal) {
    const sessions: z.infer<typeof sessionSchema>[] = []
    let cursor: string | null = ''
    do {
      const page = z
        .object({
          sessions: z.array(sessionSchema),
          cursor: z.string().nullable(),
        })
        .parse(
          await this.request(
            `/v1/sessions?instanceId=${this.instanceId}&after=${encodeURIComponent(cursor)}`,
            undefined,
            signal,
          ),
        )
      sessions.push(...page.sessions)
      cursor = page.cursor
    } while (cursor !== null)
    return sessions
  }
  async read(
    handle: RemoteHandle,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ) {
    const events: StoredEvent[] = []
    let end: number | undefined
    let cursor = offset
    let snapshot = handle.session
    do {
      const size = Math.min(512, length - events.length)
      const parsed = readSchema.safeParse(
        await this.request(
          `/v1/handles/${handle.handleId}/events?offset=${cursor}&length=${size}${end === undefined ? '' : `&end=${end}`}`,
          undefined,
          signal,
        ),
      )
      if (!parsed.success)
        throw new MeshError(
          'CORRUPTION',
          'stored event page failed validation',
          422,
        )
      const page = parsed.data
      if (
        page.session.id !== handle.session.id ||
        page.session.incarnation !== handle.session.incarnation ||
        page.events.some((e, i) => e.seq !== cursor + i)
      )
        throw new MeshError(
          'CORRUPTION',
          'event page identity or sequence mismatch',
          422,
        )
      if (end === undefined) end = page.end
      if (
        page.end !== end ||
        page.nextOffset !== cursor + page.events.length ||
        (page.events.length === 0 && cursor < end && size > 0)
      )
        throw new MeshError('CORRUPTION', 'invalid event pagination', 422)
      events.push(...page.events)
      cursor = page.nextOffset
      snapshot = page.session
      if (size === 0 || cursor >= end) break
    } while (events.length < length)
    return { events, snapshot, end: end ?? 0 }
  }
  async append(
    handle: RemoteHandle,
    events: StoredEvent[],
    operationId: string,
    signal?: AbortSignal,
  ) {
    return z.object({ nextSeq: z.number().int().nonnegative() }).parse(
      await this.request(
        `/v1/handles/${handle.handleId}/append`,
        {
          operationId,
          epoch: handle.epoch,
          expectedNextSeq: events[0]?.seq ?? handle.session.nextSeq,
          events,
        },
        signal,
      ),
    )
  }
  async flush(handle: RemoteHandle, operationId: string, signal?: AbortSignal) {
    return z
      .object({ nextSeq: z.number().int().nonnegative() })
      .parse(
        await this.request(
          `/v1/handles/${handle.handleId}/flush`,
          { operationId, epoch: handle.epoch },
          signal,
        ),
      )
  }
  async renew(handle: RemoteHandle) {
    await this.request(`/v1/handles/${handle.handleId}/renew`, {
      epoch: handle.epoch,
    })
  }
  async close(handle: RemoteHandle, operationId: string, failed = false) {
    await this.request(`/v1/handles/${handle.handleId}/close`, {
      operationId,
      epoch: handle.epoch,
      failed,
    })
  }
}
