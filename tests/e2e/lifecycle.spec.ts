import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { fixture, TOKEN } from '../fixture.js'

const resultSchema = z.object({
  contextmeshLifecycle: z.literal(true),
  scenario: z.string(),
  checks: z.array(z.string()),
  error: z.string().optional(),
})

async function environment() {
  const f = await fixture()
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'contextmesh-lifecycle-')),
  )
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const target = join(root, 'target')
  await mkdir(source)
  await mkdir(target)
  const id = randomUUID()

  const run = async (
    scenario: string,
    profile: 'sdk-minimal' | 'web' = 'sdk-minimal',
  ) => {
    const home = await mkdtemp(join(root, 'home-'))
    const patch = join(home, 'lifecycle.yml')
    const provider = pathToFileURL(
      resolve('packages/adapter-deepseek/dist/index.js'),
    ).href
    const probe = pathToFileURL(
      resolve('tests/helpers/lifecycle-probe.ts'),
    ).href
    await writeFile(
      patch,
      `- id: ${profile === 'web' ? 'session-persistence-jsonl' : 'sessions'}
  disabled: true
- id: agent-loop
  inject: [sessionPersistence]
${profile === 'web' ? '- id: hmr\n  disabled: true\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n' : ''}- insert:
    - id: contextmesh
      name: ${JSON.stringify(provider)}
      config:
        endpoint: ${JSON.stringify(f.endpoint)}
        tokenEnv: CONTEXTMESH_TOKEN
    - id: lifecycle-probe
      name: ${JSON.stringify(probe)}
`,
    )
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx/esm',
        'node_modules/@deepseek-ai/dsh/lib/bin.js',
        '--profile',
        profile,
        '--patch',
        patch,
        ...(profile === 'web' ? ['--no-open', '--port', '0'] : []),
      ],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          SystemRoot: process.env.SystemRoot,
          DSH_HOME: home,
          CONTEXTMESH_TOKEN: TOKEN,
          DEEPSEEK_API_KEY: 'contextmesh-test-no-external-model',
          DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
          LIFECYCLE_SCENARIO: scenario,
          LIFECYCLE_SOURCE: source,
          LIFECYCLE_TARGET: target,
          TEST_SESSION_ID: id,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
    let diagnostics = ''
    child.stderr.on('data', (data) => {
      diagnostics = (diagnostics + String(data)).slice(-16000)
    })
    const lines = createInterface({ input: child.stdout })
    let closed!: () => void
    const completion = new Promise<void>((accept) => {
      closed = accept
    })
    child.once('close', () => closed())
    const result = new Promise<z.infer<typeof resultSchema>>(
      (accept, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`DSH ${scenario} timed out: ${diagnostics}`))
        }, 30000)
        child.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          reject(
            new Error(
              `DSH ${scenario} exited ${code}/${signal}: ${diagnostics}`,
            ),
          )
        })
        lines.on('line', (line) => {
          let data: unknown
          try {
            data = JSON.parse(line)
          } catch {
            return
          }
          const parsed = resultSchema.safeParse(data)
          if (!parsed.success) return
          clearTimeout(timer)
          if (parsed.data.error !== undefined)
            reject(new Error(parsed.data.error))
          else accept(parsed.data)
        })
      },
    )
    try {
      const data = await result
      expect(data.scenario).toBe(scenario)
      return data.checks
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM')
        const timer = setTimeout(() => child.kill('SIGKILL'), 4000)
        try {
          await completion
        } finally {
          clearTimeout(timer)
        }
      } else {
        await completion
      }
      lines.close()
    }
  }
  return { ...f, id, source, target, run }
}

describe('DSH lifecycle', { timeout: 40000 }, () => {
  it('joins owned disposal, persists scope-closing events after flush, and releases the writer', async () => {
    const f = await environment()
    expect(await f.run('stop')).toEqual([
      'final-events-drained',
      'disposal-joined',
      'writer-released',
    ])
  })

  it('waits for an active model stream to settle before releasing the writer', async () => {
    const f = await environment()
    expect(await f.run('active-stop')).toEqual([
      'disposal-waits-for-active-stream',
      'aborted-turn-durable',
    ])
  })

  it('shows that cancel and flush neither release ownership nor gate new input', async () => {
    const f = await environment()
    expect(await f.run('cancel')).toEqual([
      'cancel-keeps-writer',
      'cancel-does-not-gate-new-input',
    ])
  })

  it('shows that idle can retain input which ordinary dispose discards', async () => {
    const f = await environment()
    expect(await f.run('pending')).toEqual([
      'idle-can-have-pending-input',
      'normal-dispose-clears-inbox',
    ])
  })

  it('resumes in another process with the source path missing and maps cwd before publication', async () => {
    const f = await environment()
    expect(await f.run('resume-source')).toEqual(['source-history-persisted'])
    const source = await f.client.stat(f.id)
    await rm(f.source, { recursive: true })
    expect(await f.run('resume-target')).toEqual([
      'setup-before-publication',
      'setup-flush-rejects-unpublished-session',
      'mapped-cwd',
      'history-in-request',
    ])
    const target = await f.client.stat(f.id)
    expect(target!.header).toEqual(source!.header)
    expect(target!.nextSeq).toBeGreaterThan(source!.nextSeq)
  })

  it('leaves unpublished setup events uncommitted and releases ownership after setup rejects', async () => {
    const f = await environment()
    expect(await f.run('setup-failure')).toEqual([
      'setup-failure-releases-writer',
      'unpublished-setup-events-not-committed',
    ])
  })

  it('rejects disposal when the remote close cannot be confirmed', async () => {
    const f = await environment()
    const failure = vi
      .spyOn(f.store, 'close')
      .mockRejectedValue(new Error('injected close failure'))
    try {
      expect(await f.run('close-failure')).toEqual([
        'close-failure-rejects-disposal',
      ])
      await expect(f.client.open(f.id, 'write')).rejects.toMatchObject({
        code: 'ALREADY_OWNED',
      })
    } finally {
      failure.mockRestore()
    }
  })

  it('joins admitted native activities while freezing new commands', async () => {
    const f = await environment()
    expect(await f.run('activity-gate')).toEqual([
      'admitted-activity-joined',
      'new-activity-frozen',
    ])
  })

  it('joins an in-flight create before stopping a frozen session', async () => {
    const f = await environment()
    expect(await f.run('creation-race')).toEqual([
      'inflight-create-drained-before-stop',
    ])
  })
  it('freezes native Web input, stops its actual owner and permits controlled restoration', async () => {
    const f = await environment()
    expect(await f.run('web-control', 'web')).toEqual([
      'web-owner-stopped',
      'all-input-paths-frozen',
      'controlled-resume',
    ])
  })
  it('characterizes the real Web controller owner without treating cancel as disposal', async () => {
    const f = await environment()
    expect(await f.run('web', 'web')).toEqual([
      'web-returns-no-owned-handle',
      'web-cancel-keeps-writer',
    ])
  }, 40000)
})
