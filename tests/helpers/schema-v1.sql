
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
