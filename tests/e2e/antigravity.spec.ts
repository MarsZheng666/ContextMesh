import { receiveAntigravity } from '../../packages/adapter-codex/src/shared-takeover.js'
import { CodexSharedSync } from '../../packages/adapter-codex/src/shared-sync.js'
import { codexModel } from '../helpers/codex-model.js'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { environment } from '../helpers/handoff-environment.js'
import { TOKEN } from '../fixture.js'
import { AntigravityLive } from '../../apps/antigravity/src/live.js'
import { SharedClient } from '../../packages/client/src/shared.js'
import { writeConnection } from '../../packages/client/src/config.js'
import { atomicJson } from '../../packages/runtime-manager/src/files.js'

it.skipIf(!process.env.CONTEXTMESH_TEST_ANTIGRAVITY_BIN)(
  'a running DSH task continues in a signed-in native Antigravity chat and returns to DSH',
  async () => {
    const f = await environment()
    f.defer(f.close)
    const a = await f.launch('A', f.source)
    const sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    const marker = 'CM-' + randomUUID().slice(0, 8)
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember the verification marker ' + marker,
    })
    const share = (await a.rpc('m1', {
      command: {
        action: 'shared-publish',
        sessionId,
        title: 'Native handoff',
        confirmed: true,
      },
    })) as { id: string }
    await a.rpc('start-running', {
      sessionId,
      text: 'Reply with just the verification marker from the preceding message, without using tools.',
    })

    const data = join(f.root, 'antigravity-state')
    const conn = join(data, 'connection.json')
    await writeConnection(
      {
        version: 1,
        endpoint: f.endpoint,
        token: TOKEN,
        nodeId: randomUUID(),
        name: 'Test receiver',
      },
      conn,
    )
    await atomicJson(join(data, 'connection-path.json'), { path: conn })
    const receiver = new AntigravityLive(new SharedClient(f.client), data)
    const ticket = await receiver.ticket(share.id)
    // Use only this test project's hook configuration; the signed-in user's installed plugins stay separate.
    const hooksDir = join(f.target, '.agents')
    await mkdir(hooksDir)
    const hooks = await readFile(resolve('dist/antigravity/hooks.json'), 'utf8')
    const runner = join(hooksDir, 'receiver.cjs')
    await writeFile(
      runner,
      `const {spawnSync}=require('node:child_process'); const r=spawnSync(process.execPath,[${JSON.stringify(resolve('dist/antigravity/hook.mjs'))},process.argv[2]],{stdio:'inherit',env:{...process.env,CONTEXTMESH_ANTIGRAVITY_STATE:${JSON.stringify(data)}}});process.exit(r.status??1)`,
    )
    await writeFile(
      join(hooksDir, 'hooks.json'),
      JSON.stringify(
        JSON.parse(hooks, (key, value) =>
          key === 'command'
            ? value.replace(
                'node ./hook.mjs',
                '"' + process.execPath + '" "' + runner + '"',
              )
            : value,
        ),
      ),
    )
    const { stdout } = await promisify(execFile)(
      process.env.CONTEXTMESH_TEST_ANTIGRAVITY_BIN!,
      [
        '--sandbox',
        '--print-timeout',
        '90s',
        '--output-format',
        'json',
        '-p',
        ticket.prompt,
      ],
      { cwd: f.target, timeout: 100000 },
    )
    const result = JSON.parse(stdout)
    expect(
      result.response,
      JSON.stringify((await receiver.client.pull(share.id)).share),
    ).toContain(marker)
    // The CLI can print its answer before the final Stop hook acknowledges the idle boundary.
    await expect
      .poll(
        async () => {
          await receiver.tick()
          return (await receiver.client.pull(share.id)).share
        },
        { timeout: 10000 },
      )
      .toMatchObject({
        generation: 1,
        source: { adapter: 'antigravity', id: result.conversation_id },
        activity: 'idle',
      })
    const b = await f.launch('B', f.target)
    const preview = (await b.rpc('m1', {
      command: { action: 'shared-preview', id: share.id },
    })) as { generation: number; cut: number; archiveId: string }
    await b.rpc('m1', {
      command: {
        action: 'shared-takeover',
        id: share.id,
        generation: preview.generation,
        cut: preview.cut,
        sourceId: preview.archiveId,
        cwd: f.target,
        operationId: randomUUID(),
        confirmed: true,
      },
    })
    expect((await receiver.client.pull(share.id)).share).toMatchObject({
      generation: 2,
      source: { adapter: 'deepseek' },
    })
  },
  125000,
)

it.skipIf(!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'Codex preflights and consumes the final Antigravity cut, then hands the same share back',
  async () => {
    const f = await environment()
    const home = join(f.root, 'codex')
    const model = await codexModel(home)
    f.defer(() => model.app.close())
    await writeFile(
      join(home, 'config.toml'),
      'model_context_window = 32768\n' +
        (await readFile(join(home, 'config.toml'), 'utf8')),
    )
    const codex = new CodexSharedSync({
      connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
      stateDir: join(f.root, 'codex-state'),
      native: {
        executable: process.env.CONTEXTMESH_TEST_CODEX_BIN,
        env: {
          ...process.env,
          CODEX_HOME: home,
          CODEX_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
        },
      },
    })
    const ag = new AntigravityLive(
      new SharedClient(f.client),
      join(f.root, 'a'),
      join(f.root, 'native'),
    )
    const from = randomUUID(),
      to = randomUUID()
    const logs = join(
      ag.gemini,
      'antigravity',
      'brain',
      from,
      '.system_generated/logs',
    )
    await mkdir(logs, { recursive: true })
    const log = join(logs, 'transcript.jsonl')
    await writeFile(
      log,
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        source: 'USER_EXPLICIT',
        status: 'DONE',
        content:
          '<USER_REQUEST>remember CODEX-RELAY-731 total=17</USER_REQUEST>',
      }) + '\n',
    )
    const { id } = await ag.share('antigravity', from, 'Round trip')
    const source = (await ag.source(from))!
    await ag.boundary(source, 'PreInvocation', false)
    const move = receiveAntigravity(codex, id, randomUUID(), {
      cwd: f.target,
      sandbox: 'read-only',
    })
    // Retain the receiver error if native readiness fails before requesting the source.
    await Promise.race([
      move,
      expect
        .poll(async () => (await ag.client.pull(id)).share.transfer?.phase, {
          timeout: 30000,
        })
        .toBe('requested'),
    ])
    expect(await ag.boundary(source, 'PreToolUse', false)).toBe('stop')
    await appendFile(
      log,
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        source: 'MODEL',
        status: 'DONE',
        content: 'final-source-tool-result',
      }) + '\n',
    )
    await ag.boundary(source, 'Stop', true)
    const thread = await move
    expect(JSON.stringify(model.requests.at(-1))).toContain(
      'final-source-tool-result',
    )
    expect((await ag.client.pull(id)).share).toMatchObject({
      generation: 1,
      source: { id: thread, adapter: 'codex' },
    })
    const ticket = await ag.ticket(id)
    const receiving = ag.accept(
      ticket.prompt.split('\n')[0]!.split(' ').at(-1)!,
      to,
      'antigravity',
    )
    await expect
      .poll(async () => (await ag.client.pull(id)).share.transfer?.phase)
      .toBe('requested')
    await codex.tick()
    const returned = await receiving
    expect(returned?.interrupted).toBe(false)
    expect(returned?.injectSteps?.[0]?.userMessage).toContain('CODEX-RELAY-731')
    expect((await ag.client.pull(id)).share).toMatchObject({
      generation: 2,
      source: { id: to, adapter: 'antigravity' },
    })
  },
  90000,
)

it('a DSH receiver validates the directory before stopping active Antigravity, imports the final cut, and wakes the unfinished task', async () => {
  const f = await environment()
  f.defer(f.close)
  const b = await f.launch('B', f.target)
  const ag = new AntigravityLive(
    new SharedClient(f.client),
    join(f.root, 'ag'),
    join(f.root, 'native'),
  )
  const thread = randomUUID(),
    dir = join(
      ag.gemini,
      'antigravity',
      'brain',
      thread,
      '.system_generated/logs',
    )
  await mkdir(dir, { recursive: true })
  const log = join(dir, 'transcript.jsonl')
  await writeFile(
    log,
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      content: '<USER_REQUEST>Continue the native work</USER_REQUEST>',
    }) + '\n',
  )
  const { id } = await ag.share('antigravity', thread, 'Active task')
  const source = (await ag.source(thread))!
  await ag.boundary(source, 'PreInvocation', false)
  const preview = (await b.rpc('m1', {
    command: { action: 'shared-preview', id },
  })) as { archiveId: string; generation: number; cut: number }
  const command = {
    action: 'shared-takeover',
    id,
    operationId: randomUUID(),
    sourceId: preview.archiveId,
    generation: preview.generation,
    cut: preview.cut,
    confirmed: true,
  }
  await expect(
    b.rpc('m1', { command: { ...command, cwd: join(f.root, 'missing') } }),
  ).rejects.toThrow()
  expect((await ag.client.pull(id)).share.transfer).toBeUndefined()
  const move = b.rpc('m1', { command: { ...command, cwd: f.target } })
  await Promise.race([
    move,
    expect
      .poll(async () => (await ag.client.pull(id)).share.transfer?.phase, {
        timeout: 5000,
      })
      .toBe('requested'),
  ])
  expect(await ag.boundary(source, 'PreInvocation', false)).toBe('stop')
  await appendFile(
    log,
    JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'DONE',
      content: 'Final tool result CM-739',
    }) + '\n',
  )
  await ag.boundary(source, 'Stop', true)
  await move
  await expect
    .poll(
      async () =>
        (await ag.client.pull(id)).events.filter((e) => e.role === 'assistant')
          .length,
      { timeout: 12000 },
    )
    .toBeGreaterThan(0)
  expect((await ag.client.pull(id)).share).toMatchObject({
    generation: 1,
    source: { adapter: 'deepseek' },
  })
  expect(await ag.boundary(source, 'PreInvocation', false)).toBe('stop')
}, 30000)
