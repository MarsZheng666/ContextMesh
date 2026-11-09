import { STORAGE_SCHEMA_VERSION } from '../../packages/protocol/src/index.js'
import { test, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixture, TOKEN } from '../fixture.js'
import { initServer } from '../../packages/runtime-manager/src/server.js'
import {
  upgradeServer,
  backupServer,
} from '../../packages/runtime-manager/src/server-upgrade.js'
import { atomicJson } from '../../packages/runtime-manager/src/files.js'

test('rejects a schema-changing image before maintenance or stopping the service', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'cm-schema-upgrade-'))
  const image = 'example/server@sha256:' + 'a'.repeat(64)
  try {
    await initServer(root, image, f.endpoint)
    await atomicJson(join(root, 'owner-connection.json'), {
      version: 1,
      endpoint: f.endpoint,
      token: TOKEN,
      nodeId: randomUUID(),
      name: 'fixture',
    })
    const bin = join(root, 'bin'),
      log = join(root, 'docker-calls.jsonl')
    await mkdir(bin)
    // Only image inspection is substituted; authentication and maintenance use the real API.
    await writeFile(
      join(bin, 'docker'),
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');if(a[0]==='run')console.log(JSON.stringify({schema:6,protocol:1,postgresMajor:18}));else if(a[0]!=='pull')process.exit(2);\n`,
      { mode: 0o700 },
    )
    vi.stubEnv('PATH', bin + ':' + process.env.PATH)
    const original = await readFile(join(root, 'compose.yaml'), 'utf8')
    await expect(
      upgradeServer(root, 'example/server@sha256:' + 'b'.repeat(64)),
    ).rejects.toThrow('Schema-changing upgrades')
    expect(await f.client.request('/v1/admin/maintenance')).toMatchObject({
      enabled: false,
      schema: STORAGE_SCHEMA_VERSION,
    })
    expect(await readFile(join(root, 'compose.yaml'), 'utf8')).toBe(original)
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls.map((a) => a[0])).toEqual(['pull', 'run'])
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
test('records the actual database schema in a verified backup', async () => {
  const f = await fixture()
  const root = await mkdtemp(join(tmpdir(), 'cm-schema-backup-'))
  try {
    await initServer(
      root,
      'example/server@sha256:' + 'a'.repeat(64),
      f.endpoint,
    )
    await atomicJson(join(root, 'owner-connection.json'), {
      version: 1,
      endpoint: f.endpoint,
      token: TOKEN,
      nodeId: randomUUID(),
      name: 'fixture',
    })
    const bin = join(root, 'bin')
    await mkdir(bin)
    // Archive transport is synthetic here; the real pg_dump/restore round trip has its own test.
    await writeFile(
      join(bin, 'docker'),
      `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('pg_dump'))process.stdout.write('synthetic-archive');else if(a.includes('pg_restore'))process.stdin.resume();else process.exit(2);\n`,
      { mode: 0o700 },
    )
    vi.stubEnv('PATH', bin + ':' + process.env.PATH)
    await f.client.request('/v1/admin/maintenance', { enabled: true })
    const result = await backupServer(root)
    expect(
      JSON.parse(await readFile(join(result.directory, 'backup.json'), 'utf8')),
    ).toMatchObject({ verified: true, schema: STORAGE_SCHEMA_VERSION })
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
