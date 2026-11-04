import { test, expect, inject, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { PostgresStore } from '../../packages/storage-postgres/src/index.js'
import { buildServer } from '../../apps/server/src/app.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { initServer } from '../../packages/runtime-manager/src/server.js'
import {
  backupServer,
  restoreServer,
} from '../../packages/runtime-manager/src/server-upgrade.js'
import { atomicJson } from '../../packages/runtime-manager/src/files.js'

test.runIf(!!process.env.CONTEXTMESH_TEST_PG_BIN)(
  'PostgreSQL archive restores acknowledged history and keeps maintenance closed',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'cm-backup-')),
      name = 'backup_' + randomUUID().replaceAll('-', '')
    const connection = new URL(inject('databaseUrl')),
      admin = new pg.Pool({ connectionString: connection.href })
    const token = 'backup-test-credential-at-least-24-characters'
    let store: PostgresStore | undefined,
      app: ReturnType<typeof buildServer> | undefined
    try {
      await admin.query(`CREATE DATABASE ${name}`)
      connection.pathname = '/' + name
      store = new PostgresStore({ connectionString: connection.href })
      await store.init()
      app = buildServer({ store, token, namespace: 'archive-test' })
      const endpoint = await app.listen({ host: '127.0.0.1', port: 0 }),
        client = new MeshClient({ endpoint, token })
      const deployment = join(root, 'deployment')
      await initServer(
        deployment,
        'example/server@sha256:' + 'a'.repeat(64),
        endpoint,
      )
      await atomicJson(join(deployment, 'owner-connection.json'), {
        version: 1,
        endpoint,
        token,
        nodeId: randomUUID(),
        name: 'fixture',
      })
      // Substitute only the Docker command transport. pg_dump/pg_restore/psql are real.
      const pgBin = process.env.CONTEXTMESH_TEST_PG_BIN!
      const bin = join(root, 'bin')
      await mkdir(bin)
      const wrapper = `#!${process.execPath}\nconst {spawn}=require('node:child_process');const a=process.argv.slice(2);if(a.includes('ps')){console.log('postgres');process.exit(0)}const i=a.findIndex(x=>['pg_dump','pg_restore','psql'].includes(x));if(i<0)process.exit(2);const args=a.slice(i+1);const d=args.indexOf('-d');if(d>=0)args[d+1]=${JSON.stringify(name)};if(a[i]==='pg_restore'&&args.includes('--list')){}else args.push('--host',${JSON.stringify(connection.hostname)},'--port',${JSON.stringify(connection.port)},'--username',${JSON.stringify(decodeURIComponent(connection.username))});const c=spawn(${JSON.stringify(pgBin)}+'/'+a[i],args,{stdio:'inherit',env:{...process.env,PGPASSWORD:${JSON.stringify(decodeURIComponent(connection.password))}}});c.on('error',()=>process.exit(2));c.on('exit',n=>process.exit(n??1));\n`
      await writeFile(join(bin, 'docker'), wrapper, { mode: 0o700 })
      vi.stubEnv('PATH', bin + ':' + process.env.PATH)
      const id = randomUUID(),
        h = await client.create(
          { id, version: 4, createdAt: 1, isSeeded: false },
          0,
        )
      const events = [
        { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
      ]
      await client.append(h, events, randomUUID())
      await client.flush(h, randomUUID())
      await client.request('/v1/admin/maintenance', { enabled: true })
      await expect(backupServer(deployment)).rejects.toThrow('stop all clients')
      await client.close(h, randomUUID())
      const backup = await backupServer(deployment)
      expect(
        JSON.parse(
          await readFile(join(backup.directory, 'backup.json'), 'utf8'),
        ).verified,
      ).toBe(true)
      await client.request('/v1/admin/maintenance', { enabled: false })
      const extra = await client.create(
        { id: randomUUID(), version: 4, createdAt: 2, isSeeded: false },
        0,
      )
      await client.close(extra, randomUUID())
      await app.close()
      app = undefined
      await store.stop()
      store = undefined
      expect(await restoreServer(deployment, backup.directory)).toMatchObject({
        restored: true,
        apiStarted: false,
        maintenance: true,
      })
      const check = new pg.Pool({ connectionString: connection.href })
      try {
        expect((await check.query('SELECT id FROM cm_sessions')).rows).toEqual([
          { id },
        ])
        expect(
          (await check.query('SELECT count(*)::int AS count FROM cm_events'))
            .rows[0].count,
        ).toBe(1)
        expect(
          (await check.query('SELECT enabled FROM cm_maintenance')).rows[0]
            .enabled,
        ).toBe(true)
      } finally {
        await check.end()
      }
    } finally {
      vi.unstubAllEnvs()
      await app?.close()
      await store?.stop()
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
      await rm(root, { recursive: true, force: true })
    }
  },
  30000,
)
