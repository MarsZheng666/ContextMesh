import type { Pool } from 'pg'

const sql = `
CREATE TABLE IF NOT EXISTS cm_schema (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS cm_sessions (
 namespace text NOT NULL, id text NOT NULL, adapter text NOT NULL,
 incarnation uuid NOT NULL, header text NOT NULL, inherited_count bigint NOT NULL CHECK(inherited_count >= 0),
 next_seq bigint NOT NULL DEFAULT 0 CHECK(next_seq >= 0), generation bigint NOT NULL DEFAULT 0,
 materialized boolean NOT NULL DEFAULT false, creator_instance uuid NOT NULL,
 epoch bigint NOT NULL DEFAULT 1, active_handle uuid, lease_until timestamptz,
 recovery_required boolean NOT NULL DEFAULT false,
 PRIMARY KEY(namespace,id)
);
CREATE TABLE IF NOT EXISTS cm_handles (
 namespace text NOT NULL, id uuid NOT NULL, session_id text NOT NULL, incarnation uuid NOT NULL, instance_id uuid NOT NULL,
 access text NOT NULL CHECK(access IN ('read','write')), epoch bigint NOT NULL,
 closed boolean NOT NULL DEFAULT false, close_failed boolean NOT NULL DEFAULT false,
 PRIMARY KEY(namespace,id)
);
CREATE INDEX IF NOT EXISTS cm_handles_session ON cm_handles(namespace,session_id);
CREATE TABLE IF NOT EXISTS cm_events (
 namespace text NOT NULL, session_id text NOT NULL, seq bigint NOT NULL CHECK(seq >= 0), event text NOT NULL,
 PRIMARY KEY(namespace,session_id,seq),
 FOREIGN KEY(namespace,session_id) REFERENCES cm_sessions(namespace,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS cm_operations (
 namespace text NOT NULL, id uuid NOT NULL, digest text NOT NULL, result text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(namespace,id)
);
INSERT INTO cm_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
`
const v2 = `
ALTER TABLE cm_sessions ADD COLUMN IF NOT EXISTS active_handoff uuid;
CREATE TABLE cm_nodes (
 namespace text NOT NULL,id uuid NOT NULL,instance_id uuid NOT NULL,name text NOT NULL,capabilities text NOT NULL,
 last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(namespace,id)
);
CREATE TABLE cm_projects(namespace text NOT NULL,id uuid NOT NULL,name text NOT NULL,PRIMARY KEY(namespace,id));
CREATE TABLE cm_project_mappings(
 namespace text NOT NULL,project_id uuid NOT NULL,node_id uuid NOT NULL,root text NOT NULL,revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(namespace,project_id,node_id),FOREIGN KEY(namespace,project_id) REFERENCES cm_projects(namespace,id) ON DELETE CASCADE,
 FOREIGN KEY(namespace,node_id) REFERENCES cm_nodes(namespace,id) ON DELETE CASCADE
);
CREATE TABLE cm_handoffs(
 namespace text NOT NULL,id uuid NOT NULL,session_id text NOT NULL,incarnation uuid NOT NULL,
 source_node uuid NOT NULL,source_instance uuid NOT NULL,source_handle uuid NOT NULL,source_epoch bigint NOT NULL,
 target_node uuid NOT NULL,target_instance uuid NOT NULL,state text NOT NULL DEFAULT 'requested',revision bigint NOT NULL DEFAULT 0,
 manifest text NOT NULL,proof text,final_seq bigint,final_generation bigint,target_handle uuid,error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(namespace,id),FOREIGN KEY(namespace,session_id) REFERENCES cm_sessions(namespace,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cm_handoff_active ON cm_handoffs(namespace,session_id) WHERE state IN ('requested','preparing','ready','activating','recovery_required');
CREATE TABLE cm_session_summaries(
 namespace text NOT NULL,session_id text NOT NULL,incarnation uuid NOT NULL,next_seq bigint NOT NULL,title text NOT NULL,
 project_id uuid NOT NULL,node_id uuid NOT NULL,last_activity bigint NOT NULL,
 PRIMARY KEY(namespace,session_id),FOREIGN KEY(namespace,session_id) REFERENCES cm_sessions(namespace,id) ON DELETE CASCADE
);
INSERT INTO cm_schema(version) VALUES(2);
`
const v3 = `
CREATE TABLE cm_takeovers (
 namespace text NOT NULL,id uuid NOT NULL,session_id text NOT NULL,incarnation uuid NOT NULL,
 source_node uuid NOT NULL,source_instance uuid NOT NULL,source_handle uuid NOT NULL,source_epoch bigint NOT NULL,
 target_node uuid NOT NULL,target_instance uuid NOT NULL,handoff_operation uuid NOT NULL,
 state text NOT NULL DEFAULT 'requested',handoff_id uuid,error_code text,error text,
 expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '120 seconds'),
 PRIMARY KEY(namespace,id),FOREIGN KEY(namespace,session_id) REFERENCES cm_sessions(namespace,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cm_takeover_pending ON cm_takeovers(namespace,session_id) WHERE state='requested';
INSERT INTO cm_schema(version) VALUES(3);
`
const v4 = `
ALTER TABLE cm_sessions ADD COLUMN active_model_relay uuid;
ALTER TABLE cm_takeovers ADD COLUMN target_model text;
CREATE TABLE cm_model_relays (
 namespace text NOT NULL,id uuid NOT NULL,session_id text NOT NULL,incarnation uuid NOT NULL,
 node_id uuid NOT NULL,history_cut bigint NOT NULL,request text NOT NULL,state text NOT NULL DEFAULT 'prepared',
 PRIMARY KEY(namespace,id),FOREIGN KEY(namespace,session_id) REFERENCES cm_sessions(namespace,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cm_model_relay_active ON cm_model_relays(namespace,session_id) WHERE state='prepared';
INSERT INTO cm_schema(version) VALUES(4);
`
const v5 = `
CREATE TABLE cm_pairings (
 namespace text NOT NULL,id uuid NOT NULL,code_hash text NOT NULL,name text NOT NULL,ttl_seconds integer NOT NULL,
 expires_at timestamptz NOT NULL,claim_id uuid,credential_id uuid,node_id uuid,
 PRIMARY KEY(namespace,id),UNIQUE(namespace,code_hash)
);
CREATE TABLE cm_device_credentials (
 namespace text NOT NULL,id uuid NOT NULL,node_id uuid NOT NULL,name text NOT NULL,token_hash text NOT NULL,
 revoked boolean NOT NULL DEFAULT false,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),last_seen timestamptz,
 PRIMARY KEY(namespace,id),UNIQUE(namespace,token_hash),UNIQUE(namespace,node_id)
);
INSERT INTO cm_schema(version) VALUES(5);
`
export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('contextmesh-schema'))",
    )
    await client.query(sql)
    const result = await client.query(
      'SELECT max(version) AS version FROM cm_schema',
    )
    let version = Number(result.rows[0].version)
    if (version < 1 || version > 5)
      throw new Error('unsupported ContextMesh database schema')
    if (version === 1) {
      await client.query(v2)
      version = 2
    }
    if (version === 2) {
      await client.query(v3)
      version = 3
    }
    if (version === 3) {
      await client.query(v4)
      version = 4
    }
    if (version === 4) await client.query(v5)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
export async function assertDurability(pool: Pool): Promise<void> {
  const result = await pool.query(
    "SELECT current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS commit",
  )
  if (
    result.rows[0].fsync !== 'on' ||
    !['on', 'remote_apply', 'remote_write', 'local'].includes(
      result.rows[0].commit,
    )
  ) {
    throw new Error(
      'ContextMesh requires fsync=on and synchronous_commit enabled',
    )
  }
}
