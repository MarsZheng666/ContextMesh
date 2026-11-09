import { STORAGE_SCHEMA_VERSION } from '../../packages/protocol/src/index.js'
import { Pool } from 'pg'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { it, expect, inject } from 'vitest'
import { migrate } from '../../packages/storage-postgres/src/migration.js'
it('upgrades schema 1 transactionally, retains old sessions, and rejects future schemas', async () => {
  const connectionString = inject('databaseUrl'),
    admin = new Pool({ connectionString }),
    schema = 'migration_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA ${schema}`)
  const db = new Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await db.query(await readFile('tests/helpers/schema-v1.sql', 'utf8'))
    await db.query(
      `INSERT INTO cm_sessions(namespace,id,adapter,incarnation,header,inherited_count,creator_instance) VALUES('legacy','session','deepseek',$1,'{"id":"session","version":4}',0,$2)`,
      [randomUUID(), randomUUID()],
    )
    await db.query(
      `INSERT INTO cm_events(namespace,session_id,seq,event) VALUES('legacy','session',0,'original history')`,
    )
    await Promise.all([migrate(db), migrate(db)])
    expect(
      (await db.query('SELECT max(version) AS version FROM cm_schema')).rows[0]
        .version,
    ).toBe(STORAGE_SCHEMA_VERSION)
    expect(
      (await db.query('SELECT active_handoff,header FROM cm_sessions')).rows[0],
    ).toEqual({ active_handoff: null, header: '{"id":"session","version":4}' })
    expect((await db.query('SELECT event FROM cm_events')).rows[0].event).toBe(
      'original history',
    )
    // The previous release's schema 6 migrates without changing raw history.
    await db.query('DROP INDEX cm_sessions_adapter')
    await db.query(
      'DROP TABLE cm_archive_entries, cm_archive_blocks, cm_archives',
    )
    await db.query('DELETE FROM cm_schema WHERE version>=7')
    await migrate(db)
    expect(
      (await db.query("SELECT to_regclass('cm_sessions_adapter') AS name"))
        .rows[0].name,
    ).toBe('cm_sessions_adapter')
    expect((await db.query('SELECT event FROM cm_events')).rows[0].event).toBe(
      'original history',
    )
    // Exercise a direct upgrade from the previous schema-2 boundary as well.
    await db.query('DROP TABLE IF EXISTS cm_workspace_transfers')
    await db.query('DROP INDEX IF EXISTS cm_sessions_adapter')
    await db.query(
      'DROP TABLE cm_archive_entries, cm_archive_blocks, cm_archives',
    )
    await db.query('DELETE FROM cm_schema WHERE version>=6')
    await db.query('DROP TABLE IF EXISTS cm_pairings,cm_device_credentials')
    await db.query('DELETE FROM cm_schema WHERE version=5')
    await db.query('DROP TABLE cm_model_relays')
    await db.query('ALTER TABLE cm_sessions DROP COLUMN active_model_relay')
    await db.query('ALTER TABLE cm_takeovers DROP COLUMN target_model')
    await db.query('DELETE FROM cm_schema WHERE version=4')
    await migrate(db)
    expect(
      (await db.query("SELECT to_regclass('cm_model_relays') AS name")).rows[0]
        .name,
    ).toBe('cm_model_relays')
    await db.query('DROP TABLE IF EXISTS cm_workspace_transfers')
    await db.query('DROP INDEX IF EXISTS cm_sessions_adapter')
    await db.query(
      'DROP TABLE cm_archive_entries, cm_archive_blocks, cm_archives',
    )
    await db.query('DELETE FROM cm_schema WHERE version>=6')
    await db.query('DROP TABLE IF EXISTS cm_pairings,cm_device_credentials')
    await db.query('DELETE FROM cm_schema WHERE version=5')
    await db.query('DROP TABLE cm_model_relays')
    await db.query('ALTER TABLE cm_sessions DROP COLUMN active_model_relay')
    await db.query('DELETE FROM cm_schema WHERE version=4')
    await db.query('DROP TABLE cm_takeovers')
    await db.query('DELETE FROM cm_schema WHERE version=3')
    await migrate(db)
    expect(
      (await db.query("SELECT to_regclass('cm_takeovers') AS name")).rows[0]
        .name,
    ).toBe('cm_takeovers')
    expect((await db.query('SELECT event FROM cm_events')).rows[0].event).toBe(
      'original history',
    )
    await db.query('INSERT INTO cm_schema VALUES(999)')
    await expect(migrate(db)).rejects.toThrow('unsupported')
    expect(
      (await db.query('SELECT count(*) AS n FROM cm_events')).rows[0].n,
    ).toBe('1')
  } finally {
    await db.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})

it('upgrades schema 7 with existing device identities and preserves native history', async () => {
  const connectionString = inject('databaseUrl'),
    admin = new Pool({ connectionString }),
    schema = 'migration_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA ${schema}`)
  const db = new Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await migrate(db)
    await db.query(
      'DROP TABLE cm_archive_entries, cm_archive_blocks, cm_archives',
    )
    await db.query('DELETE FROM cm_schema WHERE version>=8')
    await db.query('ALTER TABLE cm_sessions DROP COLUMN successor_session')
    await db.query('ALTER TABLE cm_nodes DROP COLUMN device_id')
    await db.query(
      'ALTER TABLE cm_handoffs DROP COLUMN target_session, DROP COLUMN execution, DROP COLUMN execution_operation, DROP COLUMN execution_turn, DROP COLUMN source_stop_claimed',
    )
    const nodeId = randomUUID(),
      instance = randomUUID()
    await db.query(
      "INSERT INTO cm_nodes(namespace,id,instance_id,name,capabilities) VALUES('legacy',$1,$2,'Existing laptop','{}')",
      [nodeId, instance],
    )
    await db.query(
      `INSERT INTO cm_sessions(namespace,id,adapter,incarnation,header,inherited_count,creator_instance) VALUES('legacy','old-codex','codex',$1,'{"id":"old-codex","version":1}',0,$2)`,
      [randomUUID(), instance],
    )
    await db.query(
      `INSERT INTO cm_events(namespace,session_id,seq,event) VALUES('legacy','old-codex',0,'native original')`,
    )
    await Promise.all([migrate(db), migrate(db)])
    expect(
      (await db.query('SELECT max(version) AS v FROM cm_schema')).rows[0].v,
    ).toBe(STORAGE_SCHEMA_VERSION)
    expect((await db.query('SELECT id,device_id FROM cm_nodes')).rows).toEqual([
      { id: nodeId, device_id: nodeId },
    ])
    expect((await db.query('SELECT event FROM cm_events')).rows).toEqual([
      { event: 'native original' },
    ])
    expect(
      (await db.query('SELECT adapter,successor_session FROM cm_sessions'))
        .rows,
    ).toEqual([{ adapter: 'codex', successor_session: null }])
  } finally {
    await db.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})

it('migrates schema 8 to chunked archives without rewriting existing archive bodies', async () => {
  const connectionString = inject('databaseUrl')
  const admin = new Pool({ connectionString })
  const schema = 'migration_' + randomUUID().replaceAll('-', '')
  await admin.query(`CREATE SCHEMA ${schema}`)
  const db = new Pool({ connectionString, options: `-c search_path=${schema}` })
  try {
    await migrate(db)
    await db.query(
      'DROP TABLE cm_archive_entries, cm_archive_blocks, cm_archives',
    )
    await db.query('DELETE FROM cm_schema WHERE version=9')
    const id = 'codex:gui:legacy-fixture'
    const header = JSON.stringify({
      id,
      version: 1,
      portable: { messages: [{ role: 'user', text: 'Legacy text' }] },
    })
    await db.query(
      "INSERT INTO cm_sessions(namespace,id,adapter,incarnation,header,inherited_count,creator_instance) VALUES('legacy',$1,'codex',$2,$3,0,$4)",
      [id, randomUUID(), header, randomUUID()],
    )
    await db.query(
      "INSERT INTO cm_events(namespace,session_id,seq,event) VALUES('legacy',$1,0,'legacy archive event')",
      [id],
    )
    await Promise.all([migrate(db), migrate(db)])
    expect(
      (await db.query('SELECT header FROM cm_sessions')).rows[0]?.header,
    ).toBe(header)
    expect((await db.query('SELECT event FROM cm_events')).rows[0]?.event).toBe(
      'legacy archive event',
    )
    expect(
      (await db.query('SELECT count(*) AS n FROM cm_archive_blocks')).rows[0]
        ?.n,
    ).toBe('0')
  } finally {
    await db.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
