import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it, expect } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fixture, TOKEN } from '../fixture.js'
import { codexModel } from '../helpers/codex-model.js'
import { NativeCodex } from '../../packages/adapter-codex/src/native.js'
import { CodexSharedSync } from '../../packages/adapter-codex/src/shared-sync.js'
import { SharedFollowers } from '../../packages/client/src/shared-follow.js'

it.skipIf(!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'captures real Codex hooks and automatically follows messages and tool results',
  async () => {
    const f = await fixture(),
      root = await realpath(await mkdtemp(join(tmpdir(), 'cm-live-hooks-')))
    f.defer(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'codex'),
      project = join(root, 'project')
    await mkdir(project)
    const model = await codexModel(home, true)
    f.defer(() => model.app.close())
    const options = {
      connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
      stateDir: join(root, 'sync'),
      native: {
        executable: process.env.CONTEXTMESH_TEST_CODEX_BIN,
        args: ['--dangerously-bypass-hook-trust'],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CODEX_HOME: home,
          TMPDIR: process.env.TMPDIR,
        },
        timeoutMs: 15000,
      },
    }
    const path = join(root, 'options.json')
    await writeFile(path, JSON.stringify(options), { mode: 0o600 })
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
    const command = [
      process.execPath,
      '--import',
      resolve('node_modules/tsx/dist/loader.mjs'),
      resolve('tests/helpers/shared-hook.ts'),
      path,
    ]
      .map(quote)
      .join(' ')
    // This isolated home contains only the vetted test hook. Never change the user's hook trust settings.
    await writeFile(
      join(home, 'hooks.json'),
      JSON.stringify({
        hooks: Object.fromEntries(
          [
            'UserPromptSubmit',
            'PreToolUse',
            'PostToolUse',
            'Stop',
            'Interrupt',
          ].map((name) => [
            name,
            [{ hooks: [{ type: 'command', command, timeout: 10 }] }],
          ]),
        ),
      }),
    )
    const native = new NativeCodex(options.native)
    f.defer(() => native.close())
    await native.init()
    const target = await native.start({
      cwd: project,
      model: 'gpt-6.1-sol',
      sandbox: 'read-only',
    })
    await native.inject(target.threadId, {
      version: 1,
      source: {
        adapter: 'codex',
        id: target.threadId,
        incarnation: target.threadId,
        eventCount: 1,
      },
      messages: [{ role: 'user', text: 'Synthetic saved baseline' }],
    })
    const sync = new CodexSharedSync(options)
    const share = await sync.share(
      target.threadId,
      'Native hooks fixture',
      'full',
    )
    await sync.tick()
    const follower = new SharedFollowers(sync.client, join(root, 'receiver'))
    await follower.follow(share.id)
    follower.start()
    f.defer(() => follower.close())
    const abort = new AbortController()
    const running = sync.run(abort.signal)
    f.defer(async () => {
      abort.abort()
      await running
    })
    await native.close()
    const turn = promisify(execFile)(
      options.native.executable!,
      [
        '--dangerously-bypass-hook-trust',
        '--sandbox',
        'read-only',
        '--ask-for-approval',
        'never',
        'exec',
        'resume',
        '--skip-git-repo-check',
        '--json',
        target.threadId,
        'Run the isolated fixture tool and report its result.',
      ],
      { cwd: project, env: options.native.env, timeout: 30000 },
    )
    void turn.catch(() => {})
    await expect
      .poll(
        async () =>
          (await follower.list())[0]?.records.some(
            (r) => r.status === 'running',
          ),
        { timeout: 15000 },
      )
      .toBe(true)
    expect((await turn).stdout).toContain('turn.completed')
    await expect
      .poll(async () => (await sync.client.pull(share.id)).share.activity, {
        timeout: 15000,
      })
      .toBe('idle')
    await expect
      .poll(
        async () =>
          (await follower.list())[0]?.records.some(
            (r) => r.role === 'assistant',
          ),
        { timeout: 10000 },
      )
      .toBe(true)
    const records = (await follower.list())[0]!.records
    expect(records.filter((r) => r.role === 'reference')).toHaveLength(1)
    const tool = records.find((r) => r.role === 'reference')!
    expect(tool.status).toBe('completed')
    expect((await sync.client.text(share.id, tool.seq)).text).toContain(
      'live-probe-output',
    )
  },
  60000,
)
