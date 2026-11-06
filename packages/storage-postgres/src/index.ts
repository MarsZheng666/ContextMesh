import { z } from 'zod'
import { HandoffPostgresStore, type Update } from './handoff-store.js'
import { MeshError } from '../../protocol/src/index.js'
import { contextDigest, validatePortable } from '../../protocol/src/portable.js'
import type { HandoffManifest } from '../../protocol/src/handoff.js'
export type { StoreOptions } from './base.js'

/** Native logs keep their own formats; handoff records link the transferred task. */
export class PostgresStore extends HandoffPostgresStore {
  async codexArchives(ns: string, id?: string) {
    const result = await this.pool.query(
      `SELECT s.id,s.incarnation,s.next_seq::int AS "nextSeq",(s.header::jsonb->>'createdAt')::double precision AS "createdAt",s.active_handle IS NOT NULL AS busy,
      (s.recovery_required OR s.active_handoff IS NOT NULL OR
       EXISTS(SELECT 1 FROM cm_handoffs h WHERE h.namespace=s.namespace AND h.target_session=s.id AND h.execution IN ('pending','dispatching','uncertain')) OR
       (s.header::jsonb ? 'handoffId' AND NOT EXISTS(SELECT 1 FROM cm_handoffs h WHERE h.namespace=s.namespace AND h.id::text=s.header::jsonb->>'handoffId' AND h.state='completed' AND h.target_session=s.id))) AS "recoveryRequired"
      FROM cm_sessions s WHERE s.namespace=$1 AND s.adapter='codex' AND s.materialized AND ($2::text IS NULL OR s.id=$2) ORDER BY "createdAt" DESC,s.id LIMIT 100`,
      [ns, id ?? null],
    )
    return result.rows
  }

  async claimCodexSourceStop(ns: string, id: string, r: Update) {
    return this.operation(
      ns,
      r.operationId,
      ['codex-source-stop', id, r],
      async (db) => {
        const { row, session: s } = await this.locked(db, ns, id)
        this.check(row, r, 'source', ['preparing'])
        await this.node(db, ns, r)
        await this.node(db, ns, {
          nodeId: row.target_node,
          instanceId: row.target_instance,
        })
        if (
          this.record(row).manifest.targetAgent !== 'codex' ||
          s.active_handoff !== id ||
          s.active_handle !== row.source_handle ||
          !s.lease_valid ||
          s.recovery_required ||
          s.successor_session
        )
          throw new MeshError(
            'OWNERSHIP_LOST',
            'Source stop is no longer authorized by a prepared live receiver',
          )
        await db.query(
          'UPDATE cm_handoffs SET source_stop_claimed=true WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
        return this.transition(db, ns, id, 'preparing')
      },
    )
  }
  async adoptPendingCodex(
    ns: string,
    id: string,
    r: Update & { confirmStopped: true },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['codex-adopt-pending', id, r],
      async (db) => {
        const { row, session: source } = await this.locked(db, ns, id)
        if (
          row.state !== 'completed' ||
          row.execution !== 'pending' ||
          row.target_node !== r.nodeId ||
          Number(row.revision) !== r.revision ||
          !row.target_session ||
          source.successor_session !== row.target_session
        )
          throw new MeshError(
            'HANDOFF_STATE',
            'Only an unused continuation can move to a restarted receiver',
          )
        await this.node(db, ns, r)
        const target = await this.session(db, ns, row.target_session)
        if (target.active_handle || target.recovery_required)
          throw new MeshError(
            'CLOSE_UNCONFIRMED',
            'Recover the stopped Codex writer first',
          )
        await db.query(
          'UPDATE cm_handoffs SET target_instance=$3 WHERE namespace=$1 AND id=$2',
          [ns, id, r.instanceId],
        )
        return this.transition(db, ns, id, 'completed')
      },
    )
  }
  async acceptCodexHandoff(
    ns: string,
    id: string,
    r: Update & {
      targetSessionId: string
      proof: HandoffManifest['workspace']
    },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['codex-accept', id, r],
      async (db) => {
        const { row, session: source } = await this.locked(db, ns, id)
        this.check(row, r, 'target', ['ready'])
        const node = await this.node(db, ns, r)
        if (
          this.record(row).manifest.targetAgent !== 'codex' ||
          JSON.parse(node.capabilities).adapter !== 'codex'
        )
          throw new MeshError(
            'ADAPTER_MISMATCH',
            'This handoff requires the confirmed Codex receiver',
          )
        if (JSON.stringify(this.decode(row.proof!)) !== JSON.stringify(r.proof))
          throw new MeshError(
            'WORKSPACE_MISMATCH',
            'Receiver preflight changed',
          )
        const mapping = (
          await db.query(
            'SELECT revision FROM cm_project_mappings WHERE namespace=$1 AND project_id=$2 AND node_id=$3',
            [ns, r.proof.projectId, r.nodeId],
          )
        ).rows[0]
        if (!mapping || Number(mapping.revision) !== r.proof.mappingRevision)
          throw new MeshError('WORKSPACE_MISMATCH', 'Receiver mapping changed')
        if (
          source.active_handle ||
          source.recovery_required ||
          source.successor_session ||
          source.active_handoff !== id ||
          source.incarnation !== row.incarnation ||
          source.next_seq !== row.final_seq ||
          source.generation !== row.final_generation
        )
          throw new MeshError(
            'OWNERSHIP_LOST',
            'Source close and final history must still match',
          )
        if (r.targetSessionId !== 'codex:' + id)
          throw new MeshError(
            'INVALID_ARGUMENT',
            'Target identity must be bound to this handoff',
          )
        const target = await this.session(db, ns, r.targetSessionId)
        if (
          target.adapter !== 'codex' ||
          !target.materialized ||
          target.active_handle ||
          target.recovery_required ||
          target.successor_session ||
          target.creator_instance !== r.instanceId
        )
          throw new MeshError(
            'TARGET_NOT_READY',
            'The receiving instance must finish archiving its prepared Codex thread',
          )
        const header = z
          .object({
            version: z.literal(1),
            portable: z.unknown(),
            sourceDigest: z.string(),
            nativeThreadId: z.string().min(1),
            handoffId: z.literal(id),
          })
          .passthrough()
          .parse(this.decode(target.header))
        const context = validatePortable(header.portable)
        if (
          context.source.adapter !== 'deepseek' ||
          context.source.id !== source.id ||
          context.source.incarnation !== source.incarnation ||
          context.source.eventCount !== Number(row.final_seq) ||
          header.sourceDigest !== contextDigest(context)
        )
          throw new MeshError(
            'HISTORY_CHANGED',
            'Codex must import the finalized source cut',
          )
        const execution = this.record(row).manifest.continuation
          ? 'pending'
          : 'none'
        await db.query(
          'UPDATE cm_sessions SET successor_session=$3,active_handoff=NULL,epoch=epoch+1 WHERE namespace=$1 AND id=$2',
          [ns, source.id, target.id],
        )
        await db.query(
          'UPDATE cm_handoffs SET target_session=$3,execution=$4 WHERE namespace=$1 AND id=$2',
          [ns, id, target.id, execution],
        )
        return this.transition(db, ns, id, 'completed')
      },
    )
  }
  async claimCodexContinuation(
    ns: string,
    id: string,
    r: Update & { handleId: string; epoch: number; runOperationId: string },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['codex-dispatch', id, r],
      async (db) => {
        const { row, session: source } = await this.locked(db, ns, id)
        this.check(row, r, 'target', ['completed'])
        await this.node(db, ns, r)
        if (
          !row.target_session ||
          source.successor_session !== row.target_session ||
          row.execution !== 'pending' ||
          !this.record(row).manifest.continuation
        )
          throw new MeshError(
            'CONTINUATION_SPENT',
            'This continuation has no unused dispatch authorization',
          )
        const { session: target, handle } = await this.handle(
          db,
          ns,
          r.handleId,
          r.epoch,
        )
        this.assertWriter(target, handle)
        if (
          target.id !== row.target_session ||
          handle.instance_id !== r.instanceId
        )
          throw new MeshError(
            'WRONG_DEVICE',
            'The confirmed receiver must own the Codex writer',
          )
        await db.query(
          "UPDATE cm_handoffs SET execution='dispatching',execution_operation=$3 WHERE namespace=$1 AND id=$2",
          [ns, id, r.runOperationId],
        )
        return this.transition(db, ns, id, 'completed')
      },
    )
  }
  async finishCodexContinuation(
    ns: string,
    id: string,
    r: Update & {
      runOperationId: string
      turnId?: string
      confirmStopped?: true
    },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['codex-finish', id, r],
      async (db) => {
        const { row, session: source } = await this.locked(db, ns, id)
        if (
          row.state !== 'completed' ||
          Number(row.revision) !== r.revision ||
          row.target_node !== r.nodeId ||
          !row.target_session ||
          source.successor_session !== row.target_session ||
          !['dispatching', 'uncertain'].includes(row.execution) ||
          row.execution_operation !== r.runOperationId
        )
          throw new MeshError(
            'HANDOFF_STATE',
            'Refresh the pending Codex execution before acknowledging it',
          )
        await this.node(db, ns, r)
        if (row.target_instance !== r.instanceId && !r.confirmStopped)
          throw new MeshError(
            'WRONG_DEVICE',
            'A restarted receiver requires explicit stopped-process reconciliation',
          )
        const target = await this.session(db, ns, row.target_session)
        if (target.active_handle || target.recovery_required)
          throw new MeshError(
            'CLOSE_UNCONFIRMED',
            'Codex execution must be archived and its writer closed first',
          )
        const latest = (
          await db.query(
            "SELECT event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND event::jsonb->>'type'='codex/snapshot' AND event::jsonb->>'runOperationId'=$3 ORDER BY seq DESC LIMIT 1",
            [ns, target.id, r.runOperationId],
          )
        ).rows[0]
        const archive = z
          .object({
            snapshot: z
              .object({
                items: z.array(
                  z.object({
                    turnId: z.string(),
                    item: z
                      .object({
                        type: z.string(),
                        clientId: z.string().nullable().optional(),
                      })
                      .passthrough(),
                  }),
                ),
                turns: z.array(
                  z
                    .object({
                      id: z.string(),
                      status: z.enum(['completed', 'failed', 'interrupted']),
                    })
                    .passthrough(),
                ),
              })
              .passthrough(),
          })
          .safeParse(latest ? this.decode(latest.event) : null)
        if (!archive.success)
          throw new MeshError(
            'EXECUTION_UNCONFIRMED',
            'No settled native snapshot confirms this execution',
          )
        const turn = r.turnId
          ? archive.data.snapshot.turns.find((t) => t.id === r.turnId)
          : archive.data.snapshot.turns.at(-1)
        if (
          !turn ||
          !archive.data.snapshot.items.some(
            (entry) =>
              entry.turnId === turn.id &&
              entry.item.type === 'userMessage' &&
              entry.item.clientId === r.runOperationId,
          )
        )
          throw new MeshError(
            'EXECUTION_UNCONFIRMED',
            'Native execution turn is missing',
          )
        await db.query(
          'UPDATE cm_handoffs SET execution=$3,execution_turn=$4,target_instance=$5,error=NULL WHERE namespace=$1 AND id=$2',
          [
            ns,
            id,
            turn.status === 'completed' ? 'completed' : 'failed',
            turn.id,
            r.instanceId,
          ],
        )
        return this.transition(db, ns, id, 'completed')
      },
    )
  }
  async markCodexUncertain(
    ns: string,
    id: string,
    r: Update & { runOperationId: string },
  ) {
    return this.operation(
      ns,
      r.operationId,
      ['codex-uncertain', id, r],
      async (db) => {
        const { row } = await this.locked(db, ns, id)
        this.check(row, r, 'target', ['completed'])
        await this.node(db, ns, r)
        if (
          row.execution !== 'dispatching' ||
          row.execution_operation !== r.runOperationId
        )
          throw new MeshError('HANDOFF_STATE', 'The dispatch no longer matches')
        await db.query(
          "UPDATE cm_handoffs SET execution='uncertain',error='Codex result needs explicit reconciliation; do not resend the continuation' WHERE namespace=$1 AND id=$2",
          [ns, id],
        )
        return this.transition(db, ns, id, 'completed')
      },
    )
  }
}
