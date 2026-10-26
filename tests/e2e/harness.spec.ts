import { it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fixture, TOKEN } from '../fixture.js'

it('loads the built provider in the official SDK profile and resumes through the real agent-loop', async () => {
  const f = await fixture(),
    home = await mkdtemp(join(tmpdir(), 'contextmesh-harness-'))
  const patch = join(home, 'remote.yml')
  const id = randomUUID()
  await writeFile(
    patch,
    `- id: sessions\n  disabled: true\n- id: agent-loop\n  inject: [sessionPersistence]\n- id: sdk-jsonrpc-server\n  inject: [sdkAppStartup, loader, sessionPersistence]\n- insert:\n    - id: contextmesh\n      name: ${JSON.stringify(pathToFileURL(resolve('packages/adapter-deepseek/dist/index.js')).href)}\n      config:\n        endpoint: ${JSON.stringify(f.endpoint)}\n        tokenEnv: CONTEXTMESH_TOKEN\n`,
  )
  const launch = () => {
    const child = spawn(
      process.execPath,
      [
        'node_modules/@deepseek-ai/dsh/lib/bin.js',
        '--profile',
        'sdk-minimal',
        '--patch',
        patch,
      ],
      {
        env: {
          ...process.env,
          DSH_HOME: home,
          CONTEXTMESH_TOKEN: TOKEN,
          DEEPSEEK_API_KEY: 'contextmesh-test-no-model-requests',
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let stderr = '',
      nextId = 0
    const pending = new Map<
      number,
      { resolve: (data: unknown) => void; reject: (e: Error) => void }
    >()
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      let msg: { id?: number; result?: unknown; error?: unknown }
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.id === undefined) return
      const waiter = pending.get(msg.id)
      if (!waiter) return
      pending.delete(msg.id)
      if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)))
      else waiter.resolve(msg.result)
    })
    child.on('exit', (code) => {
      for (const p of pending.values())
        p.reject(new Error(`Harness exited ${code}: ${stderr}`))
      pending.clear()
    })
    const rpc = (method: string, params?: unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`Harness ${method} timed out: ${stderr}`))
        }, 12000)
        pending.set(id, {
          resolve: (data) => {
            clearTimeout(timer)
            resolve(data)
          },
          reject: (e) => {
            clearTimeout(timer)
            reject(e)
          },
        })
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n',
        )
      })
    const stop = async () => {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          r()
        }, 2000)
        child.once('exit', () => {
          clearTimeout(t)
          r()
        })
      })
    }
    return { child, rpc, stop, diagnostics: () => stderr }
  }
  let runtime = launch()
  try {
    await runtime.rpc('initialize', {
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    await runtime.rpc('session/working-directory/get', { sessionId: id })
    await runtime.rpc('session/working-directory/set', {
      sessionId: id,
      path: home,
    })
    await runtime.rpc('session/wait', { sessionId: id })
    await runtime.rpc('shutdown')
    await expect.poll(() => runtime.child.exitCode, { timeout: 5000 }).toBe(0)
    const first = await f.client.stat(id)
    expect(first?.materialized, runtime.diagnostics()).toBe(true)
    const firstCount = first!.nextSeq
    runtime = launch()
    await runtime.rpc('initialize', {
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-chat',
    })
    await runtime.rpc('session/resume', { sessionId: id })
    await runtime.rpc('session/wait', { sessionId: id })
    await runtime.rpc('shutdown')
    await expect.poll(() => runtime.child.exitCode, { timeout: 5000 }).toBe(0)
    expect((await f.client.stat(id))!.nextSeq).toBeGreaterThan(firstCount)
  } finally {
    await runtime.stop()
    await rm(home, { recursive: true, force: true })
  }
}, 40000)
