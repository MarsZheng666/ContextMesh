import { MeshClient, type ClientOptions } from './index.js'
import { resolveConnection, type ConnectionOptions } from './config.js'
import { MeshError } from '../../protocol/src/index.js'
/** Installed synchronously, with no JSONL fallback. Bind credentials once until restart. */
export class ConfiguredMeshClient extends MeshClient {
  private delegate?: MeshClient
  private binding?: Promise<MeshClient>
  constructor(
    private readonly options: ConnectionOptions & Partial<ClientOptions>,
    private readonly renewalMs = 15000,
  ) {
    super({ endpoint: options.endpoint ?? 'http://127.0.0.1:8787', token: '' })
  }
  private async configured() {
    if (this.delegate) return this.delegate
    if (this.binding) return this.binding
    this.binding = (async () => {
      const config = await resolveConnection(this.options)
      if (!config.endpoint || !config.token)
        throw new MeshError(
          'NOT_CONFIGURED',
          'Connect ContextMesh in Remote sessions → Connection setup.',
          503,
        )
      const client = new MeshClient({
        ...this.options,
        endpoint: config.endpoint,
        token: config.token,
      })
      const capabilities = await new MeshClient({
        ...this.options,
        endpoint: config.endpoint,
        token: config.token,
        retries: 0,
      }).capabilities()
      if (this.renewalMs * 3 > capabilities.leaseMs)
        throw new MeshError(
          'VERSION_INCOMPATIBLE',
          'The server lease is too short for this client configuration.',
          409,
        )
      this.delegate = client
      Object.assign(this, { endpoint: client.endpoint })
      return client
    })()
    try {
      return await this.binding
    } finally {
      this.binding = undefined
    }
  }
  override async request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return (await this.configured()).request(path, body, signal)
  }
}
