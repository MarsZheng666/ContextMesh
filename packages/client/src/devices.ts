import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MeshClient } from './index.js'
import { deviceName, deviceConnection } from '../../protocol/src/devices.js'
export class DeviceClient {
  constructor(readonly mesh: MeshClient) {}
  create(name: string, operationId: string = randomUUID(), ttlSeconds = 600) {
    return this.mesh.request('/v1/pairings', {
      name: deviceName.parse(name),
      operationId,
      ttlSeconds,
    })
  }
  list() {
    return this.mesh.request('/v1/device-credentials')
  }
  revoke(id: string) {
    return this.mesh.request(
      `/v1/device-credentials/${z.uuid().parse(id)}/revoke`,
      {},
    )
  }
  async identity() {
    return z
      .object({
        role: z.enum(['owner', 'device']),
        nodeId: z.uuid().nullable(),
      })
      .parse(await this.mesh.request('/v1/identity'))
  }
  static async claim(endpoint: string, code: string, claimId: string) {
    // Constructor validates transport; credentials are delivered only in the response body.
    const client = new MeshClient({ endpoint, token: '', retries: 2 })
    const result = z
      .object({ nodeId: z.uuid(), name: deviceName, token: z.string().min(24) })
      .parse(await client.request('/v1/pairings/claim', { code, claimId }))
    return deviceConnection.parse({
      version: 1,
      endpoint: client.endpoint,
      ...result,
    })
  }
}
