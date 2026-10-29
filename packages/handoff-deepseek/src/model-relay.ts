import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentControl } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { randomUUID } from 'node:crypto'
import { ModelRelayClient } from '../../client/src/model-relay.js'
import type {
  ModelRelayRequest,
  ModelRoute,
} from '../../protocol/src/model-relay.js'
import { modelRoute } from '../../protocol/src/handoff.js'
import { MeshError } from '../../protocol/src/index.js'
import { type ModelBudget } from './model-compatibility.js'

interface Pending {
  sessionId: string
  request: Omit<ModelRelayRequest, 'nodeId' | 'instanceId'>
  agent: Agent
  control: AgentControl
  budget: ModelBudget
  applied: boolean
}
interface Hooks {
  freeze(id: string): AgentControl
  release(id: string): void
  route(agent: Agent): ModelRoute
  resources(agent: Agent): Promise<void>
  wait(work: Promise<void>): Promise<void>
  guard(id: string, budget: ModelBudget): Promise<void>
  inspect(
    agent: Agent,
    target: ModelRoute,
    allowEstimate?: boolean,
  ): Promise<ModelBudget>
}
const equal = (a: ModelRoute | null, b: ModelRoute) =>
  JSON.stringify(a) === JSON.stringify(b)
export class ModelRelayController {
  readonly pending = new Map<string, Pending>()
  private readonly settling = new Map<
    string,
    Promise<{ selected: ModelRoute }>
  >()
  constructor(
    readonly ctx: Context,
    readonly client: ModelRelayClient,
    readonly hooks: Hooks,
  ) {}
  async select(
    request: ModelRoute & {
      sessionId: string
      operationId?: string
      allowEstimatedCapacity?: boolean
    },
  ) {
    const target = modelRoute.parse(request)
    const previous = this.pending.get(request.sessionId)
    if (previous) {
      if (
        !equal(previous.request.target, target) ||
        (request.operationId &&
          previous.request.operationId !== request.operationId)
      )
        throw new MeshError(
          'MODEL_RELAY_BUSY',
          'another model switch is still being saved',
        )
      return this.settle(previous)
    }
    if (request.operationId) {
      try {
        const prior = await this.client.get(request.operationId)
        if (
          prior.sessionId !== request.sessionId ||
          !equal(prior.target, target)
        )
          throw new MeshError(
            'IDEMPOTENCY_CONFLICT',
            'model switch identity was reused',
          )
        if (prior.state === 'completed') return { selected: prior.target }
        if (prior.state === 'failed')
          throw new MeshError(
            'MODEL_RELAY_CHANGED',
            'the previous switch did not commit; start a new switch',
          )
        throw new MeshError(
          'MODEL_RELAY_BUSY',
          'the previous switch still needs reconciliation',
        )
      } catch (error) {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'NOT_FOUND'
        ))
          throw error
      }
    }
    const native = this.ctx.get('sessionController')
    if (native?.modelRelayVersion !== 1)
      throw new MeshError(
        'MODEL_RELAY_UNSUPPORTED',
        'install the pinned model relay bridge',
      )
    const agent = this.ctx.agents.get(SessionId(request.sessionId))
    if (!agent)
      throw new MeshError(
        'NOT_LOCAL_WRITER',
        'take over this conversation before switching its model',
      )
    if (this.ctx.agents.isControlled(agent.id))
      throw new MeshError(
        'MODEL_RELAY_BUSY',
        'wait for the current transition to finish',
      )
    const control = this.hooks.freeze(agent.id)
    try {
      await this.hooks.wait(control.quiesce())
      await this.hooks.wait(agent.whenIdle())
      await this.hooks.resources(agent)
      let source: ModelRoute | null = null
      try {
        source = this.hooks.route(agent)
      } catch {
        /* A fresh native conversation may have no recorded route yet. */
      }
      const budget = await this.hooks.inspect(
        agent,
        target,
        request.allowEstimatedCapacity,
      )
      await this.ctx.sessions.flush(agent.session)
      if (equal(source, target)) {
        await this.hooks.guard(agent.id, budget)
        this.hooks.release(agent.id)
        return { selected: target }
      }
      const claim = this.ctx.contextmesh.writerClaim(agent.id)
      const snapshot = await this.ctx.contextmesh.client.stat(agent.id)
      if (!snapshot)
        throw new MeshError('NOT_FOUND', 'conversation disappeared')
      const pending: Pending = {
        sessionId: agent.id,
        agent,
        control,
        budget,
        applied: false,
        request: {
          operationId: request.operationId ?? randomUUID(),
          handleId: claim.handleId,
          epoch: claim.epoch,
          incarnation: snapshot.incarnation,
          historyCut: snapshot.nextSeq,
          source,
          target,
        },
      }
      this.pending.set(agent.id, pending)
      return await this.settle(pending)
    } catch (error) {
      if (!this.pending.has(agent.id)) this.hooks.release(agent.id)
      throw error
    }
  }
  settle(pending: Pending): Promise<{ selected: ModelRoute }> {
    const existing = this.settling.get(pending.sessionId)
    if (existing) return existing
    const operation = this.apply(pending)
    this.settling.set(pending.sessionId, operation)
    const clear = () => {
      if (this.settling.get(pending.sessionId) === operation)
        this.settling.delete(pending.sessionId)
    }
    void operation.then(clear, clear)
    return operation
  }
  private async apply(pending: Pending) {
    const native = this.ctx.get('sessionController')!
    try {
      const record = await this.client.prepare(
        pending.sessionId,
        pending.request,
      )
      if (!pending.applied) {
        if (
          this.ctx.agents.get(pending.agent.id) !== pending.agent ||
          pending.agent.session.snapshotEvents().length !== record.historyCut
        ) {
          await this.client.finish(record.id, true)
          throw new MeshError(
            'MODEL_RELAY_CHANGED',
            'conversation changed while the model was being checked',
          )
        }
        const seq = pending.control.run(() =>
          native.installModelSelection(pending.agent, record.target),
        )
        pending.applied = true
        if (seq !== record.historyCut)
          throw new MeshError(
            'MODEL_RELAY_CHANGED',
            'model event did not match its reserved cut',
          )
      }
      await this.ctx.sessions.flush(pending.agent.session)
      const saved = await this.client.finish(record.id)
      if (saved.state !== 'completed')
        throw new MeshError(
          'MODEL_RELAY_CHANGED',
          'model selection could not be confirmed',
        )
      await this.hooks.guard(pending.sessionId, pending.budget)
      this.pending.delete(pending.sessionId)
      this.hooks.release(pending.sessionId)
      return { selected: saved.target }
    } catch (error) {
      // A rejected prepare has no reserved cut. After a local append, retain the freeze until its durable result is known.
      if (
        !pending.applied &&
        error instanceof Error &&
        'status' in error &&
        typeof error.status === 'number' &&
        error.status < 500 &&
        !(
          'code' in error &&
          ['MODEL_RELAY_UNCONFIRMED', 'MODEL_RELAY_BUSY'].includes(
            String(error.code),
          )
        )
      ) {
        this.pending.delete(pending.sessionId)
        this.hooks.release(pending.sessionId)
      }
      throw error
    }
  }
  async reconcile() {
    for (const pending of this.pending.values()) await this.settle(pending)
    for (const record of await this.client.pending()) {
      if (this.pending.has(record.sessionId)) continue
      this.hooks.freeze(record.sessionId)
      await this.client.finish(record.id)
      this.hooks.release(record.sessionId)
    }
  }
}
