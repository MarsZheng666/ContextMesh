import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { environment } from '../helpers/handoff-environment.js'
import { TOKEN } from '../fixture.js'
import { SharedClient } from '../../packages/client/src/shared.js'
import { ConfirmedCodexTakeover } from '../../packages/adapter-codex/src/takeover.js'
import { CodexSharedSync } from '../../packages/adapter-codex/src/shared-sync.js'
import { codexModel } from '../helpers/codex-model.js'

it.skipIf(!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'keeps one live conversation through DSH → native Codex → DSH and rejects the old writer',
  async () => {
    const f = await environment()
    const a = await f.launch('A', f.source)
    const b = await f.launch('B', f.target)
    const sessionId = randomUUID(),
      projectId = randomUUID()
    await a.rpc('m1', {
      command: { action: 'project', projectId, name: 'Live shared roundtrip' },
    })
    await a.rpc('m1', {
      command: { action: 'mapping', projectId, root: f.source },
    })
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'READ_WORKSPACE remember CODEX-RELAY-731 total=17.',
    })
    const shared = (await a.rpc('m1', {
      command: {
        action: 'shared-publish',
        sessionId,
        title: 'Live shared roundtrip',
        confirmed: true,
      },
    })) as { id: string }
    const client = new SharedClient(f.client)
    const first = await client.pull(shared.id)
    expect(first.events.length).toBeGreaterThan(0)
    expect(
      first.events.some((event) =>
        event.preview.includes('Current runtime context'),
      ),
    ).toBe(false)
    expect(
      first.events.filter(
        (event) => event.role === 'reference' && event.status === 'completed',
      ),
    ).toHaveLength(1)
    const home = join(f.root, 'codex-live')
    await mkdir(home)
    const model = await codexModel(home)
    f.defer(() => model.app.close())
    const options = {
      connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
      stateDir: join(f.root, 'codex-sync'),
      native: {
        executable: process.env.CONTEXTMESH_TEST_CODEX_BIN,
        env: {
          ...process.env,
          CODEX_HOME: home,
          OPENAI_API_KEY: undefined,
          CODEX_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
        },
        timeoutMs: 15000,
      },
    }
    const receiver = new CodexSharedSync(options)
    await receiver.followers.follow(shared.id)
    await a.rpc('prompt', {
      sessionId,
      text: 'One more message before the handoff.',
    })
    await receiver.tick()
    expect((await receiver.followers.list())[0]!.cursor).toBeGreaterThan(
      first.next,
    )
    const worker = new ConfirmedCodexTakeover(options)
    const result = await worker.takeover({
      sourceId: sessionId,
      confirmed: true,
      target: {
        cwd: f.target,
        model: 'gpt-6.1-sol',
        sandbox: 'workspace-write',
      },
      waitMs: 30000,
    })
    expect(result.handoff.state).toBe('completed')
    await receiver.tick()
    expect((await receiver.sources()).map((s) => s.error)).toEqual([undefined])
    const info = await client.find('deepseek', sessionId)
    expect(info).toMatchObject({
      id: shared.id,
      source: { adapter: 'codex' },
      generation: 1,
    })
    const source = (await receiver.sources())[0]!
    expect((await client.pull(shared.id)).share.activity).toBe('idle')
    await b.rpc('m1', { command: { action: 'shared-follow', id: shared.id } })
    const preview = (await b.rpc('m1', {
      command: { action: 'shared-preview', id: shared.id },
    })) as { generation: number; cut: number; archiveId: string }
    const operationId = randomUUID()
    const continued = (await b.rpc('m1', {
      command: {
        action: 'shared-takeover',
        id: shared.id,
        generation: preview.generation,
        cut: preview.cut,
        sourceId: preview.archiveId,
        cwd: f.target,
        operationId,
        confirmed: true,
      },
    })) as { sessionId: string }
    expect(await client.find('codex', source.threadId)).toMatchObject({
      id: shared.id,
      generation: 2,
      source: { adapter: 'deepseek', id: continued.sessionId },
    })
    await expect(
      receiver.captureHook({
        session_id: source.threadId,
        turn_id: 'stale',
        hook_event_name: 'UserPromptSubmit',
      }),
    ).rejects.toMatchObject({ code: 'OWNERSHIP_LOST' })
    await b.rpc('prompt', {
      sessionId: continued.sessionId,
      text: 'Continue after the return handoff, keep total=17.',
    })
    await receiver.tick()
    const followed = (await receiver.followers.list())[0]!
    expect(followed.share.id).toBe(shared.id)
    expect(
      followed.records.some((item) =>
        item.preview.includes('Continue after the return handoff'),
      ),
    ).toBe(true)
  },
  90000,
)
