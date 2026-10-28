import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { MeshClient } from './index.js'
import {
  takeoverRecord,
  type TakeoverRecord,
  handoffManifest,
  handoffState,
  type HandoffRecord,
  type HandoffManifest,
} from '../../protocol/src/handoff.js'
import { handleSchema } from '../../protocol/src/index.js'

const recordSchema = z.object({
  id: z.uuid(),
  sessionId: z.string(),
  incarnation: z.uuid(),
  sourceNodeId: z.uuid(),
  sourceInstanceId: z.uuid(),
  targetNodeId: z.uuid(),
  targetInstanceId: z.uuid().nullable(),
  state: handoffState,
  revision: z.number().int().nonnegative(),
  manifest: handoffManifest,
  finalNextSeq: z.number().int().nonnegative().nullable(),
  finalGeneration: z.number().int().nonnegative().nullable(),
  targetHandleId: z.uuid().nullable(),
  error: z.string().nullable(),
})
const mappingSchema = z.object({
  projectId: z.uuid(),
  nodeId: z.uuid(),
  name: z.string().optional(),
  root: z.string(),
  revision: z.number().int().positive(),
})
export type ProjectMapping = z.infer<typeof mappingSchema>
export const remoteSessionSchema = z.object({
  id: z.string(),
  incarnation: z.uuid(),
  nextSeq: z.number().int().nonnegative(),
  title: z.string().nullable(),
  projectId: z.uuid().nullable(),
  lastActivity: z.number().nullable(),
  activeNodeId: z.uuid().nullable(),
  activeNodeName: z.string().nullable(),
  handoffId: z.uuid().nullable(),
  handoffState: handoffState.nullable(),
  recoveryRequired: z.boolean(),
})
export class HandoffClient {
  constructor(
    readonly mesh: MeshClient,
    readonly nodeId: string,
  ) {}
  get identity() {
    return { nodeId: this.nodeId, instanceId: this.mesh.instanceId }
  }
  private update(record: HandoffRecord, operationId: string = randomUUID()) {
    return { ...this.identity, operationId, revision: record.revision }
  }
  async register(
    name: string,
    models: Array<{ provider: string; model: string; name: string }> = [],
  ) {
    return this.mesh.request('/v1/nodes/register', {
      ...this.identity,
      operationId: randomUUID(),
      name,
      capabilities: {
        controlVersion: 1,
        takeoverVersion: 1,
        projectSetupVersion: 1,
        directoryHandoffVersion: 1,
        modelRelayVersion: 1,
        models,
        harness: '0.2.1-rc.3',
        adapter: 'deepseek',
      },
    })
  }
  async offline() {
    return this.mesh.request(`/v1/nodes/${this.nodeId}/offline`, {
      instanceId: this.mesh.instanceId,
    })
  }
  async heartbeat() {
    return this.mesh.request(`/v1/nodes/${this.nodeId}/heartbeat`, {
      instanceId: this.mesh.instanceId,
    })
  }
  async nodes() {
    return z
      .array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          instanceId: z.uuid(),
          online: z.boolean(),
          lastSeen: z.string(),
          models: z
            .array(
              z.object({
                provider: z.string(),
                model: z.string(),
                name: z.string(),
              }),
            )
            .optional(),
        }),
      )
      .parse(await this.mesh.request('/v1/nodes'))
  }
  async projects() {
    return z
      .array(z.object({ id: z.uuid(), name: z.string() }))
      .parse(await this.mesh.request('/v1/projects'))
  }
  async project(name: string, projectId: string = randomUUID()) {
    return this.mesh.request('/v1/projects', {
      operationId: randomUUID(),
      projectId,
      name,
    })
  }
  async mapping(projectId: string, root: string, ifAbsent = false) {
    return mappingSchema.parse(
      await this.mesh.request('/v1/mappings', {
        operationId: randomUUID(),
        projectId,
        nodeId: this.nodeId,
        root,
        ...(ifAbsent ? { ifAbsent: true } : {}),
      }),
    )
  }
  async assignProject(
    sessionId: string,
    projectId: string,
    incarnation: string,
    expectedSourceNodeId: string,
  ) {
    return this.mesh.request(`/v1/sessions/${sessionId}/project`, {
      ...this.identity,
      operationId: randomUUID(),
      projectId,
      incarnation,
      expectedSourceNodeId,
    })
  }
  async mappings(nodeId = this.nodeId) {
    return z
      .array(mappingSchema)
      .parse(await this.mesh.request(`/v1/nodes/${nodeId}/mappings`))
  }
  async sessions() {
    return z
      .array(remoteSessionSchema)
      .parse(await this.mesh.request('/v1/remote-sessions'))
  }
  async commands() {
    return z
      .array(recordSchema)
      .parse(
        await this.mesh.request(
          `/v1/nodes/${this.nodeId}/commands?instanceId=${this.mesh.instanceId}`,
        ),
      )
  }
  async get(id: string) {
    return recordSchema.parse(await this.mesh.request(`/v1/handoffs/${id}`))
  }
  async request(
    sessionId: string,
    targetNodeId: string,
    sourceHandleId: string,
    sourceEpoch: number,
    manifest: HandoffManifest,
    operationId: string = randomUUID(),
    takeoverId?: string,
  ) {
    return recordSchema.parse(
      await this.mesh.request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/handoffs`,
        {
          operationId,
          ...(takeoverId ? { takeoverId } : {}),
          sourceNodeId: this.nodeId,
          sourceInstanceId: this.mesh.instanceId,
          targetNodeId,
          sourceHandleId,
          sourceEpoch,
          manifest,
        },
      ),
    )
  }
  async takeover(
    sessionId: string,
    expectedSourceNodeId: string,
    operationId: string = randomUUID(),
    targetModel?: HandoffManifest['model'],
  ) {
    return takeoverRecord.parse(
      await this.mesh.request(
        `/v1/sessions/${encodeURIComponent(sessionId)}/takeovers`,
        {
          ...this.identity,
          operationId,
          expectedSourceNodeId,
          confirmed: true,
          ...(targetModel ? { targetModel } : {}),
        },
      ),
    )
  }
  async takeovers() {
    return z
      .array(takeoverRecord)
      .parse(
        await this.mesh.request(
          `/v1/nodes/${this.nodeId}/takeovers?instanceId=${this.mesh.instanceId}`,
        ),
      )
  }
  async getTakeover(id: string) {
    return takeoverRecord.parse(await this.mesh.request(`/v1/takeovers/${id}`))
  }
  async failTakeover(record: TakeoverRecord, code: string, message: string) {
    return takeoverRecord.parse(
      await this.mesh.request(`/v1/takeovers/${record.id}/fail`, {
        ...this.identity,
        code,
        message: message.slice(0, 1000),
      }),
    )
  }
  async preflight(
    record: HandoffRecord,
    proof: HandoffManifest['workspace'],
    operationId: string = randomUUID(),
  ) {
    return recordSchema.parse(
      await this.mesh.request(`/v1/handoffs/${record.id}/preflight`, {
        ...this.update(record, operationId),
        proof,
      }),
    )
  }
  async finalize(record: HandoffRecord, operationId: string = randomUUID()) {
    return recordSchema.parse(
      await this.mesh.request(
        `/v1/handoffs/${record.id}/finalize`,
        this.update(record, operationId),
      ),
    )
  }
  async accept(
    record: HandoffRecord,
    proof: HandoffManifest['workspace'],
    operationId: string = randomUUID(),
  ) {
    return z.object({ handoff: recordSchema, handle: handleSchema }).parse(
      await this.mesh.request(`/v1/handoffs/${record.id}/accept`, {
        ...this.update(record, operationId),
        proof,
      }),
    )
  }
  async accepted(operationId: string) {
    return z
      .object({ handoff: recordSchema, handle: handleSchema })
      .parse(await this.mesh.request(`/v1/operations/${operationId}`))
  }
  async complete(
    record: HandoffRecord,
    nextSeq: number,
    operationId: string = randomUUID(),
  ) {
    return recordSchema.parse(
      await this.mesh.request(`/v1/handoffs/${record.id}/complete`, {
        ...this.update(record, operationId),
        nextSeq,
      }),
    )
  }
  async cancel(record: HandoffRecord, operationId: string = randomUUID()) {
    return recordSchema.parse(
      await this.mesh.request(
        `/v1/handoffs/${record.id}/cancel`,
        this.update(record, operationId),
      ),
    )
  }
  async fail(
    record: HandoffRecord,
    phase: string,
    message: string,
    confirmClosed = false,
    operationId: string = randomUUID(),
  ) {
    return recordSchema.parse(
      await this.mesh.request(`/v1/handoffs/${record.id}/fail`, {
        ...this.update(record, operationId),
        phase,
        message,
        confirmClosed,
      }),
    )
  }
  async summary(
    sessionId: string,
    data: {
      incarnation: string
      nextSeq: number
      title: string
      projectId: string
      lastActivity: number
    },
  ) {
    return this.mesh.request(
      `/v1/sessions/${encodeURIComponent(sessionId)}/summary`,
      { ...this.identity, ...data, operationId: randomUUID() },
    )
  }
}
