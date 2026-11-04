import { listenLocal } from '../../handoff-deepseek/src/local-control.js'
import { sha256 } from './manifest.js'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { readFile, writeFile, open, cp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { privateDirectory, atomicJson, optionalJson } from './files.js'
import { readConnection } from '../../client/src/config.js'
import { MeshClient } from '../../client/src/index.js'
const exec = promisify(execFile)
const deployment = z.object({
  version: z.literal(1),
  image: z.string(),
  endpoint: z.string(),
  postgresMajor: z.literal(18),
})
const digest = /^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/
async function compose(root: string, args: string[]) {
  return exec('docker', ['compose', '--project-directory', root, ...args], {
    timeout: 180000,
    maxBuffer: 1024 * 1024,
  })
}
async function backupAction(directory: string) {
  const root = resolve(directory),
    config = deployment.parse(await optionalJson(join(root, 'server.json')))
  const credential = await readConnection(join(root, 'owner-connection.json'))
  if (!credential) throw new Error('Owner connection missing')
  const mesh = new MeshClient({ ...credential, retries: 0 })
  const state = (await mesh.request('/v1/admin/maintenance')) as {
    enabled: boolean
    writers: number
    unresolved: number
    takeovers: number
  }
  if (!state.enabled || state.writers || state.unresolved || state.takeovers)
    throw new Error(
      'Enable maintenance and stop all clients; unresolved or expired writers must be explicitly recovered first',
    )
  const target = join(root, 'backups', randomUUID())
  await privateDirectory(target)
  for (const file of [
    '.env',
    'compose.yaml',
    'server.json',
    'owner-connection.json',
  ])
    await cp(join(root, file), join(target, file))
  await cp(join(root, 'Caddyfile'), join(target, 'Caddyfile')).catch(
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  const dump = await open(join(target, 'database.dump'), 'wx', 0o600)
  const child = spawn(
    'docker',
    [
      'compose',
      '--project-directory',
      root,
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      'contextmesh',
      '-d',
      'contextmesh',
      '-Fc',
    ],
    { stdio: ['ignore', dump.fd, 'pipe'] },
  )
  const code = await new Promise<number | null>((ok, fail) => {
    child.once('exit', ok)
    child.once('error', fail)
  })
  await dump.close()
  if (code !== 0)
    throw new Error('Database backup failed; maintenance remains enabled')
  // Validate the archive with the same PostgreSQL major version before marking it usable.
  const verify = spawn(
    'docker',
    [
      'compose',
      '--project-directory',
      root,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--list',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  const bytes = await readFile(join(target, 'database.dump'))
  verify.stdin!.end(bytes)
  const valid = await new Promise<number | null>((ok, fail) => {
    verify.once('exit', ok)
    verify.once('error', fail)
  })
  if (valid !== 0) throw new Error('Database backup verification failed')
  await atomicJson(join(target, 'backup.json'), {
    verified: true,
    postgresMajor: config.postgresMajor,
    image: config.image,
    createdAt: new Date().toISOString(),
    schema: 6,
    sha256: sha256(bytes),
  })
  return { directory: target, verified: true }
}
async function maintenanceAction(directory: string, enabled: boolean) {
  const credential = await readConnection(
    join(resolve(directory), 'owner-connection.json'),
  )
  if (!credential) throw new Error('Owner connection missing')
  return new MeshClient({ ...credential, retries: 0 }).request(
    '/v1/admin/maintenance',
    { enabled },
  )
}
async function upgradeAction(directory: string, image: string) {
  const root = resolve(directory)
  if (!digest.test(image))
    throw new Error('Pin the target image by sha256 digest')
  const config = deployment.parse(await optionalJson(join(root, 'server.json')))
  // Prepare the image before changing service availability. PostgreSQL image is never changed here.
  await exec('docker', ['pull', image], {
    timeout: 300000,
    maxBuffer: 1024 * 1024,
  })
  const metadata = await exec(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--entrypoint',
      'node',
      image,
      '-e',
      "console.log(require('fs').readFileSync('/app/server-release.json','utf8'))",
    ],
    { timeout: 30000 },
  )
  z.object({
    schema: z.literal(6),
    protocol: z.literal(1),
    postgresMajor: z.literal(18),
  }).parse(JSON.parse(metadata.stdout))
  const prior = (await optionalJson(join(root, 'upgrade.json'))) as
    { phase?: string } | undefined
  if (prior && !['verified', 'rolled-back'].includes(prior.phase ?? ''))
    throw new Error(
      'An interrupted server upgrade is recorded. Keep maintenance enabled and inspect upgrade.json before restoring or resuming the recorded image.',
    )
  await maintenanceAction(root, true)
  const backup = await backupAction(root)
  const journal = {
    id: randomUUID(),
    from: config.image,
    to: image,
    backup: backup.directory,
    phase: 'prepared',
  }
  await atomicJson(join(root, 'upgrade.json'), journal)
  await compose(root, ['stop', 'api'])
  journal.phase = 'stopped'
  await atomicJson(join(root, 'upgrade.json'), journal)
  const original = await readFile(join(root, 'compose.yaml'), 'utf8')
  if (!original.includes('    image: ' + config.image + '\n'))
    throw new Error('Compose image differs from the deployment record')
  await writeFile(
    join(root, 'compose.yaml'),
    original.replace(
      '    image: ' + config.image + '\n',
      '    image: ' + image + '\n',
    ),
    { mode: 0o600 },
  )
  journal.phase = 'switched'
  await atomicJson(join(root, 'upgrade.json'), journal)
  try {
    await compose(root, ['up', '-d', '--wait', 'api'])
    const credential = await readConnection(join(root, 'owner-connection.json'))
    const health = (await new MeshClient({
      ...credential!,
      retries: 0,
    }).request('/health/ready')) as { schemaVersion: number }
    if (health.schemaVersion !== 6)
      throw new Error(
        'Schema changed; keep maintenance enabled and review the backup before any restoration',
      )
    await atomicJson(join(root, 'server.json'), { ...config, image })
    journal.phase = 'verified'
    await atomicJson(join(root, 'upgrade.json'), journal)
    // Explicit leave-maintenance is intentional: inspect clients before admitting new writers.
    return { image, backup: backup.directory, maintenance: true }
  } catch (error) {
    journal.phase = 'attention'
    await atomicJson(join(root, 'upgrade.json'), journal)
    throw error
  }
}

/** Explicit disaster recovery only; never used by automatic runtime rollback. */
async function restoreAction(directory: string, backupDirectory: string) {
  const root = resolve(directory),
    backup = resolve(backupDirectory)
  const record = z
    .object({
      verified: z.literal(true),
      postgresMajor: z.literal(18),
      schema: z.literal(6),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .parse(await optionalJson(join(backup, 'backup.json')))
  deployment.parse(await optionalJson(join(root, 'server.json')))
  const running = (
    await compose(root, ['ps', '--status', 'running', '--services'])
  ).stdout
    .trim()
    .split('\n')
  if (running.includes('api'))
    throw new Error('Stop the API and every client before restoring a database')
  const peers = await compose(root, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'contextmesh',
    '-d',
    'contextmesh',
    '-Atc',
    "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
  ])
  if (Number(peers.stdout.trim()) !== 0)
    throw new Error(
      'Other database clients are still connected; restoration is blocked',
    )
  const dump = await readFile(join(backup, 'database.dump'))
  if (sha256(dump) !== record.sha256)
    throw new Error('Backup checksum does not match')
  const restore = spawn(
    'docker',
    [
      'compose',
      '--project-directory',
      root,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'contextmesh',
      '-d',
      'contextmesh',
      '--clean',
      '--if-exists',
      '--single-transaction',
      '--exit-on-error',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  restore.stdin!.end(dump)
  const code = await new Promise<number | null>((ok, fail) => {
    restore.once('exit', ok)
    restore.once('error', fail)
  })
  if (code !== 0) throw new Error('Database restore failed and was rolled back')
  // Backup is taken behind maintenance. Keep that gate closed after restore.
  await compose(root, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'contextmesh',
    '-d',
    'contextmesh',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'UPDATE cm_maintenance SET enabled=true',
  ])
  for (const name of [
    '.env',
    'compose.yaml',
    'server.json',
    'owner-connection.json',
  ])
    await cp(join(backup, name), join(root, name))
  await cp(join(backup, 'Caddyfile'), join(root, 'Caddyfile')).catch(
    (error) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
  return {
    restored: true,
    postgresMajor: record.postgresMajor,
    apiStarted: false,
    maintenance: true,
  }
}

async function resumeAction(directory: string) {
  const root = resolve(directory)
  const journal = z
    .object({
      id: z.uuid(),
      from: z.string().regex(digest),
      to: z.string().regex(digest),
      backup: z.string(),
      phase: z.enum(['prepared', 'stopped', 'switched', 'attention']),
    })
    .parse(await optionalJson(join(root, 'upgrade.json')))
  const config = deployment.parse(await optionalJson(join(root, 'server.json')))
  const metadata = await exec(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--entrypoint',
      'node',
      journal.to,
      '-e',
      "console.log(require('fs').readFileSync('/app/server-release.json','utf8'))",
    ],
    { timeout: 30000 },
  )
  z.object({
    schema: z.literal(6),
    protocol: z.literal(1),
    postgresMajor: z.literal(18),
  }).parse(JSON.parse(metadata.stdout))
  const backup = z
    .object({ verified: z.literal(true), sha256: z.string() })
    .parse(await optionalJson(join(journal.backup, 'backup.json')))
  if (
    sha256(await readFile(join(journal.backup, 'database.dump'))) !==
    backup.sha256
  )
    throw new Error('Recorded backup checksum does not match')
  // Query PostgreSQL directly because the API may have been stopped at the recorded phase.
  const state = await compose(root, [
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'contextmesh',
    '-d',
    'contextmesh',
    '-Atc',
    'SELECT (SELECT max(version) FROM cm_schema)=6 AND COALESCE((SELECT bool_and(enabled) FROM cm_maintenance),false) AND NOT EXISTS(SELECT 1 FROM cm_sessions WHERE active_handle IS NOT NULL)',
  ])
  if (state.stdout.trim() !== 't')
    throw new Error(
      'Resume requires schema 6, maintenance enabled, and no writers',
    )
  await compose(root, ['stop', 'api'])
  const text = await readFile(join(root, 'compose.yaml'), 'utf8')
  if (
    !text.includes('    image: ' + journal.to + '\n') &&
    !text.includes('    image: ' + journal.from + '\n')
  )
    throw new Error('Compose was changed outside this upgrade')
  await writeFile(
    join(root, 'compose.yaml'),
    text.replace(
      '    image: ' + journal.from + '\n',
      '    image: ' + journal.to + '\n',
    ),
    { mode: 0o600 },
  )
  await compose(root, ['up', '-d', '--wait', 'api'])
  await atomicJson(join(root, 'server.json'), { ...config, image: journal.to })
  await atomicJson(join(root, 'upgrade.json'), {
    ...journal,
    phase: 'verified',
  })
  return { image: journal.to, maintenance: true, resumed: true }
}

async function withDeploymentLock<T>(directory: string, run: () => Promise<T>) {
  const root = resolve(directory)
  await privateDirectory(join(root, '.operation'))
  const lock = await listenLocal(join(root, '.operation'), async () => ({
    busy: true,
  }))
  try {
    return await run()
  } finally {
    await lock.close()
  }
}
export const backupServer = (directory: string) =>
  withDeploymentLock(directory, () => backupAction(directory))
export const serverMaintenance = (directory: string, enabled: boolean) =>
  withDeploymentLock(directory, () => maintenanceAction(directory, enabled))
export const upgradeServer = (directory: string, image: string) =>
  withDeploymentLock(directory, () => upgradeAction(directory, image))
export const restoreServer = (directory: string, backup: string) =>
  withDeploymentLock(directory, () => restoreAction(directory, backup))
export const resumeServerUpgrade = (directory: string) =>
  withDeploymentLock(directory, () => resumeAction(directory))
