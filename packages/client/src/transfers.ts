import { z } from 'zod'
import { MeshClient } from './index.js'
import {
  transferBundle,
  transferSummarySchema,
  type TransferBundle,
  type TransferRecord,
  type TransferSummary,
  digest,
} from '../../protocol/src/transfers.js'
export class TransferClient {
  constructor(
    readonly mesh: MeshClient,
    readonly nodeId: string,
  ) {}
  private identity() {
    return { nodeId: this.nodeId, instanceId: this.mesh.instanceId }
  }
  async list(): Promise<TransferSummary[]> {
    return z
      .array(transferSummarySchema)
      .parse(
        await this.mesh.request(
          '/v1/workspace-transfers/list',
          this.identity(),
        ),
      )
  }
  async get(id: string): Promise<TransferRecord> {
    return z
      .object({
        id: z.uuid(),
        digest,
        bundle: transferBundle,
        ready: z.boolean(),
        expiresAt: z.number(),
      })
      .parse(
        await this.mesh.request(
          `/v1/workspace-transfers/${z.uuid().parse(id)}/read`,
          this.identity(),
        ),
      )
  }
  upload(id: string, bundle: TransferBundle) {
    return this.mesh.request('/v1/workspace-transfers', {
      operationId: id,
      ...this.identity(),
      bundle,
    })
  }
  receipt(r: TransferRecord, ready = true) {
    return this.mesh.request(`/v1/workspace-transfers/${r.id}/receipt`, {
      ...this.identity(),
      digest: r.digest,
      ready,
    })
  }
}
