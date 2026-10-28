import { z } from 'zod'
import type { MeshClient } from './index.js'
import {
  modelRelayRecord,
  type ModelRelayRequest,
} from '../../protocol/src/model-relay.js'

export class ModelRelayClient {
  constructor(
    readonly mesh: MeshClient,
    readonly nodeId: string,
  ) {}
  async prepare(
    sessionId: string,
    request: Omit<ModelRelayRequest, 'nodeId' | 'instanceId'>,
  ) {
    return modelRelayRecord.parse(
      await this.mesh.request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/model-relays`,
        { ...request, nodeId: this.nodeId, instanceId: this.mesh.instanceId },
      ),
    )
  }
  async get(id: string) {
    return modelRelayRecord.parse(
      await this.mesh.request(`/v1/model-relays/${id}`),
    )
  }
  async pending() {
    return z
      .array(modelRelayRecord)
      .parse(await this.mesh.request(`/v1/nodes/${this.nodeId}/model-relays`))
  }
  async finish(id: string, cancel = false) {
    return modelRelayRecord.parse(
      await this.mesh.request(`/v1/model-relays/${id}/finish`, {
        nodeId: this.nodeId,
        instanceId: this.mesh.instanceId,
        ...(cancel ? { cancel: true } : {}),
      }),
    )
  }
}
