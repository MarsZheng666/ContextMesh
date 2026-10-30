import type { PoolClient } from 'pg'
import { ModelRelayPostgresStore } from './model-relay.js'
import { MeshError } from '../../protocol/src/index.js'
import {
  transferBundle,
  type TransferRecord,
  type TransferBundle,
} from '../../protocol/src/transfers.js'
import {
  bundleDigest,
  validateBundle,
  transferSummary,
} from '../../protocol/src/transfer-hash.js'
export class TransferPostgresStore extends ModelRelayPostgresStore {
  private async transferNode(
    db: PoolClient,
    ns: string,
    nodeId: string,
    instanceId: string,
  ) {
    const result = await db.query(
      "SELECT 1 FROM cm_nodes WHERE namespace=$1 AND id=$2 AND instance_id=$3 AND last_seen > clock_timestamp()-($4::double precision*interval '1 millisecond')",
      [ns, nodeId, instanceId, this.nodeTimeoutMs],
    )
    if (!result.rowCount)
      throw new MeshError(
        'NODE_UNAVAILABLE',
        'device instance is offline or changed',
      )
  }
  private transferRecord(row: {
    id: string
    digest: string
    bundle: string
    ready: boolean
    expires_at: Date
  }): TransferRecord {
    const bundle = validateBundle(this.decode(row.bundle))
    if (bundleDigest(bundle) !== row.digest)
      throw new MeshError(
        'TRANSFER_CORRUPT',
        'stored transfer digest mismatch',
        422,
      )
    return {
      id: row.id,
      digest: row.digest,
      bundle,
      ready: row.ready,
      expiresAt: row.expires_at.getTime(),
    }
  }
  async uploadTransfer(
    ns: string,
    r: {
      operationId: string
      nodeId: string
      instanceId: string
      bundle: TransferBundle
    },
  ) {
    const bundle = validateBundle(r.bundle)
    return this.operation(
      ns,
      r.operationId,
      ['workspace-transfer', r],
      async (db) => {
        await this.transferNode(db, ns, r.nodeId, r.instanceId)
        if (bundle.sourceNodeId !== r.nodeId)
          throw new MeshError(
            'WRONG_DEVICE',
            'only the source can export files',
            403,
          )
        const session = await this.session(db, ns, bundle.sessionId)
        const writer = (
          await db.query(
            'SELECT instance_id FROM cm_handles WHERE namespace=$1 AND id=$2 AND NOT closed',
            [ns, session.active_handle],
          )
        ).rows[0]
        if (
          !session.lease_valid ||
          session.active_model_relay ||
          session.incarnation !== bundle.incarnation ||
          writer?.instance_id !== r.instanceId ||
          session.active_handoff ||
          session.recovery_required
        )
          throw new MeshError(
            'NOT_LOCAL_WRITER',
            'export requires the current writer',
          )
        const summary = (
          await db.query(
            'SELECT project_id FROM cm_session_summaries WHERE namespace=$1 AND session_id=$2',
            [ns, bundle.sessionId],
          )
        ).rows[0]
        if (summary?.project_id !== bundle.projectId)
          throw new MeshError(
            'PROJECT_REQUIRED',
            'configure this conversation project before exporting',
          )
        await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          ns + ':workspace-transfer-quota',
        ])
        await db.query(
          "DELETE FROM cm_workspace_transfers WHERE namespace=$1 AND expires_at < clock_timestamp() AND NOT EXISTS (SELECT 1 FROM cm_handoffs h WHERE h.namespace=$1 AND h.manifest::jsonb->>'transferId'=cm_workspace_transfers.id::text AND h.state IN ('requested','preparing','ready','activating','recovery_required'))",
          [ns],
        )
        const quota = (
          await db.query(
            'SELECT count(*) AS n FROM cm_workspace_transfers WHERE namespace=$1',
            [ns],
          )
        ).rows[0]
        if (Number(quota.n) >= 32)
          throw new MeshError(
            'TRANSFER_QUOTA',
            'too many retained transfers; wait for expiry',
          )
        const digest = bundleDigest(bundle)
        await db.query(
          'INSERT INTO cm_workspace_transfers(namespace,id,session_id,incarnation,source_node,target_node,project_id,digest,bundle) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [
            ns,
            r.operationId,
            bundle.sessionId,
            bundle.incarnation,
            bundle.sourceNodeId,
            bundle.targetNodeId,
            bundle.projectId,
            digest,
            JSON.stringify(bundle),
          ],
        )
        const record = await this.loadTransfer(db, ns, r.operationId)
        return transferSummary(record)
      },
    )
  }
  protected async loadTransfer(db: PoolClient, ns: string, id: string) {
    const row = (
      await db.query(
        'SELECT * FROM cm_workspace_transfers WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
    ).rows[0]
    if (!row)
      throw new MeshError('NOT_FOUND', 'workspace transfer not found', 404)
    if (row.expires_at.getTime() <= Date.now())
      throw new MeshError(
        'TRANSFER_EXPIRED',
        'workspace transfer expired; export again',
      )
    return this.transferRecord(row)
  }
  async readTransfer(
    ns: string,
    id: string,
    r: { nodeId: string; instanceId: string },
  ) {
    return this.tx(async (db) => {
      await this.transferNode(db, ns, r.nodeId, r.instanceId)
      const record = await this.loadTransfer(db, ns, id)
      if (
        ![record.bundle.sourceNodeId, record.bundle.targetNodeId].includes(
          r.nodeId,
        )
      )
        throw new MeshError(
          'WRONG_DEVICE',
          'transfer belongs to other devices',
          403,
        )
      return record
    })
  }
  async listTransfers(ns: string, r: { nodeId: string; instanceId: string }) {
    return this.tx(async (db) => {
      await this.transferNode(db, ns, r.nodeId, r.instanceId)
      const rows = (
        await db.query(
          'SELECT * FROM cm_workspace_transfers WHERE namespace=$1 AND (source_node=$2 OR target_node=$2) AND expires_at>clock_timestamp() ORDER BY created_at DESC LIMIT 32',
          [ns, r.nodeId],
        )
      ).rows
      return rows.map((row) => transferSummary(this.transferRecord(row)))
    })
  }
  async receiptTransfer(
    ns: string,
    id: string,
    r: { nodeId: string; instanceId: string; digest: string; ready: boolean },
  ) {
    return this.tx(async (db) => {
      await this.transferNode(db, ns, r.nodeId, r.instanceId)
      const record = await this.loadTransfer(db, ns, id)
      if (record.bundle.targetNodeId !== r.nodeId || record.digest !== r.digest)
        throw new MeshError(
          'TRANSFER_CHANGED',
          'transfer target or digest changed',
        )
      const session = await this.session(db, ns, record.bundle.sessionId)
      if (
        session.incarnation !== record.bundle.incarnation ||
        session.active_handoff
      )
        throw new MeshError(
          'HANDOFF_IN_PROGRESS',
          'cannot change workspace receipt during handoff',
        )
      await db.query(
        'UPDATE cm_workspace_transfers SET ready=$3 WHERE namespace=$1 AND id=$2',
        [ns, id, r.ready],
      )
      return { ready: r.ready }
    })
  }
}
