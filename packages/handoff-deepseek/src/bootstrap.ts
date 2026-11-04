import { hostname } from 'node:os'
import { resolveConnection, safeEndpoint } from '../../client/src/config.js'
import { connectDevice } from '../../../apps/cli/src/setup.js'
import { MeshError } from '../../protocol/src/index.js'
import { z } from 'zod'
export interface Controller {
  command(input: unknown): Promise<unknown>
  close(): Promise<void>
}
export class ConnectionBootstrap {
  private controller?: Controller
  private starting?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private closing = false
  private cached?: Record<string, unknown>
  private lastSync?: number
  private error = 'NOT_CONFIGURED'
  constructor(
    private readonly start: () => Promise<Controller>,
    private readonly canStopOffline: () => boolean = () => false,
  ) {}
  async retry() {
    if (this.starting) return this.starting
    if (this.controller || this.closing) return
    this.starting = (async () => {
      try {
        this.controller = await this.start()
        this.error = ''
      } catch (e) {
        this.error =
          e && typeof e === 'object' && 'code' in e
            ? String(e.code)
            : 'VERSION_OR_CONFIG_ERROR'
      }
    })()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }
  run() {
    const poll = async () => {
      await this.retry()
      if (!this.closing) this.timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
  }
  async command(input: unknown): Promise<unknown> {
    const action = z.object({ action: z.string() }).parse(input).action
    if (
      action === 'prepare-upgrade' &&
      !this.controller &&
      this.canStopOffline()
    ) {
      return { ready: true }
    }
    if (action === 'connection-pair') {
      if (this.controller)
        throw new Error(
          'Keep the current connection. Use a separate managed home for another device.',
        )
      const c = z
        .object({ endpoint: z.string().url(), code: z.string().length(16) })
        .parse(input)
      const config = await resolveConnection()
      if (config.token)
        throw new Error(
          'Existing credentials take precedence. Use setup to review the configuration source.',
        )
      const result = await connectDevice(c.endpoint, c.code)
      await this.retry()
      return result
    }
    if (action === 'connection-retry') {
      await this.retry()
      return this.command({ action: 'status' })
    }
    if (action === 'status') {
      const config = await resolveConnection().catch(() => undefined)
      if (this.controller)
        try {
          this.cached = (await this.controller.command(input)) as Record<
            string,
            unknown
          >
          this.lastSync = Date.now()
          this.error = ''
        } catch (e) {
          this.error =
            e && typeof e === 'object' && 'code' in e
              ? String(e.code)
              : 'UNAVAILABLE'
        }
      return {
        ...(this.cached ?? {
          nodeId: config?.nodeId ?? '',
          name: config?.name ?? hostname(),
          nodes: [],
          projects: [],
          mappings: [],
          sessions: [],
          handoffs: [],
          models: [],
          errors: {},
        }),
        connectivity: {
          state: this.error
            ? config?.token
              ? 'offline'
              : 'unconfigured'
            : 'ready',
          code: this.error,
          lastSync: this.lastSync ?? null,
          source: config?.source ?? {},
          warnings: config?.warnings ?? [],
          endpoint: safeEndpoint(config?.endpoint) ?? '',
        },
      }
    }
    if (!this.controller || this.error)
      throw new MeshError(
        'UNAVAILABLE',
        'ContextMesh is offline. Reconnect before continuing this conversation.',
        503,
      )
    return this.controller.command(input)
  }
  async close() {
    this.closing = true
    clearTimeout(this.timer)
    await this.starting
    await this.controller?.close()
  }
}
