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
    ).toBe(6)
    expect(
      (await db.query('SELECT active_handoff,header FROM cm_sessions')).rows[0],
    ).toEqual({ active_handoff: null, header: '{"id":"session","version":4}' })
    expect((await db.query('SELECT event FROM cm_events')).rows[0].event).toBe(
      'original history',
    )
    // Exercise a direct upgrade from the previous schema-2 boundary as well.
    await db.query('DROP TABLE IF EXISTS cm_workspace_transfers')
    await db.query('DELETE FROM cm_schema WHERE version=6')
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
    await db.query('DELETE FROM cm_schema WHERE version=6')
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
