import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { HandoffClient, type ProjectMapping } from '../../client/src/handoff.js'
import { TransferClient } from '../../client/src/transfers.js'
import { MeshError } from '../../protocol/src/index.js'
import {
  type TransferBundle,
  type TransferRecord,
} from '../../protocol/src/transfers.js'
import {
  bundleDigest,
  transferSummary,
  treeHash,
  validateBundle,
} from '../../protocol/src/transfer-hash.js'
import {
  snapshotGit,
  WorkspaceJournal,
  verifyWorkspace,
} from './workspace-files.js'
import {
  exportAttachments,
  importAttachments,
  verifyAttachments,
} from './file-attachments.js'
import { mappedDirectory, hasGitContext, relativeInside } from './workspace.js'
// The persistence and handoff bundles have separate constructor identities.
function hasMeshCode(error: unknown, codes: readonly string[]) {
  return (
    error instanceof Error &&
    error.name === 'MeshError' &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  )
}
interface Source {
  agent: Agent
  mapping: ProjectMapping
  incarnation: string
}
export class WorkspaceTransfers {
  readonly client: TransferClient
  readonly journal: WorkspaceJournal
  private plans = new Map<
    string,
    { bundle: TransferBundle; cut: number; expires: number }
  >()
  private applying = false
  private approvals = new Map<
    string,
    { id: string; root: string; digest: string; expires: number }
  >()
  constructor(
    readonly ctx: Context,
    readonly handoff: HandoffClient,
    stateDir: string,
    private readonly hooks: {
      source: (id: string) => Promise<Source>
      approved: (id: string, transferId: string) => Promise<void>
    },
  ) {
    ctx.on('agent/created', () => {
      if (this.applying)
        throw new MeshError(
          'TRANSFER_TARGET_BUSY',
          'workspace import is in progress; wait and open the conversation again',
        )
    })
    this.client = new TransferClient(handoff.mesh, handoff.nodeId)
    this.journal = new WorkspaceJournal(stateDir)
  }
  private async bundle(sessionId: string, targetNodeId: string) {
    const { agent, mapping, incarnation } = await this.hooks.source(sessionId)
    const { root } = await mappedDirectory(mapping, '')
    const nodes = await this.handoff.nodes()
    if (!nodes.some((n) => n.id === targetNodeId && n.online))
      throw new MeshError('NODE_UNAVAILABLE', 'choose an online target device')
    const workspace = (await hasGitContext(root))
      ? await snapshotGit(root)
      : { baseCommit: null, files: [], treeHash: treeHash([]) }
    const attachments = await exportAttachments(
      this.ctx,
      agent.session.snapshotEvents(),
    )
    return {
      agent,
      bundle: validateBundle({
        version: 1,
        sessionId,
        incarnation,
        projectId: mapping.projectId,
        sourceNodeId: this.handoff.nodeId,
        targetNodeId,
        ...workspace,
        attachments,
      }),
    }
  }
  async plan(sessionId: string, targetNodeId: string) {
    for (const [id, p] of this.plans)
      if (p.expires < Date.now()) this.plans.delete(id)
    if (this.plans.size >= 8)
      throw new MeshError(
        'TRANSFER_QUOTA',
        'finish or wait for existing transfer plans to expire',
      )
    const { agent, bundle } = await this.bundle(sessionId, targetNodeId),
      id = randomUUID(),
      expires = Date.now() + 60000
    this.plans.set(id, {
      bundle,
      cut: agent.session.snapshotEvents().length,
      expires,
    })
    return {
      ...transferSummary({
        id,
        bundle,
        digest: bundleDigest(bundle),
        ready: false,
        expiresAt: expires,
      }),
      planId: id,
    }
  }
  async export(planId: string) {
    const plan = this.plans.get(planId)
    if (!plan || plan.expires < Date.now())
      throw new MeshError(
        'TRANSFER_EXPIRED',
        'preview expired; inspect files again',
      )
    const { agent, bundle } = await this.bundle(
      plan.bundle.sessionId,
      plan.bundle.targetNodeId,
    )
    if (
      agent.session.snapshotEvents().length !== plan.cut ||
      bundleDigest(bundle) !== bundleDigest(plan.bundle)
    )
      throw new MeshError(
        'TRANSFER_CHANGED',
        'session or files changed after preview; inspect again',
      )
    const result = await this.client.upload(planId, bundle)
    await this.hooks.approved(bundle.sessionId, planId)
    // Keep the same plan until expiry so a lost response reuses the same operation.
    return result
  }
  sessionForPlan(id: string) {
    const plan = this.plans.get(id)
    if (!plan)
      throw new MeshError('TRANSFER_EXPIRED', 'inspect the source files again')
    return plan.bundle.sessionId
  }
  private async target(id: string, recovery = false) {
    let record: TransferRecord
    try {
      record = await this.client.get(id)
    } catch (error) {
      if (!recovery || !hasMeshCode(error, ['TRANSFER_EXPIRED', 'NOT_FOUND']))
        throw error
      const journal = await this.journal.read(id)
      if (!journal) throw error
      const session = (await this.handoff.sessions()).find(
        (s) => s.id === journal.bundle.sessionId,
      )
      if (session?.handoffId)
        throw new MeshError(
          'HANDOFF_IN_PROGRESS',
          'finish the active handoff before workspace recovery',
        )
      record = {
        id,
        digest: journal.digest,
        bundle: journal.bundle,
        ready: false,
        expiresAt: 0,
      }
    }
    validateBundle(record.bundle)
    if (record.bundle.targetNodeId !== this.handoff.nodeId)
      throw new MeshError('WRONG_DEVICE', 'apply files on the target device')
    const mapping = (await this.handoff.mappings()).find(
      (m) => m.projectId === record.bundle.projectId,
    )
    if (!mapping)
      throw new MeshError(
        'PROJECT_REQUIRED',
        'map this project to a directory on the target first',
      )
    const { root } = await mappedDirectory(mapping, '')
    if (
      this.ctx.agents.list().some((agent) => {
        try {
          relativeInside(root, this.ctx.workingDirectory.get(agent.session))
          return true
        } catch {
          return false
        }
      })
    )
      throw new MeshError(
        'TRANSFER_TARGET_BUSY',
        'close local conversations using this directory before applying or rolling back',
      )
    return { record, root }
  }
  async preview(id: string) {
    const { record, root } = await this.target(id),
      journal = await this.journal.read(id)
    if (journal?.phase === 'prepared')
      return { ...transferSummary(record), root, recoveryRequired: true }
    await verifyWorkspace(
      root,
      record.bundle,
      journal?.phase === 'applied' ? 'applied' : 'base',
    )
    for (const [id, a] of this.approvals)
      if (a.expires < Date.now()) this.approvals.delete(id)
    const previewId = randomUUID()
    this.approvals.set(previewId, {
      id,
      root,
      digest: record.digest,
      expires: Date.now() + 60000,
    })
    return {
      ...transferSummary(record),
      root,
      recoveryRequired: false,
      previewId,
    }
  }
  async apply(id: string, previewId: string) {
    if (this.applying)
      throw new MeshError(
        'HANDOFF_IN_PROGRESS',
        'another local workspace import is in progress',
      )
    this.applying = true
    try {
      const { record, root } = await this.target(id)
      const approval = this.approvals.get(previewId)
      if (
        !approval ||
        approval.id !== id ||
        approval.root !== root ||
        approval.digest !== record.digest ||
        approval.expires < Date.now()
      )
        throw new MeshError(
          'TRANSFER_CHANGED',
          'target preview expired or directory changed; inspect and confirm again',
        )
      const journal = await this.journal.read(id)
      if (journal?.phase === 'prepared')
        throw new MeshError(
          'TRANSFER_RECOVERY_REQUIRED',
          'roll back the interrupted import first',
        )
      await verifyWorkspace(
        root,
        record.bundle,
        journal?.phase === 'applied' ? 'applied' : 'base',
      )
      await importAttachments(this.ctx, record.bundle.attachments)
      await this.journal.apply(id, root, record.bundle)
      await this.hooks.approved(record.bundle.sessionId, id)
      await this.client.receipt(record)
      return { ...transferSummary({ ...record, ready: true }), root }
    } finally {
      this.applying = false
    }
  }
  async rollback(id: string) {
    if (this.applying)
      throw new MeshError(
        'HANDOFF_IN_PROGRESS',
        'another workspace operation is in progress',
      )
    this.applying = true
    try {
      const { record, root } = await this.target(id, true)
      // Remove readiness before touching files; an active handoff rejects this change.
      await this.client.receipt(record, false).catch((error) => {
        if (!hasMeshCode(error, ['TRANSFER_EXPIRED', 'NOT_FOUND'])) throw error
      })
      await this.journal.rollback(id, root)
      return { rolledBack: true }
    } finally {
      this.applying = false
    }
  }
  async approved(
    id: string,
    sessionId: string,
    projectId: string,
    targetNodeId?: string,
  ): Promise<TransferRecord> {
    const record = await this.client.get(id),
      b = record.bundle
    if (
      !record.ready ||
      b.sessionId !== sessionId ||
      b.projectId !== projectId ||
      (targetNodeId && b.targetNodeId !== targetNodeId)
    )
      throw new MeshError(
        'TRANSFER_NOT_READY',
        'target must inspect and apply this transfer before handoff',
      )
    const snapshot = await this.handoff.mesh.stat(sessionId)
    if (snapshot?.incarnation !== b.incarnation)
      throw new MeshError('TRANSFER_CHANGED', 'session incarnation changed')
    return record
  }
  async verifySource(record: TransferRecord, agent: Agent) {
    await verifyAttachments(
      this.ctx,
      agent.session.snapshotEvents(),
      record.bundle,
    )
  }
  async verifyTarget(record: TransferRecord, events: unknown) {
    await verifyAttachments(this.ctx, events, record.bundle)
  }
}
