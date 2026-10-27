import { it, expect, inject } from 'vitest'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'

it('restores a built plugin in a fresh process after restarting the built HTTP server', async () => {
  const probe = createServer()
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('missing port')
  const port = address.port
  await new Promise<void>((r) => probe.close(() => r()))
  const id = randomUUID(),
    endpoint = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    DATABASE_URL: inject('databaseUrl'),
    CONTEXTMESH_TOKEN: TOKEN,
    CONTEXTMESH_NAMESPACE: `e2e-${randomUUID()}`,
    CONTEXTMESH_PORT: String(port),
    CONTEXTMESH_ENDPOINT: endpoint,
    TEST_SESSION_ID: id,
  }
  const launch = async () => {
    const child = spawn(process.execPath, ['dist/server.js'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', (d) => {
      errors += String(d)
    })
    child.stdout.resume()
    await expect
      .poll(
        async () => {
          if (child.exitCode !== null)
            throw new Error(`server exited: ${errors}`)
          return fetch(`${endpoint}/health/ready`, {
            headers: { authorization: `Bearer ${TOKEN}` },
          })
            .then((r) => r.status)
            .catch(() => 0)
        },
        { timeout: 10000 },
      )
      .toBe(200)
    return child
  }
  const stop = async (child: ReturnType<typeof spawn>) => {
    if (child.exitCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('server shutdown timed out'))
      }, 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      child.kill('SIGTERM')
    })
  }
  const run = promisify(execFile)
  let server = await launch()
  try {
    const first = await run(
      process.execPath,
      ['--import', 'tsx', 'tests/helpers/session-worker.ts', 'write'],
      { env },
    )
    expect(JSON.parse(first.stdout)).toEqual({ written: 2 })
    await stop(server)
    server = await launch()
    const second = await run(
      process.execPath,
      ['--import', 'tsx', 'tests/helpers/session-worker.ts', 'resume'],
      { env },
    )
    expect(JSON.parse(second.stdout)).toEqual({
      restored: 2,
      total: 5,
      seqs: [0, 1, 2, 3, 4],
    })
    const client = new MeshClient({ endpoint, token: TOKEN })
    expect((await client.stat(id))?.nextSeq).toBe(5)
  } finally {
    await stop(server)
  }
}, 30000)
