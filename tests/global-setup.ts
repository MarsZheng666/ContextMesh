import type { TestProject } from 'vitest/node'
import EmbeddedPostgres from 'embedded-postgres'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
export default async function setup(project: TestProject) {
  if (process.env.TEST_DATABASE_URL) {
    project.provide('databaseUrl', process.env.TEST_DATABASE_URL)
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'contextmesh-test-'))
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string')
    throw new Error('missing test port')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    probe.close((e) => (e ? reject(e) : resolve())),
  )
  const errors: string[] = []
  const db = new EmbeddedPostgres({
    databaseDir: join(dir, 'db'),
    port,
    user: 'contextmesh',
    password: 'contextmesh-tests',
    persistent: true,
    createPostgresUser: false,
    postgresFlags: ['-h', '127.0.0.1'],
    initdbFlags: ['--encoding=UTF8'],
    onLog: (message) => {
      errors.push(String(message))
      if (errors.length > 50) errors.shift()
    },
    onError: (e) => errors.push(String(e)),
  })
  // pg_ctl drops administrative privileges on Windows; spawning postgres
  // directly fails under the GitHub runner's administrator account.
  const pgCtl: string | undefined =
    process.platform === 'win32'
      ? createRequire(import.meta.resolve('embedded-postgres'))(
          '@embedded-postgres/windows-x64',
        ).pg_ctl
      : undefined
  const log = join(dir, 'postgres.log')
  const stop = async () => {
    if (pgCtl) {
      await promisify(execFile)(
        pgCtl,
        ['-D', join(dir, 'db'), '-m', 'fast', '-w', 'stop'],
        { windowsHide: true },
      )
    } else await db.stop()
  }
  try {
    await db.initialise()
    if (pgCtl) {
      await promisify(execFile)(
        pgCtl,
        [
          '-D',
          join(dir, 'db'),
          '-l',
          log,
          '-o',
          `-h 127.0.0.1 -p ${port}`,
          '-w',
          'start',
        ],
        { windowsHide: true },
      )
    } else await db.start()
  } catch (error) {
    if (pgCtl) errors.push(await readFile(log, 'utf8').catch(() => ''))
    await stop().catch(() => {})
    await rm(dir, { recursive: true, force: true })
    throw new Error(
      `test PostgreSQL startup failed: ${String(error)}\n${errors.join('\n')}`,
      { cause: error },
    )
  }
  project.provide(
    'databaseUrl',
    `postgres://contextmesh:contextmesh-tests@127.0.0.1:${port}/postgres`,
  )
  return async () => {
    await stop()
    await rm(dir, { recursive: true, force: true })
  }
}
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}
