import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { TransferPostgresStore } from './transfers.js'
import { MeshError } from '../../protocol/src/index.js'
import {
  modelRoute,
  takeoverRecord,
  type TakeoverRecord,
  handoffManifest,
  handoffState,
  type HandoffRecord,
  type HandoffManifest,
} from '../../protocol/src/handoff.js'
export type { StoreOptions } from './base.js'

interface Identity {
  nodeId: string
  instanceId: string
}
interface Update extends Identity {
  operationId: string
  revision: number
}
interface HandoffRow {
  id: string
  session_id: string
  incarnation: string
  source_node: string
  source_instance: string
  source_handle: string
  source_epoch: string
  target_node: string
  target_instance: string
  state: string
  revision: string
  manifest: string
  proof: string | null
  final_seq: string | null
  final_generation: string | null
  target_handle: string | null
  error: string | null
}
const active = [
  'requested',
  'preparing',
  'ready',
  'activating',
  'recovery_required',
]

export class PostgresStore extends TransferPostgresStore {
  private record(r: HandoffRow): HandoffRecord {
    return {
      id: r.id,
      sessionId: r.session_id,
      incarnation: r.incarnation,
      sourceNodeId: r.source_node,
      sourceInstanceId: r.source_instance,
      targetNodeId: r.target_node,
      targetInstanceId: r.target_instance,
      state: handoffState.parse(r.state),
      revision: Number(r.revision),
      manifest: handoffManifest.parse(this.decode(r.manifest)),
      finalNextSeq: r.final_seq === null ? null : Number(r.final_seq),
      finalGeneration:
        r.final_generation === null ? null : Number(r.final_generation),
      targetHandleId: r.target_handle,
      error: r.error,
    }
  }
  private async node(db: PoolClient, ns: string, identity: Identity) {
    const r = (
      await db.query(
        "SELECT *, last_seen > clock_timestamp()-($3::double precision * interval '1 millisecond') AS online FROM cm_nodes WHERE namespace=$1 AND id=$2",
        [ns, identity.nodeId, this.nodeTimeoutMs],
      )
    ).rows[0]
    if (!r || !r.online || r.instance_id !== identity.instanceId)
      throw new MeshError(
        'NODE_UNAVAILABLE',
        'device instance is offline or changed',
      )
    return r
  }
  private async locked(db: PoolClient, ns: string, id: string) {
    const ref = (
      await db.query<HandoffRow>(
        'SELECT * FROM cm_handoffs WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
    ).rows[0]
    if (!ref) throw new MeshError('NOT_FOUND', 'handoff not found', 404)
    const session = await this.session(db, ns, ref.session_id)
    const row = (
      await db.query<HandoffRow>(
        'SELECT * FROM cm_handoffs WHERE namespace=$1 AND id=$2 FOR UPDATE',
        [ns, id],
      )
    ).rows[0]!
    return { row, session }
  }
  private check(
    row: HandoffRow,
    request: Update,
    role: 'source' | 'target',
    states: string[],
  ) {
    if (Number(row.revision) !== request.revision)
      throw new MeshError(
        'REVISION_CONFLICT',
        'handoff changed; refresh its state',
      )
    if (
      row[role === 'source' ? 'source_node' : 'target_node'] !==
        request.nodeId ||
      row[role === 'source' ? 'source_instance' : 'target_instance'] !==
        request.instanceId
    )
      throw new MeshError(
        'WRONG_DEVICE',
        'this device instance cannot perform this transition',
        403,
      )
    if (!states.includes(row.state))
      throw new MeshError(
        'HANDOFF_STATE',
        'transition is invalid for current handoff state',
      )
  }
  private async transition(
    db: PoolClient,
    ns: string,
    id: string,
    state: string,
  ) {
    const row = (
      await db.query<HandoffRow>(
        'UPDATE cm_handoffs SET state=$3,revision=revision+1,updated_at=clock_timestamp() WHERE namespace=$1 AND id=$2 RETURNING *',
        [ns, id, state],
      )
    ).rows[0]!
    return this.record(row)
  }
  async registerNode(
    ns: string,
    r: Identity & { operationId: string; name: string; capabilities: unknown },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['register-node', r],
      async (db) => {
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${ns}:node:${r.nodeId}`,
        ])
        const prior = (
          await db.query(
            "SELECT *,last_seen > clock_timestamp()-($3::double precision * interval '1 millisecond') AS online FROM cm_nodes WHERE namespace=$1 AND id=$2",
            [ns, r.nodeId, this.nodeTimeoutMs],
          )
        ).rows[0]
        if (prior?.online && prior.instance_id !== r.instanceId)
          throw new MeshError(
            'NODE_CONFLICT',
            'device id is already online in another process',
          )
        await db.query(
          'INSERT INTO cm_nodes(namespace,id,instance_id,name,capabilities) VALUES($1,$2,$3,$4,$5) ON CONFLICT(namespace,id) DO UPDATE SET instance_id=$3,name=$4,capabilities=$5,last_seen=clock_timestamp()',
          [ns, r.nodeId, r.instanceId, r.name, JSON.stringify(r.capabilities)],
        )
        return { registered: true }
      },
    )
  }
  async heartbeatNode(ns: string, r: Identity) {
    const result = await this.pool.query(
      'UPDATE cm_nodes SET last_seen=clock_timestamp() WHERE namespace=$1 AND id=$2 AND instance_id=$3 RETURNING id',
      [ns, r.nodeId, r.instanceId],
    )
    if (!result.rowCount)
      throw new MeshError(
        'NODE_CONFLICT',
        'device registration is no longer current',
      )
    return { online: true }
  }
  async offlineNode(ns: string, r: Identity) {
    await this.pool.query(
      "UPDATE cm_nodes SET last_seen='epoch'::timestamptz WHERE namespace=$1 AND id=$2 AND instance_id=$3",
      [ns, r.nodeId, r.instanceId],
    )
    return { online: false }
  }
  async listNodes(ns: string) {
    return (
      await this.pool.query(
        'SELECT id,name,capabilities,instance_id AS "instanceId",last_seen AS "lastSeen",last_seen > clock_timestamp()-($2::double precision * interval \'1 millisecond\') AS online FROM cm_nodes WHERE namespace=$1 ORDER BY name,id LIMIT 100',
        [ns, this.nodeTimeoutMs],
      )
    ).rows.map((row) => ({
      ...row,
      capabilities: undefined,
      models: JSON.parse(row.capabilities).models ?? [],
    }))
  }
  async registerProject(
    ns: string,
    r: { operationId: string; projectId: string; name: string },
  ) {
    return this.operation(ns, r.operationId, ['project', r], async (db) => {
      await db.query(
        'INSERT INTO cm_projects(namespace,id,name) VALUES($1,$2,$3) ON CONFLICT(namespace,id) DO UPDATE SET name=$3',
        [ns, r.projectId, r.name],
      )
      return { projectId: r.projectId, name: r.name }
    })
  }
  async listProjects(ns: string) {
    return (
      await this.pool.query(
        'SELECT id,name FROM cm_projects WHERE namespace=$1 ORDER BY name,id LIMIT 100',
        [ns],
      )
    ).rows
  }
  async setMapping(
    ns: string,
    r: {
      operationId: string
      projectId: string
      nodeId: string
      root: string
      ifAbsent?: boolean
    },
  ) {
    return this.operation(ns, r.operationId, ['mapping', r], async (db) => {
      const exists = (
        await db.query(
          'SELECT id FROM cm_projects WHERE namespace=$1 AND id=$2',
          [ns, r.projectId],
        )
      ).rowCount
      if (
        !exists ||
        !(
          await db.query(
            'SELECT id FROM cm_nodes WHERE namespace=$1 AND id=$2',
            [ns, r.nodeId],
          )
        ).rowCount
      )
        throw new MeshError(
          'NOT_FOUND',
          'register the project and device first',
          404,
        )
      if (r.ifAbsent) {
        await db.query(
          'INSERT INTO cm_project_mappings(namespace,project_id,node_id,root) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,project_id,node_id) DO NOTHING',
          [ns, r.projectId, r.nodeId, r.root],
        )
        const existing = (
          await db.query(
            'SELECT project_id AS "projectId",node_id AS "nodeId",root,revision::int FROM cm_project_mappings WHERE namespace=$1 AND project_id=$2 AND node_id=$3',
            [ns, r.projectId, r.nodeId],
          )
        ).rows[0]!
        if (existing.root !== r.root)
          throw new MeshError(
            'PROJECT_DIRECTORY_CONFLICT',
            'this project already has another directory on the device',
          )
        return existing
      }
      return (
        await db.query(
          'INSERT INTO cm_project_mappings(namespace,project_id,node_id,root) VALUES($1,$2,$3,$4) ON CONFLICT(namespace,project_id,node_id) DO UPDATE SET root=$4,revision=cm_project_mappings.revision+1 RETURNING project_id AS "projectId",node_id AS "nodeId",root,revision::int',
          [ns, r.projectId, r.nodeId, r.root],
        )
      ).rows[0]
    })
  }
  async mappings(ns: string, nodeId: string) {
    return (
      await this.pool.query(
        'SELECT m.project_id AS "projectId",m.node_id AS "nodeId",p.name,m.root,m.revision::int FROM cm_project_mappings m JOIN cm_projects p ON p.namespace=m.namespace AND p.id=m.project_id WHERE m.namespace=$1 AND m.node_id=$2 ORDER BY p.name LIMIT 100',
        [ns, nodeId],
      )
    ).rows
  }
  async requestHandoff(
    ns: string,
    id: string,
    r: {
      operationId: string
      takeoverId?: string
      sourceNodeId: string
      sourceInstanceId: string
      targetNodeId: string
      sourceHandleId: string
      sourceEpoch: number
      manifest: HandoffManifest
    },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-request', id, r],
      async (db) => {
        const s = await this.session(db, ns, id)
        if (!s.materialized)
          throw new MeshError('NOT_READY', 'flush the source session first')
        if (s.active_model_relay)
          throw new MeshError(
            'MODEL_RELAY_BUSY',
            'settle the pending model switch first',
          )
        if (s.active_handoff)
          throw new MeshError(
            'HANDOFF_IN_PROGRESS',
            'session already has an unfinished handoff',
          )
        if (r.sourceNodeId === r.targetNodeId)
          throw new MeshError(
            'INVALID_ARGUMENT',
            'source and target must differ',
            400,
          )
        const sourceNode = await this.node(db, ns, {
          nodeId: r.sourceNodeId,
          instanceId: r.sourceInstanceId,
        })
        const target = (
          await db.query(
            'SELECT instance_id FROM cm_nodes WHERE namespace=$1 AND id=$2',
            [ns, r.targetNodeId],
          )
        ).rows[0]
        if (!target)
          throw new MeshError(
            'NODE_UNAVAILABLE',
            'target device is not registered',
          )
        const targetNode = await this.node(db, ns, {
          nodeId: r.targetNodeId,
          instanceId: target.instance_id,
        })
        if (
          r.manifest.workspace.kind === 'directory' &&
          [sourceNode, targetNode].some(
            (node) =>
              JSON.parse(node.capabilities).directoryHandoffVersion !== 1,
          )
        )
          throw new MeshError(
            'DIRECTORY_HANDOFF_UNSUPPORTED',
            'update the same plugin on both devices before taking over a plain-directory conversation',
          )

        if (
          r.manifest.targetModel &&
          [sourceNode, targetNode].some(
            (node) => JSON.parse(node.capabilities).modelRelayVersion !== 1,
          )
        )
          throw new MeshError(
            'MODEL_RELAY_UNSUPPORTED',
            'update both devices before changing models during handoff',
          )
        if (r.manifest.workspace.contentHash && !r.manifest.transferId)
          throw new MeshError(
            'TRANSFER_NOT_READY',
            'a workspace digest requires a confirmed transfer',
          )
        if (r.manifest.transferId) {
          if (
            [sourceNode, targetNode].some(
              (n) => JSON.parse(n.capabilities).workspaceTransferVersion !== 1,
            )
          )
            throw new MeshError(
              'WORKSPACE_TRANSFER_UNSUPPORTED',
              'update both devices before transferring files',
            )
          const transfer = await this.loadTransfer(
              db,
              ns,
              r.manifest.transferId,
            ),
            b = transfer.bundle
          if (
            !transfer.ready ||
            b.sessionId !== id ||
            b.incarnation !== s.incarnation ||
            b.projectId !== r.manifest.workspace.projectId ||
            b.sourceNodeId !== r.sourceNodeId ||
            b.targetNodeId !== r.targetNodeId ||
            b.baseCommit !== r.manifest.workspace.commit ||
            (b.baseCommit !== null &&
              b.treeHash !== r.manifest.workspace.contentHash)
          )
            throw new MeshError(
              'TRANSFER_NOT_READY',
              'handoff does not match the applied workspace transfer',
            )
        }
        const h = (
          await db.query(
            'SELECT * FROM cm_handles WHERE namespace=$1 AND id=$2',
            [ns, r.sourceHandleId],
          )
        ).rows[0]
        if (
          !h ||
          h.closed ||
          h.instance_id !== r.sourceInstanceId ||
          s.active_handle !== h.id ||
          Number(s.epoch) !== r.sourceEpoch ||
          Number(h.epoch) !== r.sourceEpoch ||
          !s.lease_valid ||
          s.recovery_required
        )
          throw new MeshError(
            'OWNERSHIP_LOST',
            'source is not the current valid writer',
          )
        const mapping = (
          await db.query(
            'SELECT revision FROM cm_project_mappings WHERE namespace=$1 AND project_id=$2 AND node_id=$3',
            [ns, r.manifest.workspace.projectId, r.sourceNodeId],
          )
        ).rows[0]
        if (
          !mapping ||
          Number(mapping.revision) !== r.manifest.workspace.mappingRevision
        )
          throw new MeshError('WORKSPACE_MISMATCH', 'source mapping changed')
        if (r.takeoverId) {
          const intent = (
            await db.query(
              'SELECT * FROM cm_takeovers WHERE namespace=$1 AND id=$2 FOR UPDATE',
              [ns, r.takeoverId],
            )
          ).rows[0]
          if (
            !intent ||
            intent.state !== 'requested' ||
            new Date(intent.expires_at).getTime() <= Date.now() ||
            intent.session_id !== id ||
            intent.incarnation !== s.incarnation ||
            intent.source_node !== r.sourceNodeId ||
            intent.source_instance !== r.sourceInstanceId ||
            intent.source_handle !== r.sourceHandleId ||
            Number(intent.source_epoch) !== r.sourceEpoch ||
            intent.target_node !== r.targetNodeId ||
            intent.target_instance !== target.instance_id ||
            intent.handoff_operation !== r.operationId ||
            JSON.stringify(
              intent.target_model ? JSON.parse(intent.target_model) : undefined,
            ) !== JSON.stringify(r.manifest.targetModel)
          )
            throw new MeshError(
              'TAKEOVER_CHANGED',
              'takeover expired or its device ownership changed',
            )
        }
        const handoffId = randomUUID()
        const row = (
          await db.query<HandoffRow>(
            'INSERT INTO cm_handoffs(namespace,id,session_id,incarnation,source_node,source_instance,source_handle,source_epoch,target_node,target_instance,manifest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [
              ns,
              handoffId,
              id,
              s.incarnation,
              r.sourceNodeId,
              r.sourceInstanceId,
              r.sourceHandleId,
              r.sourceEpoch,
              r.targetNodeId,
              target.instance_id,
              JSON.stringify(r.manifest),
            ],
          )
        ).rows[0]!
        await db.query(
          'UPDATE cm_sessions SET active_handoff=$3 WHERE namespace=$1 AND id=$2',
          [ns, id, handoffId],
        )
        if (r.takeoverId)
          await db.query(
            "UPDATE cm_takeovers SET state='linked',handoff_id=$3 WHERE namespace=$1 AND id=$2",
            [ns, r.takeoverId, handoffId],
          )
        return this.record(row)
      },
    )
  }
  async preflightHandoff(
    ns: string,
    id: string,
    r: Update & { proof: HandoffManifest['workspace'] },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-preflight', id, r],
      async (db) => {
        const { row } = await this.locked(db, ns, id)
        this.check(row, r, 'target', ['requested'])
        await this.node(db, ns, r)
        const expected = this.record(row).manifest.workspace
        const mapping = (
          await db.query(
            'SELECT revision FROM cm_project_mappings WHERE namespace=$1 AND project_id=$2 AND node_id=$3',
            [ns, r.proof.projectId, r.nodeId],
          )
        ).rows[0]
        if (
          r.proof.projectId !== expected.projectId ||
          r.proof.contentHash !== expected.contentHash ||
          r.proof.commit !== expected.commit ||
          (r.proof.kind ?? 'git') !== (expected.kind ?? 'git') ||
          r.proof.relativeCwd !== expected.relativeCwd ||
          !mapping ||
          Number(mapping.revision) !== r.proof.mappingRevision
        )
          throw new MeshError(
            'WORKSPACE_MISMATCH',
            'target project, commit, directory or mapping does not match',
          )
        await db.query(
          'UPDATE cm_handoffs SET proof=$3 WHERE namespace=$1 AND id=$2',
          [ns, id, JSON.stringify(r.proof)],
        )
        return this.transition(db, ns, id, 'preparing')
      },
    )
  }
  async finalizeHandoff(ns: string, id: string, r: Update) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-finalize', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        this.check(row, r, 'source', ['preparing'])
        await this.node(db, ns, r)
        const h = (
          await db.query(
            'SELECT closed,close_failed FROM cm_handles WHERE namespace=$1 AND id=$2',
            [ns, row.source_handle],
          )
        ).rows[0]
        if (
          !h?.closed ||
          h.close_failed ||
          s.active_handle ||
          s.recovery_required ||
          s.incarnation !== row.incarnation ||
          s.active_handoff !== id
        )
          throw new MeshError(
            'CLOSE_UNCONFIRMED',
            'successful source close must be confirmed first',
          )
        await db.query(
          'UPDATE cm_handoffs SET final_seq=$3,final_generation=$4 WHERE namespace=$1 AND id=$2',
          [ns, id, s.next_seq, s.generation],
        )
        return this.transition(db, ns, id, 'ready')
      },
    )
  }
  async acceptHandoff(
    ns: string,
    id: string,
    r: Update & { proof: HandoffManifest['workspace'] },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-accept', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        this.check(row, r, 'target', ['ready'])
        await this.node(db, ns, r)
        const proof = row.proof ? this.decode(row.proof) : null
        if (JSON.stringify(proof) !== JSON.stringify(r.proof))
          throw new MeshError(
            'WORKSPACE_MISMATCH',
            'target preflight must still match',
          )
        const mapping = (
          await db.query(
            'SELECT revision FROM cm_project_mappings WHERE namespace=$1 AND project_id=$2 AND node_id=$3',
            [ns, r.proof.projectId, r.nodeId],
          )
        ).rows[0]
        if (!mapping || Number(mapping.revision) !== r.proof.mappingRevision)
          throw new MeshError('WORKSPACE_MISMATCH', 'target mapping changed')
        if (
          s.active_handle ||
          s.recovery_required ||
          s.incarnation !== row.incarnation ||
          s.active_handoff !== id ||
          s.next_seq !== row.final_seq ||
          s.generation !== row.final_generation
        )
          throw new MeshError(
            'OWNERSHIP_LOST',
            'final log or ownership no longer matches the handoff',
          )
        const handle = await this.makeHandle(
          db,
          ns,
          s,
          r.instanceId,
          'write',
          Number(s.epoch) + 1,
        )
        await db.query(
          'UPDATE cm_handoffs SET target_handle=$3 WHERE namespace=$1 AND id=$2',
          [ns, id, handle.handleId],
        )
        return {
          handoff: await this.transition(db, ns, id, 'activating'),
          handle,
        }
      },
    )
  }
  async completeHandoff(
    ns: string,
    id: string,
    r: Update & { nextSeq: number },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-complete', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        this.check(row, r, 'target', ['activating'])
        await this.node(db, ns, r)
        if (
          s.active_handoff !== id ||
          s.active_handle !== row.target_handle ||
          !s.lease_valid ||
          s.recovery_required ||
          r.nextSeq > Number(s.next_seq) ||
          r.nextSeq < Number(row.final_seq)
        )
          throw new MeshError(
            'OWNERSHIP_LOST',
            'target initialization or current writer is not confirmed',
          )
        const targetModel = handoffManifest.parse(
          this.decode(row.manifest),
        ).targetModel
        if (targetModel) {
          const events = (
            await db.query(
              'SELECT event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND seq >= $3 AND seq < $4 ORDER BY seq',
              [ns, s.id, row.final_seq, r.nextSeq],
            )
          ).rows.map((e) =>
            z
              .object({ type: z.string(), data: z.unknown() })
              .parse(this.decode(e.event)),
          )
          const last = events.filter((e) => e.type === 'model/selection').at(-1)
          if (
            !last ||
            JSON.stringify(modelRoute.parse(last.data)) !==
              JSON.stringify(targetModel) ||
            events.some((e) => e.type === 'request/header')
          )
            throw new MeshError(
              'MODEL_RELAY_UNCONFIRMED',
              'target model must be saved before activation completes',
            )
        }
        await db.query(
          'UPDATE cm_sessions SET active_handoff=NULL WHERE namespace=$1 AND id=$2',
          [ns, s.id],
        )
        return this.transition(db, ns, id, 'completed')
      },
    )
  }
  async cancelHandoff(ns: string, id: string, r: Update) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-cancel', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        this.check(row, r, 'source', ['requested', 'preparing', 'ready'])
        await this.node(db, ns, r)
        if (
          s.recovery_required ||
          (row.state !== 'ready' &&
            (s.active_handle !== row.source_handle || !s.lease_valid))
        )
          throw new MeshError(
            'CLOSE_UNCONFIRMED',
            'source status is uncertain; explicit recovery is required',
          )
        if (row.state === 'ready' && s.active_handle)
          throw new MeshError(
            'ALREADY_OWNED',
            'target already claimed the session',
          )
        await db.query(
          'UPDATE cm_sessions SET active_handoff=NULL WHERE namespace=$1 AND id=$2',
          [ns, s.id],
        )
        return this.transition(db, ns, id, 'cancelled')
      },
    )
  }
  async failHandoff(
    ns: string,
    id: string,
    r: Update & { phase: string; message: string; confirmClosed: boolean },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-fail', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        const role = row.source_node === r.nodeId ? 'source' : 'target'
        this.check(row, r, role, [
          'requested',
          'preparing',
          'ready',
          'activating',
        ])
        await this.node(db, ns, r)
        let safe = false
        if (['requested', 'preparing'].includes(row.state))
          safe =
            ['source-preflight', 'target-preflight'].includes(r.phase) &&
            s.active_handle === row.source_handle &&
            s.lease_valid &&
            !s.recovery_required
        else if (row.state === 'ready')
          safe = !s.active_handle && !s.recovery_required
        else if (r.confirmClosed && row.target_handle) {
          const h = (
            await db.query(
              'SELECT closed,close_failed FROM cm_handles WHERE namespace=$1 AND id=$2',
              [ns, row.target_handle],
            )
          ).rows[0]
          safe = Boolean(
            h?.closed &&
            !h.close_failed &&
            !s.active_handle &&
            !s.recovery_required,
          )
        }
        await db.query(
          'UPDATE cm_handoffs SET error=$3 WHERE namespace=$1 AND id=$2',
          [ns, id, `${r.phase}: ${r.message}`],
        )
        if (safe)
          await db.query(
            'UPDATE cm_sessions SET active_handoff=NULL WHERE namespace=$1 AND id=$2',
            [ns, s.id],
          )
        return this.transition(
          db,
          ns,
          id,
          safe ? 'failed' : 'recovery_required',
        )
      },
    )
  }
  async recoverHandoff(
    ns: string,
    id: string,
    r: { operationId: string; revision: number; confirmStopped: true },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['handoff-recover', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        if (Number(row.revision) !== r.revision || !active.includes(row.state))
          throw new MeshError(
            'HANDOFF_STATE',
            'refresh the active handoff before recovery',
          )
        if (s.active_handle && s.lease_valid)
          throw new MeshError(
            'ALREADY_OWNED',
            'stop the active writer before recovery',
          )
        await db.query(
          "UPDATE cm_handles SET closed=true WHERE namespace=$1 AND session_id=$2 AND access='write'",
          [ns, s.id],
        )
        await db.query(
          'UPDATE cm_sessions SET active_handle=NULL,active_handoff=NULL,lease_until=NULL,recovery_required=false,epoch=epoch+1 WHERE namespace=$1 AND id=$2',
          [ns, s.id],
        )
        await db.query(
          "UPDATE cm_handoffs SET error='explicit recovery after confirming all previous execution stopped' WHERE namespace=$1 AND id=$2",
          [ns, id],
        )
        return this.transition(db, ns, id, 'failed')
      },
    )
  }
  async getHandoff(ns: string, id: string) {
    const row = (
      await this.pool.query<HandoffRow>(
        'SELECT * FROM cm_handoffs WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
    ).rows[0]
    if (!row) throw new MeshError('NOT_FOUND', 'handoff not found', 404)
    return this.record(row)
  }
  async nodeCommands(ns: string, identity: Identity) {
    return this.tx(async (db) => {
      await this.node(db, ns, identity)
      const rows = (
        await db.query<HandoffRow>(
          `SELECT * FROM cm_handoffs WHERE namespace=$1 AND ((source_node=$2 OR target_node=$2) AND (state IN ('completed','cancelled','failed') OR source_instance=$3 OR target_instance=$3)) ORDER BY updated_at DESC LIMIT 100`,
          [ns, identity.nodeId, identity.instanceId],
        )
      ).rows
      return rows.map((row) => this.record(row))
    })
  }
  async updateSummary(
    ns: string,
    id: string,
    r: {
      operationId: string
      instanceId: string
      incarnation: string
      nextSeq: number
      title: string
      projectId: string
      nodeId: string
      lastActivity: number
    },
  ) {
    return this.operation(ns, r.operationId, ['summary', id, r], async (db) => {
      const s = await this.session(db, ns, id)
      await this.node(db, ns, r)
      if (
        s.incarnation !== r.incarnation ||
        r.nextSeq > Number(s.next_seq) ||
        !s.materialized
      )
        throw new MeshError(
          'STALE_SUMMARY',
          'summary does not match durable session data',
        )
      await db.query(
        'INSERT INTO cm_session_summaries(namespace,session_id,incarnation,next_seq,title,project_id,node_id,last_activity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(namespace,session_id) DO UPDATE SET incarnation=$3,next_seq=$4,title=$5,project_id=$6,node_id=$7,last_activity=$8 WHERE cm_session_summaries.incarnation<>$3 OR cm_session_summaries.next_seq<=$4',
        [
          ns,
          id,
          r.incarnation,
          r.nextSeq,
          r.title,
          r.projectId,
          r.nodeId,
          r.lastActivity,
        ],
      )
      return { updated: true }
    })
  }
  async assignProject(
    ns: string,
    id: string,
    r: Identity & {
      operationId: string
      incarnation: string
      expectedSourceNodeId: string
      projectId: string
    },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['assign-project', id, r],
      async (db) => {
        const session = await this.session(db, ns, id)
        await this.node(db, ns, r)
        if (
          session.incarnation !== r.incarnation ||
          !session.materialized ||
          !session.active_handle ||
          !session.lease_valid ||
          session.recovery_required
        )
          throw new MeshError(
            'TAKEOVER_CHANGED',
            'the session or its owner changed during project setup',
          )
        if (session.active_handoff)
          throw new MeshError(
            'HANDOFF_IN_PROGRESS',
            'cannot change the project during handoff',
          )
        const source = (
          await db.query(
            'SELECT n.id,n.instance_id,n.capabilities FROM cm_handles h JOIN cm_nodes n ON n.namespace=h.namespace AND n.instance_id=h.instance_id WHERE h.namespace=$1 AND h.id=$2 AND NOT h.closed',
            [ns, session.active_handle],
          )
        ).rows[0]
        if (!source || source.id !== r.expectedSourceNodeId)
          throw new MeshError(
            'TAKEOVER_CHANGED',
            'the source device changed during project setup',
          )
        await this.node(db, ns, {
          nodeId: source.id,
          instanceId: source.instance_id,
        })
        if (JSON.parse(source.capabilities).projectSetupVersion !== 1)
          throw new MeshError(
            'PROJECT_SETUP_UNSUPPORTED',
            'update the same plugin on the source device before configuring this session',
          )
        const mapped = (
          await db.query(
            'SELECT 1 FROM cm_project_mappings WHERE namespace=$1 AND node_id=$2 AND project_id=$3',
            [ns, r.nodeId, r.projectId],
          )
        ).rowCount
        if (!mapped)
          throw new MeshError(
            'PROJECT_DIRECTORY_REQUIRED',
            'choose the local project directory first',
          )
        const current = (
          await db.query(
            'SELECT * FROM cm_session_summaries WHERE namespace=$1 AND session_id=$2',
            [ns, id],
          )
        ).rows[0]
        if (
          current?.incarnation === session.incarnation &&
          current.project_id !== r.projectId
        )
          throw new MeshError(
            'PROJECT_CHANGED',
            'this session is already assigned to a different project',
          )
        await db.query(
          'INSERT INTO cm_session_summaries(namespace,session_id,incarnation,next_seq,title,project_id,node_id,last_activity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(namespace,session_id) DO UPDATE SET incarnation=$3,next_seq=$4,project_id=$6,node_id=$7',
          [
            ns,
            id,
            session.incarnation,
            session.next_seq,
            current?.incarnation === session.incarnation ? current.title : id,
            r.projectId,
            source.id,
            current?.incarnation === session.incarnation
              ? current.last_activity
              : 0,
          ],
        )
        return { projectId: r.projectId }
      },
    )
  }
  async listSummaries(ns: string) {
    return (
      await this.pool.query(
        `SELECT s.id,s.incarnation,s.next_seq::int AS "nextSeq",m.title,m.project_id AS "projectId",m.last_activity::float8 AS "lastActivity",n.id AS "activeNodeId",n.name AS "activeNodeName",s.active_handoff AS "handoffId",h.state AS "handoffState",(s.recovery_required OR COALESCE(h.state='recovery_required',false) OR (s.active_handle IS NOT NULL AND COALESCE(s.lease_until<=clock_timestamp(),true))) AS "recoveryRequired" FROM cm_sessions s LEFT JOIN cm_session_summaries m ON m.namespace=s.namespace AND m.session_id=s.id AND m.incarnation=s.incarnation LEFT JOIN cm_handles w ON w.namespace=s.namespace AND w.id=s.active_handle LEFT JOIN cm_nodes n ON n.namespace=s.namespace AND n.instance_id=w.instance_id LEFT JOIN cm_handoffs h ON h.namespace=s.namespace AND h.id=s.active_handoff WHERE s.namespace=$1 AND s.materialized ORDER BY COALESCE(m.last_activity,0) DESC,s.id LIMIT 100`,
        [ns],
      )
    ).rows
  }

  private takeover(row: Record<string, unknown>): TakeoverRecord {
    return takeoverRecord.parse({
      id: row.id,
      sessionId: row.session_id,
      incarnation: row.incarnation,
      sourceNodeId: row.source_node,
      sourceInstanceId: row.source_instance,
      sourceHandleId: row.source_handle,
      sourceEpoch: Number(row.source_epoch),
      targetNodeId: row.target_node,
      targetInstanceId: row.target_instance,
      handoffOperationId: row.handoff_operation,
      state: row.state,
      handoffId: row.handoff_id,
      errorCode: row.error_code,
      error: row.error,
      expiresAt: new Date(String(row.expires_at)).getTime(),
      ...(row.target_model
        ? { targetModel: JSON.parse(String(row.target_model)) }
        : {}),
    })
  }
  private async expireTakeovers(db: Pick<PoolClient, 'query'>, ns: string) {
    await db.query(
      "UPDATE cm_takeovers SET state='failed',error_code='TAKEOVER_EXPIRED',error='takeover request expired before the source agreed' WHERE namespace=$1 AND state='requested' AND expires_at<=clock_timestamp()",
      [ns],
    )
  }
  async requestTakeover(
    ns: string,
    id: string,
    request: Identity & {
      operationId: string
      expectedSourceNodeId: string
      confirmed: true
      targetModel?: HandoffManifest['model']
    },
  ) {
    return this.operation(
      ns,
      request.operationId,
      ['takeover', id, request],
      async (db) => {
        const session = await this.session(db, ns, id)
        await this.node(db, ns, request)
        if (
          !session.materialized ||
          session.recovery_required ||
          !session.lease_valid ||
          !session.active_handle
        )
          throw new MeshError(
            'TAKEOVER_UNAVAILABLE',
            'cannot confirm a live source writer; explicit recovery may be required',
          )
        if (session.active_model_relay)
          throw new MeshError(
            'MODEL_RELAY_BUSY',
            'settle the pending model switch first',
          )
        if (session.active_handoff)
          throw new MeshError(
            'HANDOFF_IN_PROGRESS',
            'another handoff is already in progress',
          )
        const source = (
          await db.query(
            'SELECT n.id,n.instance_id,n.capabilities FROM cm_handles h JOIN cm_nodes n ON n.namespace=h.namespace AND n.instance_id=h.instance_id WHERE h.namespace=$1 AND h.id=$2 AND NOT h.closed',
            [ns, session.active_handle],
          )
        ).rows[0]
        if (
          !source ||
          source.id !== request.expectedSourceNodeId ||
          source.id === request.nodeId
        )
          throw new MeshError(
            'TAKEOVER_CHANGED',
            'the owning device changed; refresh before taking over',
          )
        await this.node(db, ns, {
          nodeId: source.id,
          instanceId: source.instance_id,
        })
        if (JSON.parse(source.capabilities).takeoverVersion !== 1)
          throw new MeshError(
            'TAKEOVER_UNSUPPORTED',
            'update the complete plugin on the source device before taking over',
          )

        const mapping = (
          await db.query(
            'SELECT m.project_id FROM cm_session_summaries s JOIN cm_project_mappings m ON m.namespace=s.namespace AND m.project_id=s.project_id AND m.node_id=$3 WHERE s.namespace=$1 AND s.session_id=$2 AND s.incarnation=$4',
            [ns, id, request.nodeId, session.incarnation],
          )
        ).rows[0]
        if (!mapping)
          throw new MeshError(
            'WORKSPACE_MISMATCH',
            'configure the project directory on the requesting device first',
          )
        await this.expireTakeovers(db, ns)
        const prior = (
          await db.query(
            "SELECT * FROM cm_takeovers WHERE namespace=$1 AND session_id=$2 AND state='requested'",
            [ns, id],
          )
        ).rows[0]
        if (prior) {
          if (
            prior.target_node === request.nodeId &&
            prior.target_instance === request.instanceId &&
            JSON.stringify(
              prior.target_model ? JSON.parse(prior.target_model) : undefined,
            ) === JSON.stringify(request.targetModel)
          )
            return this.takeover(prior)
          throw new MeshError(
            'TAKEOVER_IN_PROGRESS',
            'another device has already requested this session',
          )
        }
        const row = (
          await db.query(
            'INSERT INTO cm_takeovers(namespace,id,session_id,incarnation,source_node,source_instance,source_handle,source_epoch,target_node,target_instance,handoff_operation,target_model) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
            [
              ns,
              request.operationId,
              id,
              session.incarnation,
              source.id,
              source.instance_id,
              session.active_handle,
              session.epoch,
              request.nodeId,
              request.instanceId,
              randomUUID(),
              request.targetModel ? JSON.stringify(request.targetModel) : null,
            ],
          )
        ).rows[0]!
        return this.takeover(row)
      },
    )
  }
  async pendingTakeovers(ns: string, identity: Identity) {
    return this.tx(async (db) => {
      await this.node(db, ns, identity)
      await this.expireTakeovers(db, ns)
      const rows = (
        await db.query(
          "SELECT * FROM cm_takeovers WHERE namespace=$1 AND source_node=$2 AND source_instance=$3 AND state='requested' ORDER BY expires_at LIMIT 100",
          [ns, identity.nodeId, identity.instanceId],
        )
      ).rows
      return rows.map((row) => this.takeover(row))
    })
  }
  async getTakeover(ns: string, id: string) {
    return this.tx(async (db) => {
      await this.expireTakeovers(db, ns)
      const row = (
        await db.query(
          'SELECT * FROM cm_takeovers WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
      ).rows[0]
      if (!row) throw new MeshError('NOT_FOUND', 'takeover not found', 404)
      return this.takeover(row)
    })
  }
  async failTakeover(
    ns: string,
    id: string,
    request: Identity & { code: string; message: string },
  ) {
    return this.tx(async (db) => {
      await this.node(db, ns, request)
      const row = (
        await db.query(
          "UPDATE cm_takeovers SET state='failed',error_code=$5,error=$6 WHERE namespace=$1 AND id=$2 AND source_node=$3 AND source_instance=$4 AND state='requested' RETURNING *",
          [
            ns,
            id,
            request.nodeId,
            request.instanceId,
            request.code,
            request.message,
          ],
        )
      ).rows[0]
      if (row) return this.takeover(row)
      const existing = (
        await db.query(
          'SELECT * FROM cm_takeovers WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
      ).rows[0]
      if (
        !existing ||
        existing.source_node !== request.nodeId ||
        existing.source_instance !== request.instanceId
      )
        throw new MeshError(
          'WRONG_DEVICE',
          'only the original source instance may reject this takeover',
          403,
        )
      return this.takeover(existing)
    })
  }
}
