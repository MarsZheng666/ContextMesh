import { createHash, createHmac, randomUUID } from 'node:crypto'
import { BasePostgresStore } from './base.js'
import { MeshError } from '../../protocol/src/index.js'
import type { z } from 'zod'
import type { pairingCreate, pairingClaim } from '../../protocol/src/devices.js'
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export class DevicePostgresStore extends BasePostgresStore {
  async createPairing(
    ns: string,
    secret: string,
    input: z.infer<typeof pairingCreate>,
  ) {
    const code = createHmac('sha256', secret)
      .update(`pair:${ns}:${input.operationId}`)
      .digest('base64url')
      .slice(0, 16)
    return this.tx(async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `pair-create:${ns}`,
      ])
      let row = (
        await db.query(
          'SELECT * FROM cm_pairings WHERE namespace=$1 AND id=$2',
          [ns, input.operationId],
        )
      ).rows[0]
      if (
        row &&
        (row.name !== input.name || row.ttl_seconds !== input.ttlSeconds)
      )
        throw new MeshError('IDEMPOTENCY_CONFLICT', 'pairing request changed')
      if (!row) {
        const count = (
          await db.query(
            'SELECT count(*) FROM cm_pairings WHERE namespace=$1 AND claim_id IS NULL AND expires_at>clock_timestamp()',
            [ns],
          )
        ).rows[0].count
        if (Number(count) >= 10)
          throw new MeshError(
            'PAIRING_LIMIT',
            'wait for an existing invitation to expire',
            429,
          )
        row = (
          await db.query(
            "INSERT INTO cm_pairings(namespace,id,code_hash,name,ttl_seconds,expires_at) VALUES($1,$2,$3,$4,$5::integer,clock_timestamp()+($5::integer*interval '1 second')) RETURNING *",
            [ns, input.operationId, hash(code), input.name, input.ttlSeconds],
          )
        ).rows[0]
      }
      return {
        id: row.id,
        code,
        expiresAt: new Date(row.expires_at).getTime(),
        name: row.name,
      }
    })
  }
  async claimPairing(
    ns: string,
    secret: string,
    input: z.infer<typeof pairingClaim>,
  ) {
    return this.tx(async (db) => {
      const row = (
        await db.query(
          'SELECT *,expires_at>clock_timestamp() AS valid FROM cm_pairings WHERE namespace=$1 AND code_hash=$2 FOR UPDATE',
          [ns, hash(input.code)],
        )
      ).rows[0]
      const invalid = () =>
        new MeshError(
          'PAIRING_INVALID',
          'pairing code is invalid, expired, or already used',
          403,
        )
      if (!row?.valid || (row.claim_id && row.claim_id !== input.claimId))
        throw invalid()
      const id = row.credential_id ?? randomUUID(),
        nodeId = row.node_id ?? randomUUID()
      const token =
        'cm2_' +
        createHmac('sha256', secret)
          .update(`device:${ns}:${id}:${input.claimId}`)
          .digest('base64url')
      if (!row.claim_id) {
        await db.query(
          'INSERT INTO cm_device_credentials(namespace,id,node_id,name,token_hash) VALUES($1,$2,$3,$4,$5)',
          [ns, id, nodeId, row.name, hash(token)],
        )
        await db.query(
          'UPDATE cm_pairings SET claim_id=$3,credential_id=$4,node_id=$5 WHERE namespace=$1 AND id=$2',
          [ns, row.id, input.claimId, id, nodeId],
        )
      } else {
        const credential = (
          await db.query(
            'SELECT revoked,token_hash FROM cm_device_credentials WHERE namespace=$1 AND id=$2',
            [ns, id],
          )
        ).rows[0]
        if (
          !credential ||
          credential.revoked ||
          credential.token_hash !== hash(token)
        )
          throw invalid()
      }
      return { credentialId: id, nodeId, name: row.name, token }
    })
  }
  async authenticateDevice(ns: string, token: string) {
    return (
      await this.pool.query(
        'UPDATE cm_device_credentials SET last_seen=clock_timestamp() WHERE namespace=$1 AND token_hash=$2 AND NOT revoked RETURNING id,node_id AS "nodeId",name',
        [ns, hash(token)],
      )
    ).rows[0] as { id: string; nodeId: string; name: string } | undefined
  }
  async deviceCredentials(ns: string) {
    return (
      await this.pool.query(
        'SELECT id,node_id AS "nodeId",name,revoked,created_at AS "createdAt",last_seen AS "lastSeen" FROM cm_device_credentials WHERE namespace=$1 ORDER BY created_at,id',
        [ns],
      )
    ).rows
  }
  async revokeDevice(ns: string, id: string) {
    const result = await this.pool.query(
      'UPDATE cm_device_credentials SET revoked=true WHERE namespace=$1 AND id=$2 RETURNING id',
      [ns, id],
    )
    if (!result.rowCount)
      throw new MeshError('NOT_FOUND', 'device credential not found', 404)
    return { revoked: true }
  }
}
