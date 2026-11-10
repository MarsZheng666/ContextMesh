import { mkdtemp, rm, realpath, access } from 'node:fs/promises'
import { constants } from 'node:fs'

import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DeviceClient } from '../../client/src/devices.js'
import { MeshClient, type ClientOptions } from '../../client/src/index.js'
import {
  HandoffClient,
  recordSchema,
  type ProjectMapping,
} from '../../client/src/handoff.js'
import type { HandoffRecord } from '../../protocol/src/handoff.js'
import {
  validatePortable,
  type PortableContext,
} from '../../protocol/src/portable.js'
import {
  privateDirectory,
  atomicJson,
  optionalJson,
} from '../../runtime-manager/src/files.js'
import { listenLocal } from '../../handoff-deepseek/src/local-control.js'
import {
  inspectWorkspace,
  mappedDirectory,
} from '../../handoff-deepseek/src/workspace.js'
import { NativeCodex, type StartTarget, type Target } from './native.js'
import { CodexBridge } from './bridge.js'
import { CodexSharedSync } from './shared-sync.js'
import { sharedFeature } from '../../protocol/src/shared.js'
import { deepSeekContext } from './context.js'
import type { CodexOptions } from './rpc.js'

// Native config/read emits null for omitted TOML fields; overrides must omit those fields.
function tomlFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tomlFields)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, tomlFields(v)]),
    )
  return value
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const registration = z.object({ nodeId: z.uuid() })
const continuing = (record: HandoffRecord) =>
  `The user confirmed transferring this task from DeepSeek Harness to Codex. Turn ${record.manifest.continuation!.turn} was unfinished. Continue the original user's remaining task using the preceding context, completed tool results and this device's workspace. Do not repeat completed operations. Inspect the current state before actions whose effects are uncertain. If files or permissions are missing, explain what is needed instead of guessing. Handoff reference: ${record.id}.`
export interface TakeoverOptions {
  connection: Omit<ClientOptions, 'adapter'>
  stateDir: string
  native?: CodexOptions
  deviceId?: string
  name?: string
  progress?: (message: string) => void
}
/** A foreground receiving endpoint. It exists only for an explicitly confirmed operation. */
export class ConfirmedCodexTakeover {
  readonly bridge: CodexBridge
  constructor(readonly options: TakeoverOptions) {
    this.bridge = new CodexBridge(options)
  }
  private async deviceId() {
    return (
      this.options.deviceId ??
      (await new DeviceClient(this.bridge.client).identity()).nodeId ??
      undefined
    )
  }
  private async endpoint() {
    const file = join(this.options.stateDir, 'receiver.json')
    let identity = registration.optional().parse(await optionalJson(file))
    if (!identity) {
      identity = { nodeId: randomUUID() }
      await atomicJson(file, identity)
    }
    return new HandoffClient(this.bridge.client, identity.nodeId)
  }
  private async locked<T>(run: () => Promise<T>) {
    const directory = join(this.options.stateDir, 'receiver-control')
    await privateDirectory(directory)
    const lock = await listenLocal(directory, async () => ({ busy: true }))
    try {
      return await run()
    } finally {
      await lock.close()
    }
  }
  private update(client: HandoffClient, record: HandoffRecord) {
    return {
      ...client.identity,
      operationId: randomUUID(),
      revision: record.revision,
    }
  }
  private async snapshot(sourceId: string, phase: 'preflight' | 'final') {
    const mesh = new MeshClient({
      ...this.options.connection,
      adapter: 'deepseek',
    })
    const handle = await mesh.open(sourceId, 'read')
    try {
      const read = await mesh.read(handle, 0, Number.MAX_SAFE_INTEGER)
      const context = deepSeekContext(
        { ...read.snapshot, nextSeq: read.end },
        read.events,
        phase,
      )
      if (!context.messages.length)
        throw new Error(
          'This conversation has no portable messages to transfer; keep using it in DSH',
        )
      return context
    } finally {
      await mesh.close(handle, randomUUID())
    }
  }
  private async probe(target: StartTarget, context: PortableContext) {
    await privateDirectory(this.options.stateDir)
    const cwd = await mkdtemp(join(this.options.stateDir, 'probe-'))
    const native = new NativeCodex(this.options.native)
    try {
      await native.init()
      const config = z
        .object({
          config: z
            .object({
              mcp_servers: z.record(z.string(), z.unknown()).optional(),
              model_providers: z.record(z.string(), z.unknown()).optional(),
            })
            .passthrough(),
        })
        .parse(
          await native.rpc.request('config/read', {
            cwd: target.cwd,
            includeLayers: false,
          }),
        )
      const overrides: Record<string, unknown> = {
        'features.plugins': false,
        'features.apps': false,
        'features.shell_tool': false,
        'features.apply_patch_freeform': false,
        'features.multi_agent': false,
        'features.hooks': false,
        'features.memories': false,
        'features.js_repl': false,
        'tools.view_image': false,
        web_search: 'disabled',
      }
      for (const name of Object.keys(config.config.mcp_servers ?? {})) {
        if (!/^[A-Za-z0-9_-]+$/.test(name))
          throw new Error(
            'Unsupported MCP configuration name during restricted readiness check',
          )
        overrides[`mcp_servers.${name}.enabled`] = false
      }
      // Check the requested native permission policy without starting task work.
      const { threadId: policyThread, target: selected } = await native.start(
        target,
        overrides,
      )
      // The temporary directory must use the provider resolved in the user's actual project.
      const definitions = z
        .record(z.string(), z.unknown())
        .optional()
        .parse(config.config.model_providers)
      if (definitions?.[selected.provider]) {
        if (!/^[A-Za-z0-9_-]+$/.test(selected.provider))
          throw new Error('Unsupported local provider name')
        overrides[`model_providers.${selected.provider}`] = tomlFields(
          definitions[selected.provider],
        )
      }
      await native.rpc
        .request('thread/archive', { threadId: policyThread })
        .catch(() => {})
      const { threadId: thread } = await native.start(
        { ...selected, cwd, sandbox: 'read-only' },
        overrides,
        'This is a readiness check only. Do not perform the imported task and do not call tools. Reply with a short readiness acknowledgement.',
      )
      await native.inject(thread, validatePortable(context))
      const turn = await native.execute(
        thread,
        'Confirm that this context can be read. Do not execute the task or call tools.',
        60000,
      )
      const snapshot = await native.snapshot(thread)
      if (
        turn.status !== 'completed' ||
        snapshot.items.some(
          (entry) =>
            !['userMessage', 'agentMessage', 'reasoning'].includes(
              entry.item.type,
            ),
        )
      )
        throw new Error('Codex readiness check did not complete without tools')
      const provider = z
        .string()
        .min(1)
        .max(256)
        .parse(snapshot.thread.modelProvider)
      await native.rpc
        .request('thread/archive', { threadId: thread })
        .catch(() => {})
      return {
        target: { ...selected, provider },
        version: snapshot.thread.cliVersion,
      }
    } finally {
      await native.close()
      await rm(cwd, { recursive: true, force: true })
    }
  }
  private async ready() {
    const health = z
      .object({ schemaVersion: z.number(), features: z.array(z.string()) })
      .parse(await this.bridge.client.request('/health/ready'))
    if (
      health.schemaVersion < 8 ||
      !health.features.includes('cross-agent-takeover-v1')
    )
      throw new Error(
        'Upgrade the ContextMesh Server for confirmed Codex takeover',
      )
  }
  async takeover(input: {
    sourceId: string
    target: StartTarget
    confirmed: true
    operationId?: string
    waitMs?: number
  }) {
    if (input.confirmed !== true)
      throw new Error(
        'Confirm takeover before preparing or stopping another device',
      )
    const operationId = z
      .uuid()
      .parse(input.operationId ?? randomUUID())
      .toLowerCase()
    return this.locked(async () => {
      await this.ready()
      const file = join(
        this.options.stateDir,
        'takeovers',
        operationId + '.json',
      )
      if (await optionalJson(file))
        throw new Error(
          `Takeover ${operationId} already exists. Inspect its status instead of submitting again`,
        )
      const client = await this.endpoint()
      let record: HandoffRecord | undefined,
        heartbeat: NodeJS.Timeout | undefined,
        takeoverId: string | undefined
      const progress = (message: string) => this.options.progress?.(message)
      const save = (phase: string) =>
        atomicJson(file, {
          version: 1,
          operationId,
          sourceId: input.sourceId,
          handoffId: record?.id,
          takeoverId,
          targetSessionId: record?.targetSessionId,
          phase,
        })
      try {
        const source = (await client.sessions()).find(
          (session) => session.id === input.sourceId,
        )
        if (
          !source?.activeNodeId ||
          source.recoveryRequired ||
          source.successorSessionId
        )
          throw new Error(
            'No confirmed live DSH writer is available for this session',
          )
        await save('checking-receiver')
        progress(`Receiver operation: ${operationId}`)
        progress(
          'Checking the receiving Codex model before requesting source stop…',
        )
        const context = await this.snapshot(input.sourceId, 'preflight')
        const root = await realpath(input.target.cwd)
        await access(
          root,
          constants.R_OK |
            (input.target.sandbox === 'workspace-write' ? constants.W_OK : 0),
        )
        const checked = await this.probe(
          { ...input.target, cwd: root },
          context,
        )
        await client.register(
          this.options.name ?? 'Codex receiver',
          [
            {
              provider: checked.target.provider!,
              model: checked.target.model,
              name: checked.target.model,
            },
          ],
          {
            adapter: 'codex',
            harness: checked.version,
            deviceId: await this.deviceId(),
          },
        )
        heartbeat = setInterval(() => {
          void client.heartbeat().catch(() => {})
        }, 5000)
        let projectId = source.projectId
        if (!projectId) {
          projectId = randomUUID()
          await client.project(
            'Conversation ' + input.sourceId.slice(0, 8),
            projectId,
          )
          await client.mapping(projectId, root, true)
          await client.assignProject(
            source.id,
            projectId,
            source.incarnation,
            source.activeNodeId,
          )
        }
        const mapping = await client.mapping(projectId, root, true)
        await save('requesting')
        const intent = await client.takeover(
          source.id,
          source.activeNodeId,
          operationId,
          { provider: checked.target.provider!, model: checked.target.model },
        )
        takeoverId = intent.id
        await save('waiting-for-source')
        const deadline = Date.now() + (input.waitMs ?? 180000)
        while (Date.now() < deadline) {
          const current = await client.getTakeover(intent.id)
          if (current.state === 'failed')
            throw new Error(
              current.error ?? 'Source declined the confirmed takeover',
            )
          if (current.handoffId) {
            record = await client.get(current.handoffId)
            break
          }
          await pause(200)
        }
        if (!record)
          throw new Error(
            'Source did not prepare the takeover in time; inspect its status before retrying',
          )
        await save('source-prepared')
        progress(`Handoff reference: ${record.id}`)
        progress(
          'Source agreed. Checking its current history and the local workspace…',
        )
        while (Date.now() < deadline) {
          if (record.state === 'requested') {
            const workspace = await this.preflight(
              record,
              mapping,
              checked.target,
            )
            await client.preflight(record, workspace.proof, undefined, {
              provider: checked.target.provider!,
              model: checked.target.model,
            })
            await save('preflight-passed')
          } else if (record.state === 'ready') {
            const workspace = await this.preflight(
              record,
              mapping,
              checked.target,
            )
            progress(
              'Source writer is closed. Importing its final saved history…',
            )
            await save('importing-final-history')
            const imported = await this.bridge.import({
              sourceId: record.sessionId,
              target: { ...checked.target, cwd: workspace.cwd },
              operationId: record.id,
              handoffId: record.id,
            })
            if (
              (await this.bridge.client.capabilities()).features?.includes(
                sharedFeature,
              )
            )
              await new CodexSharedSync(this.options).prepareAdoption(
                record.sessionId,
                imported.threadId,
                imported.sessionId,
              )
            record = recordSchema.parse(
              await client.mesh.request(
                `/v1/handoffs/${record.id}/codex/accept`,
                {
                  ...this.update(client, record),
                  proof: workspace.proof,
                  targetSessionId: imported.sessionId,
                },
              ),
            )
            await save('ownership-transferred')
            break
          } else if (
            ['failed', 'cancelled', 'recovery_required'].includes(record.state)
          )
            throw new Error(
              record.error ?? 'Takeover stopped; inspect its recovery state',
            )
          else if (record.state === 'completed') break
          await pause(200)
          record = await client.get(record.id)
        }
        if (record.state !== 'completed')
          throw new Error('Takeover timed out; source state needs review')
        const shared = new CodexSharedSync(this.options)
        await shared.tick()
        const result = await this.continue(client, record)
        const targetSession = await this.bridge.client.stat(
          record.targetSessionId!,
        )
        const nativeId = targetSession?.header.nativeThreadId
        if (typeof nativeId === 'string')
          await shared.confirmManagedCompletion(
            nativeId,
            result.execution?.turnId ?? 'import:' + record.id,
          )
        record = result.handoff
        await save('completed')
        return result
      } catch (error) {
        if (
          record &&
          ['requested', 'preparing', 'ready'].includes(record.state)
        ) {
          const fresh = await client.get(record.id).catch(() => undefined)
          if (
            fresh &&
            !fresh.sourceStopClaimed &&
            ['requested', 'preparing'].includes(fresh.state)
          )
            await client
              .fail(
                fresh,
                'target-preflight',
                error instanceof Error
                  ? error.message.slice(0, 1000)
                  : 'Receiver preparation failed',
              )
              .catch(() => {})
        }
        await save('needs-review').catch(() => {})
        throw error
      } finally {
        if (heartbeat) clearInterval(heartbeat)
        await client.offline().catch(() => {})
      }
    })
  }
  private async preflight(
    record: HandoffRecord,
    mapping: ProjectMapping,
    target: Target,
  ) {
    if (record.manifest.targetAgent !== 'codex')
      throw new Error('The source did not authorize a Codex takeover')
    if (record.manifest.transferId || record.manifest.workspace.contentHash)
      throw new Error(
        'This Codex takeover requires an already synchronized workspace; file transfer is not automatic',
      )
    if (
      record.manifest.sandbox.mode === 'danger-full-access' ||
      (record.manifest.sandbox.mode === 'workspace-write' &&
        target.sandbox !== 'workspace-write')
    )
      throw new Error(
        'The selected Codex permissions cannot continue this workspace task',
      )
    const workspace = await inspectWorkspace(
      mapping,
      record.manifest.workspace.relativeCwd,
      undefined,
      record.manifest.workspace.kind ?? 'git',
    )
    if (workspace.proof.commit !== record.manifest.workspace.commit)
      throw new Error('Prepare the matching Git commit on the receiver first')
    await mappedDirectory(mapping, record.manifest.sandbox.relativeRoot)
    await this.snapshot(
      record.sessionId,
      record.state === 'ready' ? 'final' : 'preflight',
    )
    return workspace
  }
  private async continue(client: HandoffClient, record: HandoffRecord) {
    if (!record.targetSessionId)
      throw new Error('The Codex target session is not linked')
    if (record.executionState === 'none')
      return { handoff: record, execution: null }
    if (record.executionState !== 'pending')
      throw new Error(
        'This continuation was already claimed; inspect or reconcile its existing result',
      )
    this.options.progress?.(
      'Ownership transferred. Codex is continuing the unfinished task…',
    )
    let claimed = record
    try {
      const execution = await this.bridge.run(
        record.targetSessionId,
        continuing(record),
        undefined,
        {
          beforeDispatch: async (handle, runOperationId) => {
            claimed = recordSchema.parse(
              await client.mesh.request(
                `/v1/handoffs/${record.id}/codex/dispatch`,
                {
                  ...this.update(client, record),
                  handleId: handle.handleId,
                  epoch: handle.epoch,
                  runOperationId,
                },
              ),
            )
          },
        },
      )
      claimed = recordSchema.parse(
        await client.mesh.request(`/v1/handoffs/${record.id}/codex/finish`, {
          ...this.update(client, claimed),
          runOperationId: claimed.executionOperationId,
          turnId: execution.turnId,
        }),
      )
      return { handoff: claimed, execution }
    } catch (error) {
      const fresh = await client.get(record.id).catch(() => undefined)
      if (fresh && ['completed', 'failed'].includes(fresh.executionState ?? ''))
        return { handoff: fresh, execution: null }
      if (fresh?.executionState === 'dispatching')
        await client.mesh
          .request(`/v1/handoffs/${fresh.id}/codex/uncertain`, {
            ...this.update(client, fresh),
            runOperationId: fresh.executionOperationId,
          })
          .catch(() => {})
      throw error
    }
  }
  async status(id: string) {
    const key = z.uuid().parse(id).toLowerCase()
    const client = await this.endpoint()
    const local = z
      .object({
        handoffId: z.uuid().optional(),
        takeoverId: z.uuid().optional(),
        phase: z.string(),
      })
      .optional()
      .parse(
        await optionalJson(
          join(this.options.stateDir, 'takeovers', key + '.json'),
        ),
      )
    if (local?.handoffId) return client.get(local.handoffId)
    if (local?.takeoverId) {
      const intent = await client.getTakeover(local.takeoverId)
      if (intent.handoffId) return client.get(intent.handoffId)
      throw new Error(
        `Takeover preparation is ${intent.state}. No ownership transfer is confirmed; inspect the source before starting another operation`,
      )
    }
    if (local)
      throw new Error(
        `Receiver operation phase: ${local.phase}; no handoff was linked`,
      )
    return client.get(key)
  }
  async recover(id: string, confirmStopped: true) {
    if (confirmStopped !== true)
      throw new Error(
        'Confirm all previous Codex execution and tools stopped first',
      )
    return this.locked(async () => {
      await this.ready()
      const client = await this.endpoint()
      let record = await client.get(z.uuid().parse(id))
      if (
        record.targetNodeId !== client.nodeId ||
        record.manifest.targetAgent !== 'codex' ||
        !record.targetSessionId ||
        record.state !== 'completed'
      )
        throw new Error(
          'This local Codex receiver can only reconcile its transferred session; source-side recovery is required before ownership transfer',
        )
      if (
        ['none', 'completed', 'failed'].includes(
          record.executionState ?? 'none',
        )
      )
        return { handoff: record, execution: null }
      const binding = await this.bridge.status(record.targetSessionId)
      const target = z
        .object({
          target: z.object({
            cwd: z.string(),
            model: z.string(),
            provider: z.string().optional(),
            sandbox: z.enum(['read-only', 'workspace-write']),
          }),
        })
        .parse(binding).target
      await client.register(
        this.options.name ?? 'Codex receiver',
        [
          {
            provider: target.provider ?? 'codex',
            model: target.model,
            name: target.model,
          },
        ],
        {
          adapter: 'codex',
          harness: '0.154.0',
          deviceId: await this.deviceId(),
        },
      )
      const heartbeat = setInterval(() => {
        void client.heartbeat().catch(() => {})
      }, 5000)
      try {
        if (record.executionState === 'pending') {
          const reconciled = await this.bridge.reconcile(
            record.targetSessionId,
            true,
          )
          if ('changed' in reconciled && reconciled.changed)
            throw new Error(
              'Unclaimed native history changed. Review its effects before starting a continuation',
            )
          await client.mesh.request(
            `/v1/sessions/${encodeURIComponent(record.targetSessionId)}/recover`,
            {
              operationId: randomUUID(),
              confirmStopped: true,
              adapter: 'codex',
            },
          )
          record = recordSchema.parse(
            await client.mesh.request(
              `/v1/handoffs/${record.id}/codex/adopt-pending`,
              { ...this.update(client, record), confirmStopped: true },
            ),
          )
          return await this.continue(client, record)
        }
        await this.bridge.reconcile(record.targetSessionId, true)
        record = recordSchema.parse(
          await client.mesh.request(`/v1/handoffs/${record.id}/codex/finish`, {
            ...this.update(client, record),
            runOperationId: record.executionOperationId,
            confirmStopped: true,
          }),
        )
        return { handoff: record, execution: null }
      } finally {
        clearInterval(heartbeat)
        await client.offline().catch(() => {})
      }
    })
  }
}
