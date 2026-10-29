import type { PoolClient } from 'pg'
import { z } from 'zod'
import { modelRoute } from '../../protocol/src/handoff.js'
import { DevicePostgresStore } from './devices.js'
import { MeshError } from '../../protocol/src/index.js'
import {
  modelRelayRecord,
  modelRelayRequest,
  type ModelRelayRequest,
} from '../../protocol/src/model-relay.js'

/** Durable barriers around device-owned changes to the next model route. */
export class ModelRelayPostgresStore extends DevicePostgresStore {
  private relayRow(row: Record<string, unknown>) {
    return modelRelayRecord.parse({
      ...modelRelayRequest.parse(this.decode(String(row.request))),
      id: row.id,
      sessionId: row.session_id,
      state: row.state,
      selectionSeq: row.state === 'completed' ? Number(row.history_cut) : null,
    })
  }
  private async relayNode(
    db: PoolClient,
    ns: string,
    identity: { nodeId: string; instanceId: string },
  ) {
    const row = (
      await db.query(
        "SELECT capabilities FROM cm_nodes WHERE namespace=$1 AND id=$2 AND instance_id=$3 AND last_seen>clock_timestamp()-($4::double precision*interval '1 millisecond')",
        [ns, identity.nodeId, identity.instanceId, this.nodeTimeoutMs],
      )
    ).rows[0]
    if (
      !row ||
      z
        .object({ modelRelayVersion: z.number().optional() })
        .parse(this.decode(row.capabilities)).modelRelayVersion !== 1
    )
      throw new MeshError(
        'MODEL_RELAY_UNSUPPORTED',
        'update this device before switching models',
      )
  }
  async prepareModelRelay(
    ns: string,
    sessionId: string,
    request: ModelRelayRequest,
  ) {
    return this.operation(
      ns,
      request.operationId,
      ['model-relay', sessionId, request],
      async (db) => {
        const { session, handle } = await this.handle(
          db,
          ns,
          request.handleId,
          request.epoch,
        )
        this.assertWriter(session, handle)
        await this.relayNode(db, ns, request)
        if (
          session.id !== sessionId ||
          session.incarnation !== request.incarnation ||
          handle.instance_id !== request.instanceId
        )
          throw new MeshError('OWNERSHIP_LOST', 'the session writer changed')
        if (session.active_handoff || session.active_model_relay)
          throw new MeshError(
            'MODEL_RELAY_BUSY',
            'a session transition is already in progress',
          )
        if (Number(session.next_seq) !== request.historyCut)
          throw new MeshError(
            'MODEL_RELAY_CHANGED',
            'the conversation changed; check it again',
          )
        const row = (
          await db.query(
            'INSERT INTO cm_model_relays(namespace,id,session_id,incarnation,node_id,history_cut,request) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',
            [
              ns,
              request.operationId,
              sessionId,
              session.incarnation,
              request.nodeId,
              request.historyCut,
              JSON.stringify(request),
            ],
          )
        ).rows[0]
        await db.query(
          'UPDATE cm_sessions SET active_model_relay=$3 WHERE namespace=$1 AND id=$2',
          [ns, sessionId, request.operationId],
        )
        return this.relayRow(row)
      },
    )
  }
  async getModelRelay(ns: string, id: string) {
    const row = (
      await this.pool.query(
        'SELECT * FROM cm_model_relays WHERE namespace=$1 AND id=$2',
        [ns, id],
      )
    ).rows[0]
    if (!row) throw new MeshError('NOT_FOUND', 'model switch not found', 404)
    return this.relayRow(row)
  }
  async pendingModelRelays(ns: string, nodeId: string) {
    return (
      await this.pool.query(
        "SELECT * FROM cm_model_relays WHERE namespace=$1 AND node_id=$2 AND state='prepared' ORDER BY history_cut",
        [ns, nodeId],
      )
    ).rows.map((row) => this.relayRow(row))
  }
  /** Reconcile the authoritative event; a timeout or expired lease alone never proves rollback. */
  async finishModelRelay(
    ns: string,
    id: string,
    identity: { nodeId: string; instanceId: string; cancel?: boolean },
  ) {
    return this.tx(async (db) => {
      const ref = (
        await db.query(
          'SELECT * FROM cm_model_relays WHERE namespace=$1 AND id=$2',
          [ns, id],
        )
      ).rows[0]
      if (!ref) throw new MeshError('NOT_FOUND', 'model switch not found', 404)
      const session = await this.session(db, ns, ref.session_id)
      const row = (
        await db.query(
          'SELECT * FROM cm_model_relays WHERE namespace=$1 AND id=$2 FOR UPDATE',
          [ns, id],
        )
      ).rows[0]
      await this.relayNode(db, ns, identity)
      if (
        row.node_id !== identity.nodeId ||
        row.incarnation !== session.incarnation
      )
        throw new MeshError(
          'WRONG_DEVICE',
          'this device cannot settle the model switch',
          403,
        )
      if (row.state !== 'prepared') return this.relayRow(row)
      const request = this.relayRow(row)
      const stored = (
        await db.query(
          'SELECT event FROM cm_events WHERE namespace=$1 AND session_id=$2 AND seq=$3',
          [ns, session.id, request.historyCut],
        )
      ).rows[0]
      const event = stored
        ? z
            .object({ type: z.string(), data: z.unknown() })
            .parse(this.decode(stored.event))
        : undefined
      const committed =
        event?.type === 'model/selection' &&
        JSON.stringify(modelRoute.parse(event.data)) ===
          JSON.stringify(request.target)
      const originalWriter =
        session.active_handle === request.handleId &&
        Number(session.epoch) === request.epoch
      if (
        !committed &&
        !event &&
        originalWriter &&
        !(identity.cancel && request.instanceId === identity.instanceId)
      )
        throw new MeshError(
          'MODEL_RELAY_UNCONFIRMED',
          'save the pending model selection before continuing',
          409,
        )
      // A changed cut cannot be interpreted as a successful selection; keep all native events.
      const state = committed ? 'completed' : 'failed'
      const updated = (
        await db.query(
          'UPDATE cm_model_relays SET state=$3 WHERE namespace=$1 AND id=$2 RETURNING *',
          [ns, id, state],
        )
      ).rows[0]
      await db.query(
        'UPDATE cm_sessions SET active_model_relay=NULL WHERE namespace=$1 AND id=$2 AND active_model_relay=$3',
        [ns, session.id, id],
      )
      return this.relayRow(updated)
    })
  }
}
