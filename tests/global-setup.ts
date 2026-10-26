import type { TestProject } from 'vitest/node'
import EmbeddedPostgres from 'embedded-postgres'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
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
    onLog: () => {},
    onError: (e) => errors.push(String(e)),
  })
  try {
    await db.initialise()
    await db.start()
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`test PostgreSQL startup failed: ${errors.join('\n')}`, {
      cause: error,
    })
  }
  project.provide(
    'databaseUrl',
    `postgres://contextmesh:contextmesh-tests@127.0.0.1:${port}/postgres`,
  )
  return async () => {
    await db.stop()
    await rm(dir, { recursive: true, force: true })
  }
}
declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string
  }
}
