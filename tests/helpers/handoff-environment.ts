import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  realpath,
  stat,
  rm,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { fixture, TOKEN } from '../fixture.js'
import { buildServer } from '../../apps/server/src/app.js'
import { callLocal } from '../../packages/handoff-deepseek/src/local-control.js'
const execute = promisify(execFile)
const reply = z.object({
  id: z.number().optional(),
  ready: z.boolean().optional(),
  nodeId: z.string().optional(),
  ok: z.boolean().optional(),
  value: z.unknown().optional(),
  error: z.string().optional(),
})

export async function environment() {
  const f = await fixture(),
    root = await realpath(await mkdtemp(join(tmpdir(), 'contextmesh-m1-')))
  f.defer(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source'),
    target = join(root, 'target')
  await mkdir(source)
  await writeFile(join(source, 'handoff-sentinel.txt'), 'fixture-sentinel\n')
  await mkdir(join(source, 'nested'))
  await writeFile(
    join(source, 'nested', 'handoff-sentinel.txt'),
    'nested-fixture-sentinel\n',
  )
  const git = async (cwd: string, args: string[]) =>
    execute('git', ['-C', cwd, ...args], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
    })
  await git(source, ['init', '-b', 'fixture'])
  await git(source, ['add', '.'])
  await git(source, [
    '-c',
    'user.name=ContextMesh tests',
    '-c',
    'user.email=test@localhost',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-m',
    'fixture',
  ])
  await execute('git', ['clone', '--local', source, target])
  const runtimes: Array<{ stop: () => Promise<void> }> = []
  const launch = async (
    name: string,
    cwd: string,
    installed = false,
    failResume = false,
    presetMode?: 'read-only' | 'workspace-write',
    skipSourceModel = false,
  ) => {
    const home = join(root, `home-${name}`),
      stateDir = join(home, 'mesh')
    await mkdir(home, { recursive: true })
    if (installed) {
      await execute(
        process.execPath,
        [
          resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
          'plugin',
          '--profile',
          'web',
          'add',
          `link:${resolve('packages/handoff-deepseek')}`,
        ],
        { env: { ...process.env, DSH_HOME: home }, timeout: 30000 },
      )
      const manifest = JSON.parse(
        await readFile(join(home, 'profiles/web/package.json'), 'utf8'),
      )
      expect(Object.keys(manifest.dependencies)).toEqual([
        'dsh-contextmesh-handoff',
      ])
      expect(manifest.dsh.profile.bundles).not.toContain('dsh-contextmesh')
      expect(manifest.dsh.profile.bundles).toContain('dsh-contextmesh-handoff')
    }
    const plugins = installed
      ? `- id: contextmesh-session-persistence
  config: {endpoint: ${JSON.stringify(f.endpoint)}, tokenEnv: CONTEXTMESH_TOKEN, timeoutMs: 2000}
- id: contextmesh-handoff
  config: {stateDir: ${JSON.stringify(stateDir)}, nodeName: ${JSON.stringify(name)}, pollMs: 100, heartbeatMs: 1000, waitIdleMs: 2000}
`
      : `- insert:
    - id: mesh
      name: ${JSON.stringify(pathToFileURL(resolve('packages/adapter-deepseek/dist/index.js')).href)}
      config: {endpoint: ${JSON.stringify(f.endpoint)}, tokenEnv: CONTEXTMESH_TOKEN, timeoutMs: 2000}
    - id: mesh-handoff
      name: ${JSON.stringify(pathToFileURL(resolve('packages/handoff-deepseek/dist/index.js')).href)}
      config: {stateDir: ${JSON.stringify(stateDir)}, nodeName: ${JSON.stringify(name)}, pollMs: 100, heartbeatMs: 1000, waitIdleMs: 2000}
`
    const patch = join(home, 'm1.yml')
    await writeFile(
      patch,
      `- id: session-controller
  config: {backgroundActivation: false}
- id: session-persistence-jsonl
  disabled: true
- id: agent-loop
  inject: [sessionPersistence]
- id: hmr
  disabled: true
- id: webserver
  config: {host: 127.0.0.1, port: 0}
- id: sandbox-policy
  config: {mode: workspace-write}
${plugins}- insert:
    - id: handoff-worker
      name: ${JSON.stringify(pathToFileURL(resolve('tests/helpers/handoff-worker.ts')).href)}
`,
    )
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        'node_modules/@deepseek-ai/dsh/lib/bin.js',
        '--profile',
        'web',
        '--patch',
        patch,
        '--no-open',
        '--port',
        '0',
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          DSH_HOME: home,
          TEST_SKIP_SOURCE_MODEL: skipSourceModel ? '1' : undefined,
          CONTEXTMESH_TOKEN: TOKEN,
          CONTEXTMESH_TEST_REAL_MODEL: process.env.CONTEXTMESH_TEST_REAL_MODEL,
          DEEPSEEK_API_KEY:
            process.env.CONTEXTMESH_TEST_REAL_MODEL === '1'
              ? process.env.DEEPSEEK_API_KEY
              : 'test-no-external-model',
          DEEPSEEK_BASE_URL:
            process.env.CONTEXTMESH_TEST_REAL_MODEL === '1'
              ? process.env.DEEPSEEK_BASE_URL
              : 'http://127.0.0.1:1',
          TEST_PROJECT_ROOT: cwd,
          TEST_FAIL_TARGET_RESUME: failResume ? '1' : undefined,
          TEST_ISOLATED_POLICY_MODE: presetMode,
        },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      },
    )
    let diagnostics = '',
      sequence = 0
    child.stderr?.on('data', (data) => {
      diagnostics = (diagnostics + String(data)).slice(-16000)
    })
    child.stdout?.resume()
    const pending = new Map<
      number,
      { accept: (value: unknown) => void; reject: (error: Error) => void }
    >()
    let readyAccept!: (id: string) => void, readyReject!: (error: Error) => void
    const ready = new Promise<string>((accept, reject) => {
      readyAccept = accept
      readyReject = reject
    })
    const readyTimeout = setTimeout(
      () => readyReject(new Error(`DSH startup timed out: ${diagnostics}`)),
      20000,
    )
    child.on('message', (raw) => {
      const parsed = reply.safeParse(raw)
      if (!parsed.success) return
      const message = parsed.data
      if (message.ready && message.nodeId) {
        clearTimeout(readyTimeout)
        readyAccept(message.nodeId)
        return
      }
      if (message.id === undefined) return
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      if (message.ok) waiter.accept(message.value)
      else waiter.reject(new Error(message.error ?? 'worker failed'))
    })
    child.once('error', (error) => {
      clearTimeout(readyTimeout)
      readyReject(error)
    })
    const closed = new Promise<void>((accept) =>
      child.once('close', (code, signal) => {
        clearTimeout(readyTimeout)
        const error = new Error(`DSH exited ${code}/${signal}: ${diagnostics}`)
        readyReject(error)
        for (const waiter of pending.values()) waiter.reject(error)
        pending.clear()
        accept()
      }),
    )
    const stop = async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
        try {
          await closed
        } finally {
          clearTimeout(timer)
        }
      } else await closed
    }
    runtimes.push({ stop })
    const rpc = (action: string, data: Record<string, unknown> = {}) =>
      new Promise<unknown>((accept, reject) => {
        const id = ++sequence,
          timer = setTimeout(
            () => {
              pending.delete(id)
              reject(new Error(`DSH RPC ${action} timed out: ${diagnostics}`))
            },
            process.env.CONTEXTMESH_TEST_REAL_MODEL === '1' ? 120000 : 18000,
          )
        pending.set(id, {
          accept: (value) => {
            clearTimeout(timer)
            accept(value)
          },
          reject: (error) => {
            clearTimeout(timer)
            reject(error)
          },
        })
        child.send({ id, action, ...data })
      })
    return { nodeId: await ready, rpc, stateDir, stop }
  }
  return {
    ...f,
    root,
    source,
    target,
    launch,
    close: async () => {
      for (const runtime of runtimes.reverse()) await runtime.stop()
    },
  }
}
