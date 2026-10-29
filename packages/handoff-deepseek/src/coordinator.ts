import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentControl, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { DeviceClient } from '../../client/src/devices.js'
import { deviceName } from '../../protocol/src/devices.js'
import { ModelRelayController } from './model-relay.js'
import {
  inspectModel,
  assertRequestBudget,
  type ModelBudget,
} from './model-compatibility.js'
import { ModelRelayClient } from '../../client/src/model-relay.js'
import type { ModelRoute } from '../../protocol/src/model-relay.js'
import { SessionId, Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-terminal'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-working-directory'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdir, rename, realpath } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type {} from '../../adapter-deepseek/src/index.js'
import { HandoffClient, type ProjectMapping } from '../../client/src/handoff.js'
import { MeshError } from '../../protocol/src/index.js'
import {
  handoffManifest,
  modelRoute,
  type HandoffManifest,
  type HandoffRecord,
  type TakeoverRecord,
} from '../../protocol/src/handoff.js'
import {
  git,
  inspectWorkspace,
  sourceWorkspaceRoot,
  mappedDirectory,
  localDirectory,
  relativeInside,
} from './workspace.js'

const bindingSchema = z.object({
  incarnation: z.uuid(),
  projectId: z.uuid(),
  policyRelativeRoot: z.string(),
})
const stateSchema = z.object({
  version: z.literal(1),
  nodeId: z.uuid(),
  bindings: z.record(z.string(), bindingSchema),
  modelBudgets: z
    .record(
      z.string(),
      z.object({
        route: modelRoute,
        contextWindow: z.number().positive(),
        outputReserve: z.number().positive(),
      }),
    )
    .default({}),
})
const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('status') }),
  z.object({
    action: z.literal('pair-device'),
    name: deviceName,
    operationId: z.uuid(),
  }),
  z.object({ action: z.literal('paired-devices') }),
  z.object({
    action: z.literal('revoke-device'),
    credentialId: z.uuid(),
    confirmed: z.literal(true),
  }),
  z.object({ action: z.literal('models') }),
  modelRoute.extend({
    action: z.literal('select-model'),
    sessionId: z.string().min(1).max(256),
    operationId: z.uuid().optional(),
  }),
  z.object({ action: z.literal('model-relay-status'), operationId: z.uuid() }),
  z.object({ action: z.literal('refresh') }),
  z.object({
    action: z.literal('handoff'),
    sessionId: z.string().min(1).max(256),
    targetNodeId: z.uuid(),
    projectId: z.uuid().optional(),
    targetModel: modelRoute.optional(),
  }),
  z.object({
    action: z.literal('takeover'),
    sessionId: z.string().min(1).max(256),
    confirmed: z.literal(true),
    targetModel: modelRoute.optional(),
    operationId: z.uuid().optional(),
  }),
  z.object({ action: z.literal('takeover-status'), takeoverId: z.uuid() }),
  z.object({
    action: z.literal('configure-project'),
    sessionId: z.string().min(1).max(256),
    projectId: z.uuid(),
    incarnation: z.uuid(),
    expectedSourceNodeId: z.uuid(),
    root: z.string().min(1).max(4096).optional(),
  }),
  z.object({ action: z.literal('cancel'), handoffId: z.uuid() }),
  z.object({
    action: z.literal('resume'),
    sessionId: z.string().min(1).max(256),
  }),
  z.object({
    action: z.literal('history'),
    sessionId: z.string().min(1).max(256),
    offset: z.number().int().nonnegative().optional(),
  }),
  z.object({
    action: z.literal('project'),
    name: z.string().trim().min(1).max(100),
    projectId: z.uuid().optional(),
  }),
  z.object({
    action: z.literal('mapping'),
    projectId: z.uuid(),
    root: z.string().min(1).max(4096),
  }),
])
export interface RuntimeConfig {
  stateDir: string
  nodeName: string
  pollMs: number
  heartbeatMs: number
  waitIdleMs: number
}
interface LocalTransfer {
  control: AgentControl
  phase:
    | 'source-live'
    | 'source-stopped'
    | 'target-starting'
    | 'target-live'
    | 'uncertain'
  agent?: AgentHandle
  acceptOperationId?: string
}
function isMeshError(error: unknown): error is MeshError {
  return (
    error instanceof Error &&
    error.name === 'MeshError' &&
    'status' in error &&
    typeof error.status === 'number' &&
    'code' in error &&
    typeof error.code === 'string'
  )
}
const ranks = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error)
function pending(agent: Agent) {
  return agent.inbox.nextTurn.length + agent.inbox.nextStep.length
}
function portable(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(portable)
  if (value && typeof value === 'object') {
    const row: Record<string, unknown> = Object.fromEntries(
      Object.entries(value),
    )
    if (
      row.type === 'image' ||
      row.type === 'file' ||
      row.type === 'spill' ||
      'spillId' in row ||
      'attachmentId' in row
    )
      return false
    return Object.values(row).every(portable)
  }
  return true
}
async function bounded(
  work: Promise<void>,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const abort = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  await new Promise<void>((accept, reject) => {
    const stopped = () => reject(abort.reason)
    abort.addEventListener('abort', stopped, { once: true })
    if (abort.aborted) stopped()
    work
      .then(accept, reject)
      .finally(() => abort.removeEventListener('abort', stopped))
  })
}

export class HandoffCoordinator {
  readonly relay: ModelRelayController
  readonly client: HandoffClient
  private readonly abort = new AbortController()
  private readonly controls = new Map<string, AgentControl>()
  private readonly transfers = new Map<string, LocalTransfer>()
  private readonly jobs = new Map<string, Promise<unknown>>()
  private readonly errors = new Map<string, string>()
  private readonly fenced = new Set<string>()
  private readonly pendingRequests = new Map<
    string,
    { send: () => Promise<HandoffRecord>; control: AgentControl }
  >()
  private readonly retiring = new Set<Promise<unknown>>()
  private records: HandoffRecord[] = []
  private readonly dirty = new Set<string>()
  private saved: Promise<void> = Promise.resolve()
  private polling: Promise<void> | undefined
  private heartbeating: Promise<void> | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private catalogRefreshed = 0
  private closing = false
  private constructor(
    readonly ctx: Context,
    readonly config: RuntimeConfig,
    private readonly state: z.infer<typeof stateSchema>,
  ) {
    this.client = new HandoffClient(ctx.contextmesh.client, state.nodeId)
    this.relay = new ModelRelayController(
      ctx,
      new ModelRelayClient(ctx.contextmesh.client, state.nodeId),
      {
        freeze: (id) => this.freeze(id),
        release: (id) => this.release(id),
        route: (agent) => this.route(agent),
        resources: (agent) => this.resources(agent),
        wait: (work) => bounded(work, config.waitIdleMs, this.abort.signal),
        guard: (id, budget) => this.guardModel(id, budget),
      },
    )
  }
  static async start(ctx: Context, config: RuntimeConfig) {
    if (
      ctx.agents.controlVersion !== 1 ||
      ctx.agentLoop.controlVersion !== 1 ||
      ctx.get('sandboxPolicy')?.workspaceControlVersion !== 1
    )
      throw new Error(
        'ContextMesh M1 requires the pinned DSH lifecycle and workspace patches; install with the ContextMesh lockfile',
      )
    const capabilities = await ctx.contextmesh.client.capabilities()
    if (
      !capabilities.features?.includes('handoff-v1') ||
      !capabilities.features.includes('takeover-v1') ||
      !capabilities.features.includes('directory-handoff-v1') ||
      !capabilities.features.includes('model-relay-v1') ||
      !capabilities.features.includes('device-pairing-v1')
    )
      throw new Error(
        'Upgrade ContextMesh server: handoff-v1, takeover-v1, directory-handoff-v1, model-relay-v1 and device-pairing-v1 are required',
      )
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    const path = join(config.stateDir, 'node.json')
    const identity = await new DeviceClient(ctx.contextmesh.client).identity()
    let state: z.infer<typeof stateSchema>
    try {
      state = stateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error
      state = {
        version: 1,
        nodeId: identity.nodeId ?? randomUUID(),
        bindings: {},
        modelBudgets: {},
      }
      await writeFile(path, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
    }
    if (identity.nodeId && identity.nodeId !== state.nodeId)
      throw new Error(
        'This state directory belongs to another device; use a separate DSH home',
      )
    const service = new HandoffCoordinator(ctx, config, state)
    await service.client.register(
      config.nodeName || hostname(),
      await service.models(),
    )
    await service.relay
      .reconcile()
      .catch((error) => service.warn('model-relay', error))
    ctx.on('llm/stream', async function* (options, next) {
      const budget =
        options.sessionId && service.state.modelBudgets[options.sessionId]
      if (
        !options.purpose &&
        budget &&
        options.provider === budget.route.provider &&
        options.model === budget.route.model
      )
        assertRequestBudget(options, budget)
      yield* next()
    })
    ctx.on('agent/created', async ({ agent }) => {
      await service.bindExisting(agent)
      service.dirty.add(agent.id)
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' || event.type === 'session/title')
        service.dirty.add(session.id)
    })
    ctx.effect(
      () =>
        ctx.contextmesh.onOwnershipLost((id) => {
          const control =
            service.controls.get(id) ?? ctx.agents.acquireControl(id)
          service.controls.set(id, control)
          service.fenced.add(id)
          const agent = ctx.agents.get(id)
          agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
          if (agent) {
            const task = Promise.resolve()
              .then(() => control.ownedHandle().dispose())
              .catch((error) => service.warn(id, error))
            service.retiring.add(task)
            void task.finally(() => service.retiring.delete(task))
          }
          service.errors.set(
            id,
            'Write ownership lost. Execution stopped; confirm old processes have stopped before recovery.',
          )
        }),
      'contextmesh: ownership loss',
    )
    // Native Web restoration can finish while the coordinator is starting.
    for (const agent of ctx.agents.list()) {
      await service.bindExisting(agent)
      service.dirty.add(agent.id)
    }
    service.pollTimer = setInterval(() => {
      void service.tick()
    }, config.pollMs)
    service.pollTimer.unref()
    service.heartbeatTimer = setInterval(() => {
      void service.heartbeat()
    }, config.heartbeatMs)
    service.heartbeatTimer.unref()
    return service
  }
  private guardModel(id: string, budget: ModelBudget) {
    this.state.modelBudgets[id] = budget
    void this.save().catch((error) => this.warn(id, error))
  }
  async models() {
    const llm = this.ctx.llm
    const groups = await Promise.all(
      llm.listProviders().map(async (provider) => {
        try {
          return (await llm.listModels(provider.id)).map((model) => ({
            provider: provider.id,
            model: model.id,
            name: model.name,
          }))
        } catch {
          return []
        }
      }),
    )
    return groups.flat().slice(0, 500)
  }
  private warn(id: string, error: unknown) {
    this.errors.set(id, message(error))
    this.ctx.logger.warn(`contextmesh handoff ${id}: ${message(error)}`)
  }
  private save() {
    const snapshot = JSON.stringify(this.state)
    const work = this.saved.then(async () => {
      const path = join(this.config.stateDir, 'node.json'),
        tmp = `${path}.${randomUUID()}.tmp`
      await writeFile(tmp, snapshot, { mode: 0o600 })
      await rename(tmp, path)
    })
    this.saved = work.catch(() => {})
    return work
  }
  private freeze(id: string) {
    const existing = this.controls.get(id)
    if (existing) return existing
    const control = this.ctx.agents.acquireControl(SessionId(id))
    this.controls.set(id, control)
    return control
  }
  private release(id: string) {
    if (this.fenced.has(id)) return
    this.controls.get(id)?.release()
    this.controls.delete(id)
  }
  private async heartbeat() {
    if (this.closing || this.heartbeating) return
    this.heartbeating = (async () => {
      await this.client.heartbeat()
      if (Date.now() - this.catalogRefreshed > 30000) {
        await this.client.register(this.config.nodeName, await this.models())
        this.catalogRefreshed = Date.now()
      }
    })()
      .then(
        () => {
          this.errors.delete('heartbeat')
        },
        (error) => this.warn('heartbeat', error),
      )
      .finally(() => {
        this.heartbeating = undefined
      })
    await this.heartbeating
  }
  private async mapping(projectId: string) {
    const mapping = (await this.client.mappings()).find(
      (m) => m.projectId === projectId,
    )
    if (!mapping)
      throw new MeshError(
        'WORKSPACE_MISMATCH',
        'configure a local directory for this project first',
      )
    return mapping
  }
  private async localMapping(agent: Agent, projectId?: string) {
    const cwd = this.ctx.workingDirectory.get(agent.session)
    const candidates = []
    for (const mapping of await this.client.mappings()) {
      if (projectId && mapping.projectId !== projectId) continue
      try {
        const { root } = await mappedDirectory(mapping, '')
        candidates.push({ mapping, relativeCwd: relativeInside(root, cwd) })
      } catch (error) {
        if (projectId) throw error
      }
    }
    if (candidates.length === 0)
      throw new MeshError(
        'SESSION_DIRECTORY_UNMAPPED',
        'the session working directory is outside the configured project on its owning device',
      )
    if (candidates.length !== 1)
      throw new MeshError(
        'WORKSPACE_MISMATCH',
        'select exactly one configured project containing the current directory',
      )
    return candidates[0]!
  }
  private policy(ctx: Context) {
    return (
      this.ctx.get('agentPresets')?.serviceFor({ ctx }, 'sandboxPolicy') ??
      ctx.get('sandboxPolicy') ??
      this.ctx.sandboxPolicy
    )
  }
  private async resources(agent: Agent) {
    if (
      agent.session.header.origin === 'subagent' ||
      !this.ctx.agents.roots().includes(agent)
    )
      throw new MeshError('UNSUPPORTED_RESOURCE', 'M1 requires a root Agent')
    if (pending(agent))
      throw new MeshError(
        'PENDING_INPUT',
        'finish or explicitly remove pending input before handoff',
      )
    if (
      this.ctx.agents
        .list()
        .some((other) => this.ctx.agents.isOwnedBy(other.id, agent))
    )
      throw new MeshError(
        'UNSUPPORTED_RESOURCE',
        'stop child Agents before handoff',
      )
    if (
      this.ctx
        .get('jobs')
        ?.list(agent.id)
        .some(
          (job) =>
            job.owner === agent.id &&
            (job.status === 'running' || job.status === 'stopping'),
        )
    )
      throw new MeshError(
        'UNSUPPORTED_RESOURCE',
        'finish background jobs before handoff',
      )
    if (
      this.ctx
        .get('terminals')
        ?.list(agent)
        .some((terminal) => terminal.status.kind === 'running')
    )
      throw new MeshError(
        'UNSUPPORTED_RESOURCE',
        'close persistent terminals before handoff',
      )
    if ((await this.ctx.get('schedule')?.list({ sessionId: agent.id }))?.length)
      throw new MeshError(
        'UNSUPPORTED_RESOURCE',
        'remove active schedules before handoff',
      )
    if (!portable(agent.session.snapshotEvents()))
      throw new MeshError(
        'UNSUPPORTED_RESOURCE',
        'M1 cannot transfer attachments or spill resources',
      )
  }
  private options(manifest: HandoffManifest) {
    const { reasoningEffort, ...selection } = manifest.model
    return {
      ...selection,
      ...(reasoningEffort
        ? { reasoningEffort: ReasoningEffortId(reasoningEffort) }
        : {}),
    }
  }
  private route(agent: Agent) {
    let selection: unknown = {
      provider: agent.options.provider,
      model: agent.options.model,
      reasoningEffort: agent.options.reasoningEffort,
    }
    for (const event of agent.session.snapshotEvents()) {
      if (event.type === 'model/selection') selection = event.data
      if (event.type === 'request/header') selection = event.data.header.config
    }
    return modelRoute.parse(selection)
  }
  async begin(
    sessionId: string,
    targetNodeId: string,
    projectId?: string,
    takeover?: TakeoverRecord,
    targetModel?: ModelRoute,
  ) {
    targetModel ??= takeover?.targetModel
    if (this.closing) throw new Error('ContextMesh is stopping')
    const native = this.ctx.get('sessionController')
    if (native && native.lifecycleControlVersion !== 1)
      throw new Error(
        'Install the pinned DSH Web lifecycle compatibility patch',
      )
    if (this.controls.has(sessionId))
      throw new MeshError(
        'HANDOFF_IN_PROGRESS',
        'session is already frozen; inspect its handoff status',
      )
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (!agent)
      throw new MeshError(
        'NOT_LOCAL_WRITER',
        'open this session on its current device before handing it off',
      )
    const control = this.freeze(sessionId)
    let manifest: HandoffManifest
    try {
      await bounded(
        control.quiesce(),
        this.config.waitIdleMs,
        this.abort.signal,
      )
      control.ownedHandle()
      if (takeover && !pending(agent) && agent.status === 'running')
        agent.cancel({ kind: 'user' }, { keepInbox: true })
      if (pending(agent))
        throw new MeshError(
          'PENDING_INPUT',
          'pending input must be handled before handoff',
        )
      await bounded(agent.whenIdle(), this.config.waitIdleMs, this.abort.signal)
      await this.resources(agent)
      const { mapping, relativeCwd } = await this.localMapping(
        agent,
        projectId ?? this.state.bindings[sessionId]?.projectId,
      )
      const workspace = await inspectWorkspace(
        mapping,
        relativeCwd,
        this.abort.signal,
      )
      const policy = this.policy(agent.ctx)
      const resolved = policy.resolve({ session: agent.session })
      const preset = this.ctx.get('agentPresets')?.composedPreset(agent.ctx)
      manifest = handoffManifest.parse({
        version: 1,
        harness: '0.2.1-rc.3',
        adapter: 'deepseek',
        workspace: workspace.proof,
        model: this.route(agent),
        ...(targetModel ? { targetModel } : {}),
        sandbox: {
          mode: resolved.mode,
          relativeRoot: relativeInside(workspace.root, resolved.workspaceRoot),
        },
        ...(preset ? { preset } : {}),
      })
      await this.ctx.sessions.flush(agent.session)
    } catch (error) {
      this.release(sessionId)
      throw error
    }
    let claim: ReturnType<typeof this.ctx.contextmesh.writerClaim>
    try {
      claim = this.ctx.contextmesh.writerClaim(SessionId(sessionId))
    } catch (error) {
      this.release(sessionId)
      throw error
    }
    const operationId = takeover?.handoffOperationId ?? randomUUID()
    const send = () =>
      this.client.request(
        sessionId,
        targetNodeId,
        claim.handleId,
        claim.epoch,
        manifest,
        operationId,
        takeover?.id,
      )
    this.pendingRequests.set(sessionId, { send, control })
    const record = await this.reconcileRequest(sessionId)
    if (!record)
      throw new MeshError(
        'UNAVAILABLE',
        'Handoff request outcome is unknown; this device will retry the same operation while keeping input frozen',
        503,
        operationId,
      )
    this.errors.delete(sessionId)
    void this.publish(agent, manifest.workspace.projectId).catch((error) =>
      this.warn(sessionId, error),
    )
    return record
  }
  private async reconcileRequest(sessionId: string) {
    const request = this.pendingRequests.get(sessionId)
    if (!request) return
    try {
      const record = await request.send()
      this.pendingRequests.delete(sessionId)
      for (const [key, old] of this.transfers)
        if (old.control.sessionId === sessionId) this.transfers.delete(key)
      this.transfers.set(record.id, {
        control: request.control,
        phase: 'source-live',
      })
      this.errors.delete(sessionId)
      return record
    } catch (error) {
      if (isMeshError(error) && error.status < 500) {
        this.pendingRequests.delete(sessionId)
        this.release(sessionId)
      }
      this.warn(sessionId, error)
      throw error
    }
  }
  private exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    const result = (this.jobs.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(work)
    this.jobs.set(id, result)
    const done = () => {
      if (this.jobs.get(id) === result) this.jobs.delete(id)
    }
    void result.then(done, done)
    return result
  }
  async tick() {
    if (this.closing) return
    if (this.polling) return this.polling
    this.polling = (async () => {
      await this.relay
        .reconcile()
        .catch((error) => this.warn('model-relay', error))
      for (const id of this.pendingRequests.keys()) {
        if (!this.jobs.has(id))
          await this.exclusive(id, () => this.reconcileRequest(id)).catch(
            (error) => this.warn(id, error),
          )
      }
      for (const intent of await this.client.takeovers()) {
        if (
          this.jobs.has(intent.sessionId) ||
          this.pendingRequests.has(intent.sessionId)
        )
          continue
        void this.exclusive(intent.sessionId, () =>
          this.fulfillTakeover(intent),
        ).catch((error) => this.warn(intent.sessionId, error))
      }
      this.records = await this.client.commands()
      this.errors.delete('poll')
      for (const record of this.records) {
        if (this.jobs.has(record.sessionId)) continue
        void this.exclusive(record.sessionId, () => this.advance(record)).catch(
          (error) => this.warn(record.sessionId, error),
        )
      }
      await Promise.allSettled([...this.jobs.values()])
      for (const id of [...this.dirty].slice(0, 20)) {
        const agent = this.ctx.agents.get(SessionId(id))
        this.dirty.delete(id)
        if (!agent) continue
        try {
          const local = await this.localMapping(
            agent,
            this.state.bindings[agent.id]?.projectId,
          )
          await this.publish(agent, local.mapping.projectId)
        } catch (error) {
          if (!(isMeshError(error) && error.code === 'WORKSPACE_MISMATCH'))
            this.warn(id, error)
        }
      }
    })()
      .catch((error) => this.warn('poll', error))
      .finally(() => {
        this.polling = undefined
      })
    return this.polling
  }
  private async preflight(record: HandoffRecord) {
    const mapping = await this.mapping(record.manifest.workspace.projectId)
    const workspace = await inspectWorkspace(
      mapping,
      record.manifest.workspace.relativeCwd,
      this.abort.signal,
      record.manifest.workspace.kind ?? 'git',
    )
    if (workspace.proof.commit !== record.manifest.workspace.commit)
      throw new MeshError(
        'WORKSPACE_MISMATCH',
        'target must have the same Git commit',
      )
    await mappedDirectory(mapping, record.manifest.sandbox.relativeRoot)
    let probe: ReturnType<typeof createScope> | undefined
    try {
      let context = this.ctx
      const presets = this.ctx.get('agentPresets')
      if (record.manifest.preset) {
        if (!presets)
          throw new MeshError('PRESET_MISSING', 'target has no preset registry')
        // Public scoped composition; no Agent, session, writer or model run is created.
        probe = createScope(this.ctx, {})
        await presets.mount(probe.ctx, record.manifest.preset)
        context = probe.ctx
      }
      const policy = this.policy(context)
      if (ranks[record.manifest.sandbox.mode] > ranks[policy.defaultMode])
        throw new MeshError(
          'POLICY_MISMATCH',
          'target preset policy is stricter; configure a compatible policy before handoff',
        )
      const llm =
        presets?.serviceFor({ ctx: context }, 'llm') ??
        context.get('llm') ??
        this.ctx.llm
      await llm.prepareCall(
        this.options({
          ...record.manifest,
          model: record.manifest.targetModel ?? record.manifest.model,
        }),
      )
      if (record.manifest.targetModel) {
        if (this.ctx.get('sessionController')?.modelRelayVersion !== 1)
          throw new MeshError(
            'MODEL_RELAY_UNSUPPORTED',
            'update the model relay bridge',
          )
        const handle = await this.ctx.contextmesh.open(
          SessionId(record.sessionId),
          'read',
        )
        try {
          const log = await handle.read()
          const snapshot = Session.fromRestore(
            handle.id,
            log.events,
            handle.header,
            handle.inheritedEventCount,
            log.eventState,
          )
          await inspectModel(
            llm,
            snapshot,
            record.manifest.targetModel,
            this.abort.signal,
          )
        } finally {
          await handle.close()
        }
      }
    } finally {
      await probe?.dispose()
    }
    const reader = await this.ctx.contextmesh.open(
      SessionId(record.sessionId),
      'read',
    )
    try {
      if (!portable((await reader.read()).events))
        throw new MeshError(
          'UNSUPPORTED_RESOURCE',
          'M1 cannot transfer attachments or spill resources',
        )
    } finally {
      await reader.close()
    }
    return { mapping, workspace }
  }
  private async advance(record: HandoffRecord) {
    const source =
      record.sourceNodeId === this.client.nodeId &&
      record.sourceInstanceId === this.client.mesh.instanceId
    const target =
      record.targetNodeId === this.client.nodeId &&
      record.targetInstanceId === this.client.mesh.instanceId
    if (!source && !target) return
    let local = this.transfers.get(record.id)
    if (record.state === 'requested' && target) {
      try {
        const checked = await this.preflight(record)
        await this.client.preflight(record, checked.workspace.proof)
      } catch (error) {
        await this.client.fail(record, 'target-preflight', message(error))
        this.warn(record.sessionId, error)
      }
    } else if (record.state === 'preparing' && source) {
      local ??= { control: this.freeze(record.sessionId), phase: 'source-live' }
      this.transfers.set(record.id, local)
      try {
        const agent = this.ctx.agents.get(SessionId(record.sessionId))
        if (local.phase === 'uncertain') {
          await this.client.fail(
            record,
            'source-stop',
            'source teardown could not be confirmed',
          )
          return
        }
        if (local.phase === 'source-live') {
          if (!agent)
            throw new MeshError(
              'CLOSE_UNCONFIRMED',
              'source runtime owner is missing',
            )
          await bounded(
            agent.whenIdle(),
            this.config.waitIdleMs,
            this.abort.signal,
          )
          await this.resources(agent)
          const checked = await inspectWorkspace(
            await this.mapping(record.manifest.workspace.projectId),
            record.manifest.workspace.relativeCwd,
            this.abort.signal,
            record.manifest.workspace.kind ?? 'git',
          )
          if (
            checked.proof.commit !== record.manifest.workspace.commit ||
            checked.proof.mappingRevision !==
              record.manifest.workspace.mappingRevision
          )
            throw new MeshError(
              'WORKSPACE_MISMATCH',
              'source project changed during preflight',
            )
          await this.ctx.sessions.flush(agent.session)
          local.phase = 'uncertain'
          await local.control.stop()
          local.phase = 'source-stopped'
          const finalWorkspace = await inspectWorkspace(
            await this.mapping(record.manifest.workspace.projectId),
            record.manifest.workspace.relativeCwd,
            this.abort.signal,
            record.manifest.workspace.kind ?? 'git',
          )
          if (
            finalWorkspace.proof.commit !== record.manifest.workspace.commit ||
            finalWorkspace.proof.mappingRevision !==
              record.manifest.workspace.mappingRevision ||
            JSON.stringify(this.route(agent)) !==
              JSON.stringify(record.manifest.model) ||
            relativeInside(
              finalWorkspace.root,
              this.ctx.workingDirectory.get(agent.session),
            ) !== record.manifest.workspace.relativeCwd
          )
            throw new MeshError(
              'WORKSPACE_MISMATCH',
              'source workspace or model changed during teardown',
            )
        }
        if (local.phase === 'source-stopped') await this.client.finalize(record)
      } catch (error) {
        if (
          isMeshError(error) &&
          error.status >= 500 &&
          local.phase === 'source-stopped'
        )
          throw error
        const fresh = await this.client.get(record.id)
        if (fresh.state !== 'preparing') return
        const failed = await this.client.fail(
          fresh,
          local.phase === 'source-live' ? 'source-preflight' : 'source-stop',
          message(error),
        )
        if (local.phase === 'source-live' && failed.state === 'failed') {
          this.release(record.sessionId)
          this.transfers.delete(record.id)
        }
        this.warn(record.sessionId, error)
      }
    } else if (
      target &&
      (record.state === 'ready' ||
        (record.state === 'activating' &&
          local?.phase === 'target-starting' &&
          local.acceptOperationId))
    ) {
      local ??= {
        control: this.freeze(record.sessionId),
        phase: 'target-starting',
      }
      this.transfers.set(record.id, local)
      let accepted: Awaited<ReturnType<HandoffClient['accept']>> | undefined
      try {
        const { mapping, workspace } = await this.preflight(record)
        local.acceptOperationId ??= randomUUID()
        accepted =
          record.state === 'ready'
            ? await this.client.accept(
                record,
                workspace.proof,
                local.acceptOperationId,
              )
            : await this.client.accepted(local.acceptOperationId)
        const current = accepted.handoff
        const owned = await local.control.run(() =>
          this.ctx.contextmesh.withClaim(accepted!.handle, () =>
            this.resumeAgent(
              record.sessionId,
              record.manifest,
              mapping,
              current.incarnation,
              false,
              true,
            ),
          ),
        )
        local.agent = owned
        local.phase = 'target-live'
        await this.ctx.sessions.flush(owned.agent.session)
        const snapshot = await this.client.mesh.stat(record.sessionId)
        if (!snapshot) throw new Error('restored session disappeared')
        await this.client.complete(current, snapshot.nextSeq)
        this.fenced.delete(record.sessionId)
        this.release(record.sessionId)
        this.errors.delete(record.sessionId)
        await this.publish(owned.agent, mapping.projectId).catch((error) =>
          this.warn(record.sessionId, error),
        )
      } catch (error) {
        const fresh = await this.client.get(record.id)
        if (fresh.state === 'completed') {
          this.release(record.sessionId)
          return
        }
        if (isMeshError(error) && error.status >= 500) throw error
        let closed = false
        try {
          if (local.agent) {
            await local.agent.dispose()
            closed = true
          } else if (accepted) {
            await this.client.mesh.close(accepted.handle, randomUUID())
            closed = true
          }
        } catch (closeError) {
          this.warn(record.sessionId, closeError)
        }
        if (['ready', 'activating'].includes(fresh.state))
          await this.client.fail(fresh, 'target-resume', message(error), closed)
        local.phase = 'uncertain'
        this.warn(record.sessionId, error)
      }
    } else if (
      record.state === 'activating' &&
      target &&
      local?.phase === 'target-live' &&
      local.agent
    ) {
      // A lost complete response is reconciled without resuming or driving twice.
      await this.ctx.sessions.flush(local.agent.agent.session)
      const snapshot = await this.client.mesh.stat(record.sessionId)
      if (snapshot) {
        await this.client.complete(record, snapshot.nextSeq)
        this.release(record.sessionId)
      }
    } else if (
      (record.state === 'cancelled' || record.state === 'failed') &&
      source &&
      local?.phase === 'source-live'
    ) {
      this.release(record.sessionId)
      this.transfers.delete(record.id)
    }
  }
  private async resumeAgent(
    id: string,
    manifest: HandoffManifest,
    mapping: ProjectMapping,
    incarnation: string,
    preserveLocalCwd = false,
    installTargetModel = false,
  ) {
    const policyRoot = await mappedDirectory(
      mapping,
      manifest.sandbox.relativeRoot,
    )
    const cwd = await mappedDirectory(mapping, manifest.workspace.relativeCwd)
    const binding = {
      incarnation,
      projectId: mapping.projectId,
      policyRelativeRoot: manifest.sandbox.relativeRoot,
    }
    const native = this.ctx.get('sessionController')
    const setup = async (agentCtx: Context, agent: Agent) => {
      if (manifest.preset && !native)
        await this.ctx.get('agentPresets')!.mount(agentCtx, manifest.preset)
      const policy = this.policy(agentCtx)
      const mode = preserveLocalCwd
        ? policy.resolve({ session: agent.session }).mode
        : manifest.sandbox.mode
      if (ranks[mode] > ranks[policy.defaultMode])
        throw new MeshError(
          'POLICY_MISMATCH',
          'target preset policy is stricter than the source',
        )
      policy.bindWorkspace(agent.session, policyRoot.cwd)
      if (!preserveLocalCwd) setSandboxMode(agent.session, mode)
      const currentCwd = this.ctx.workingDirectory.get(agent.session)
      const restoredCwd = preserveLocalCwd
        ? ((await localDirectory(mapping, currentCwd)) ?? cwd.cwd)
        : cwd.cwd
      if (currentCwd !== restoredCwd)
        await this.ctx.workingDirectory.set(agent, restoredCwd)
      if (installTargetModel && manifest.targetModel) {
        if (!native || native.modelRelayVersion !== 1)
          throw new MeshError(
            'MODEL_RELAY_UNSUPPORTED',
            'native model selection bridge is required',
          )
        const llm =
          this.ctx.get('agentPresets')?.serviceFor(agent, 'llm') ??
          agentCtx.get('llm') ??
          this.ctx.llm
        const budget = await inspectModel(
          llm,
          agent.session,
          manifest.targetModel,
          this.abort.signal,
          agent.options.maxTokens,
        )
        native.installModelSelection(agent, manifest.targetModel)
        this.guardModel(id, budget)
      }
      this.state.bindings[id] = binding
      await this.save()
    }
    if (native) {
      const control = this.controls.get(id)
      if (!control)
        throw new Error('controlled resume requires a held lifecycle control')
      await control.run(async () => {
        const result = await native.resolveAgent(SessionId(id))
        if ('error' in result) throw result.error
      }, setup)
      return control.ownedHandle()
    }
    return this.ctx.agents.resume({
      resumeSessionId: SessionId(id),
      agentOptions: this.options(manifest),
      setup,
    })
  }
  private async bindExisting(agent: Agent) {
    let binding = this.state.bindings[agent.id]
    let history: HandoffRecord[] | undefined
    if (!binding) {
      history = await this.client.commands()
      if (
        !history.some(
          (record) =>
            record.sessionId === agent.id && record.state === 'completed',
        )
      )
        return
    }
    const snapshot = await this.client.mesh.stat(agent.id)
    if (!binding && snapshot) {
      const previous = history!.find(
        (record) =>
          record.sessionId === agent.id &&
          record.incarnation === snapshot.incarnation &&
          record.state === 'completed' &&
          (record.sourceNodeId === this.client.nodeId ||
            record.targetNodeId === this.client.nodeId),
      )
      if (!previous) return
      binding = {
        incarnation: snapshot.incarnation,
        projectId: previous.manifest.workspace.projectId,
        policyRelativeRoot: previous.manifest.sandbox.relativeRoot,
      }
      this.state.bindings[agent.id] = binding
      await this.save()
    }
    if (!binding) return
    if (!snapshot || snapshot.incarnation !== binding.incarnation) {
      delete this.state.bindings[agent.id]
      await this.save()
      return
    }
    const mapping = await this.mapping(binding.projectId)
    const root = await mappedDirectory(mapping, binding.policyRelativeRoot)
    const policy = this.policy(agent.ctx)
    if (
      ranks[policy.resolve({ session: agent.session }).mode] >
      ranks[policy.defaultMode]
    )
      throw new MeshError(
        'POLICY_MISMATCH',
        'local policy no longer permits this restored session mode',
      )
    policy.bindWorkspace(agent.session, root.cwd)
    if (
      await localDirectory(
        mapping,
        this.ctx.workingDirectory.get(agent.session),
      )
    )
      return
    const previous = (history ?? (await this.client.commands())).find(
      (record) =>
        record.sessionId === agent.id &&
        record.incarnation === binding.incarnation &&
        record.manifest.workspace.projectId === binding.projectId &&
        (record.sourceNodeId === this.client.nodeId ||
          record.targetNodeId === this.client.nodeId) &&
        record.state === 'completed',
    )
    if (!previous)
      throw new MeshError(
        'SESSION_DIRECTORY_UNMAPPED',
        'no completed local handoff describes this session directory',
      )
    const restored = await mappedDirectory(
      mapping,
      previous.manifest.workspace.relativeCwd,
    )
    await this.ctx.workingDirectory.set(agent, restored.cwd)
  }
  async resumeHere(sessionId: string) {
    const existing = this.ctx.agents.get(SessionId(sessionId))
    if (existing) return { sessionId }
    const history = (await this.client.commands()).find(
      (r) =>
        r.sessionId === sessionId &&
        ((r.state === 'completed' && r.targetNodeId === this.client.nodeId) ||
          ['failed', 'cancelled'].includes(r.state)),
    )
    if (!history)
      throw new MeshError(
        'NOT_READY',
        'this device has no resumable handoff for the session',
      )
    const control = this.freeze(sessionId)
    const mapping = await this.mapping(history.manifest.workspace.projectId)
    if (history.state !== 'completed') await this.preflight(history)
    try {
      const owned = await control.run(() =>
        this.resumeAgent(
          sessionId,
          history.manifest,
          mapping,
          history.incarnation,
          history.state === 'completed',
        ),
      )
      await this.ctx.sessions.flush(owned.agent.session)
      this.fenced.delete(sessionId)
      this.release(sessionId)
      this.errors.delete(sessionId)
      return { sessionId }
    } catch (error) {
      this.warn(sessionId, error)
      throw error
    }
  }
  async publish(agent: Agent, projectId: string) {
    await this.ctx.sessions.flush(agent.session)
    const snapshot = await this.client.mesh.stat(agent.id)
    if (!snapshot) return
    const claim = await this.client.mesh.open(agent.id, 'read')
    try {
      const data = await this.client.mesh.read(
        claim,
        0,
        Number.MAX_SAFE_INTEGER,
      )
      let title = agent.id.toString(),
        lastActivity = Number(snapshot.header.createdAt ?? 0)
      for (const event of data.events) {
        if (event.type === 'session/title')
          title = z.object({ title: z.string() }).parse(event.data).title
        lastActivity = Math.max(lastActivity, event.time)
      }
      await this.client.summary(agent.id, {
        incarnation: snapshot.incarnation,
        nextSeq: data.end,
        title,
        projectId,
        lastActivity,
      })
    } finally {
      await this.client.mesh.close(claim, randomUUID())
    }
  }
  private async fulfillTakeover(intent: TakeoverRecord) {
    try {
      const claim = this.ctx.contextmesh.writerClaim(
        SessionId(intent.sessionId),
      )
      if (
        claim.handleId !== intent.sourceHandleId ||
        claim.epoch !== intent.sourceEpoch
      )
        throw new MeshError('TAKEOVER_CHANGED', 'the original writer changed')
      const session = (await this.client.sessions()).find(
        (s) => s.id === intent.sessionId,
      )
      if (!session?.projectId)
        throw new MeshError(
          'PROJECT_REQUIRED',
          'choose a project for this session first',
        )
      const agent = this.ctx.agents.get(SessionId(intent.sessionId))
      if (!agent)
        throw new MeshError(
          'TAKEOVER_CHANGED',
          'the source session is no longer active',
        )
      await this.prepareProject(agent, session.projectId, session.incarnation)
      await this.begin(
        intent.sessionId,
        intent.targetNodeId,
        session.projectId,
        intent,
      )
    } catch (error) {
      if (
        this.pendingRequests.has(intent.sessionId) ||
        (isMeshError(error) && error.status >= 500)
      )
        throw error
      const code = isMeshError(error) ? error.code : 'TAKEOVER_FAILED'
      await this.client.failTakeover(intent, code, message(error))
    }
  }
  private async prepareProject(
    agent: Agent,
    projectId: string,
    incarnation: string,
  ) {
    let mapping = (await this.client.mappings()).find(
      (m) => m.projectId === projectId,
    )
    if (!mapping) {
      const root = await sourceWorkspaceRoot(
        this.ctx.workingDirectory.get(agent.session),
        this.policy(agent.ctx).resolve({ session: agent.session })
          .workspaceRoot,
        this.abort.signal,
      )
      mapping = await this.client.mapping(projectId, root, true)
    }
    const local = await this.localMapping(agent, projectId)
    const policy = this.policy(agent.ctx).resolve({ session: agent.session })
    this.state.bindings[agent.id] = {
      incarnation,
      projectId,
      policyRelativeRoot: relativeInside(
        local.mapping.root,
        policy.workspaceRoot,
      ),
    }
    await this.save()
    await this.publish(agent, projectId)
  }
  private async configureProject(command: {
    sessionId: string
    projectId: string
    incarnation: string
    expectedSourceNodeId: string
    root?: string
  }) {
    const features = await this.ctx.contextmesh.client.capabilities()
    if (!features.features?.includes('project-setup-v1'))
      throw new MeshError(
        'PROJECT_SETUP_UNSUPPORTED',
        'upgrade the ContextMesh server before setting up this session',
      )
    const session = (await this.client.sessions()).find(
      (s) => s.id === command.sessionId,
    )
    if (
      !session ||
      session.incarnation !== command.incarnation ||
      session.activeNodeId !== command.expectedSourceNodeId
    )
      throw new MeshError(
        'TAKEOVER_CHANGED',
        'the session owner changed during project setup',
      )
    let mapping = (await this.client.mappings()).find(
      (m) => m.projectId === command.projectId,
    )
    if (!mapping) {
      let requestedRoot = command.root
      if (
        !requestedRoot &&
        command.expectedSourceNodeId === this.client.nodeId
      ) {
        const agent = this.ctx.agents.get(SessionId(command.sessionId))
        if (agent)
          requestedRoot = await sourceWorkspaceRoot(
            this.ctx.workingDirectory.get(agent.session),
            this.policy(agent.ctx).resolve({ session: agent.session })
              .workspaceRoot,
            this.abort.signal,
          )
      }
      if (!requestedRoot)
        throw new MeshError(
          'PROJECT_DIRECTORY_REQUIRED',
          'choose this device’s project directory',
        )
      const root = await realpath(requestedRoot)
      mapping = await this.client.mapping(command.projectId, root, true)
    }
    await mappedDirectory(mapping, '')
    const sourceMapping = (
      await this.client.mappings(command.expectedSourceNodeId)
    ).find((m) => m.projectId === command.projectId)
    if (sourceMapping) {
      const reader = await this.ctx.contextmesh.open(
        SessionId(command.sessionId),
        'read',
      )
      try {
        const log = await reader.read()
        let cwd = reader.header.cwd
        for (const event of log.events)
          if (event.type === 'working-directory/change')
            cwd = z.object({ cwd: z.string() }).parse(event.data).cwd
        try {
          if (!cwd) throw new Error('missing session directory')
          relativeInside(sourceMapping.root, cwd)
        } catch {
          throw new MeshError(
            'PROJECT_DIRECTORY_CONFLICT',
            'the conversation is outside this project on the source device',
          )
        }
      } finally {
        await reader.close()
      }
    }
    const assigned = await this.client.assignProject(
      command.sessionId,
      command.projectId,
      command.incarnation,
      command.expectedSourceNodeId,
    )
    if (command.expectedSourceNodeId === this.client.nodeId) {
      const agent = this.ctx.agents.get(SessionId(command.sessionId))
      if (agent)
        await this.prepareProject(agent, command.projectId, command.incarnation)
    }
    return assigned
  }
  async takeover(
    sessionId: string,
    operationId: string = randomUUID(),
    targetModel?: ModelRoute,
  ) {
    const session = (await this.client.sessions()).find(
      (s) => s.id === sessionId,
    )
    if (!session || !session.activeNodeId || session.recoveryRequired)
      throw new MeshError(
        'TAKEOVER_UNAVAILABLE',
        'no confirmed live owner; verify the previous device before recovery',
      )
    if (session.activeNodeId === this.client.nodeId)
      throw new MeshError(
        'TAKEOVER_CHANGED',
        'session is already on this device; refresh and send again',
      )
    if (!session.projectId)
      throw new MeshError(
        'PROJECT_REQUIRED',
        'choose a project for this session first',
      )
    await mappedDirectory(await this.mapping(session.projectId), '')
    return this.client.takeover(
      sessionId,
      session.activeNodeId,
      operationId,
      targetModel,
    )
  }
  async takeoverStatus(id: string) {
    const intent = await this.client.getTakeover(id)
    if (
      intent.targetNodeId !== this.client.nodeId ||
      intent.targetInstanceId !== this.client.mesh.instanceId
    )
      throw new MeshError(
        'WRONG_DEVICE',
        'takeover belongs to a different device instance',
      )
    const handoff = intent.handoffId
      ? await this.client.get(intent.handoffId)
      : undefined
    return {
      ...intent,
      handoffState:
        handoff?.state === 'completed' && this.controls.has(intent.sessionId)
          ? 'activating'
          : handoff?.state,
      handoffError: handoff?.error,
    }
  }
  async command(input: unknown): Promise<unknown> {
    const command = commandSchema.parse(input)
    switch (command.action) {
      case 'pair-device':
        return new DeviceClient(this.client.mesh).create(
          command.name,
          command.operationId,
        )
      case 'paired-devices':
        return new DeviceClient(this.client.mesh).list()
      case 'revoke-device':
        return new DeviceClient(this.client.mesh).revoke(command.credentialId)
      case 'models': {
        const models = await this.models()
        await this.client.register(this.config.nodeName, models)
        this.catalogRefreshed = Date.now()
        return models
      }
      case 'select-model':
        return this.exclusive(command.sessionId, () =>
          this.relay.select(command),
        )
      case 'model-relay-status':
        return this.relay.client.get(command.operationId)
      case 'status':
        return this.status()
      case 'refresh':
        await this.tick()
        return this.status()
      case 'handoff':
        return this.exclusive(command.sessionId, () =>
          this.begin(
            command.sessionId,
            command.targetNodeId,
            command.projectId,
            undefined,
            command.targetModel,
          ),
        )
      case 'takeover':
        return this.takeover(
          command.sessionId,
          command.operationId,
          command.targetModel,
        )
      case 'takeover-status':
        return this.takeoverStatus(command.takeoverId)
      case 'configure-project':
        return this.configureProject(command)
      case 'cancel': {
        const record = await this.client.get(command.handoffId)
        return this.exclusive(record.sessionId, () =>
          this.cancel(command.handoffId),
        )
      }
      case 'resume':
        return this.exclusive(command.sessionId, () =>
          this.resumeHere(command.sessionId),
        )
      case 'history':
        return this.history(command.sessionId, command.offset)
      case 'project':
        return this.client.project(command.name, command.projectId)
      case 'mapping': {
        const root = await realpath(command.root)
        await mappedDirectory(
          {
            projectId: command.projectId,
            nodeId: this.client.nodeId,
            root,
            revision: 1,
          },
          '',
        )
        const result = await this.client.mapping(command.projectId, root)
        for (const agent of this.ctx.agents.list()) this.dirty.add(agent.id)
        return result
      }
    }
  }
  async status() {
    return {
      connection: {
        endpoint: this.client.mesh.endpoint,
        ...(await new DeviceClient(this.client.mesh).identity()),
      },
      nodeId: this.client.nodeId,
      name: this.config.nodeName,
      nodes: await this.client.nodes(),
      models: await this.models(),
      modelRelays: await this.relay.client.pending(),
      modelSwitching: [...this.relay.pending.keys()],
      projects: await this.client.projects(),
      mappings: await this.client.mappings(),
      sessions: await this.client.sessions(),
      handoffs: await this.client.commands(),
      errors: Object.fromEntries(this.errors),
      pendingRequests: [...this.pendingRequests.keys()],
    }
  }
  async history(sessionId: string, offset?: number) {
    const handle = await this.client.mesh.open(sessionId, 'read')
    try {
      const from = offset ?? Math.max(0, handle.session.nextSeq - 200)
      return {
        header: handle.session.header,
        incarnation: handle.session.incarnation,
        from,
        total: handle.session.nextSeq,
        events: (await this.client.mesh.read(handle, from, 200)).events,
      }
    } finally {
      await this.client.mesh.close(handle, randomUUID())
    }
  }
  async cancel(id: string) {
    const record = await this.client.get(id)
    const result = await this.client.cancel(record)
    const local = this.transfers.get(id)
    if (local?.phase === 'source-live') this.release(record.sessionId)
    return result
  }
  async close() {
    this.closing = true
    this.abort.abort(new Error('ContextMesh plugin stopping'))
    clearInterval(this.pollTimer)
    clearInterval(this.heartbeatTimer)
    await Promise.allSettled([
      this.polling,
      this.heartbeating,
      ...this.jobs.values(),
      ...this.retiring,
    ])
    const errors: unknown[] = []
    for (const transfer of this.transfers.values())
      if (transfer.agent)
        try {
          await transfer.agent.dispose()
        } catch (error) {
          errors.push(error)
        }
    await this.saved
    await this.client.offline().catch((error) => this.warn('offline', error))
    if (errors.length)
      throw new AggregateError(errors, 'ContextMesh target shutdown failed')
  }
}
