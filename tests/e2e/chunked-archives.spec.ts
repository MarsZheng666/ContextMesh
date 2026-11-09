import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { CodexPanelJobs } from '../../apps/cli/src/codex-panel-jobs.js'
import { ArchiveClient } from '../../packages/client/src/archives.js'
import { environment } from '../helpers/handoff-environment.js'
import { fixture, TOKEN } from '../fixture.js'
import { CodexBridge } from '../../packages/adapter-codex/src/bridge.js'
import { ArchiveSpool } from '../../packages/adapter-codex/src/archive-spool.js'
import { codexModel } from '../helpers/codex-model.js'

it('publishes a saved Codex thread and resumes the same archive in Codex and DSH within different budgets', async () => {
  const f = await environment()
  try {
    const dsh = await f.launch('DSH', f.target)
    const nativeHome = join(f.root, 'native')
    await mkdir(nativeHome)
    const threadId = randomUUID()
    const turn1 = { id: 'first', status: 'completed' }
    const turn2 = { id: 'last', status: 'interrupted' }
    const message = (type: 'userMessage' | 'agentMessage', text: string) =>
      type === 'userMessage'
        ? { type, content: [{ type: 'text', text }] }
        : { type, text }
    const padding = ('FILLER-LOG-DATA ' + 'f'.repeat(1000) + '\n').repeat(2200)
    const items = [
      {
        turnId: turn1.id,
        item: message('userMessage', 'Previous discussion about test state.'),
      },
      ...Array.from({ length: 32 }, (_, index) => ({
        turnId: turn1.id,
        item: message(
          'agentMessage',
          'Earlier update ' + index + ' ' + 'old data '.repeat(35),
        ),
      })),
      {
        turnId: turn2.id,
        item: message(
          'userMessage',
          'Fix tests/handoff.spec.ts and keep CONTINUITY-PHRASE-4817.',
        ),
      },
      {
        turnId: turn2.id,
        item: {
          type: 'commandExecution',
          status: 'failed',
          exitCode: 1,
          command: ['pnpm', 'test'],
          aggregatedOutput:
            padding +
            'tests/handoff.spec.ts ETIMEDOUT after the Server restart\n',
        },
      },
      {
        turnId: turn2.id,
        item: message('agentMessage', 'The restart test still needs a fix.'),
      },
    ]
    const fixture = join(nativeHome, 'fixture.json')
    await writeFile(
      fixture,
      JSON.stringify({
        requests: [],
        threads: {
          [threadId]: {
            thread: {
              id: threadId,
              cwd: f.source,
              name: 'Handoff regression',
              cliVersion: '0.154.0',
              status: { type: 'notLoaded' },
            },
            turns: [turn1, turn2],
            items,
          },
        },
      }),
    )
    const panel = new CodexPanelJobs({
      connection: { endpoint: f.endpoint, token: TOKEN },
      stateDir: join(nativeHome, 'contextmesh'),
      native: {
        executable: process.execPath,
        args: [resolve('tests/helpers/codex-rpc-fixture.mjs')],
        env: {
          ...process.env,
          CODEX_HOME: nativeHome,
          CODEX_FIXTURE_UUIDS: '1',
          CODEX_FIXTURE_RUN_LOG_BYTES: String(7 * 1024 * 1024),
        },
      },
    })
    const captured = await panel.preparePublish(threadId, 'full')
    expect(captured).toMatchObject({ interrupted: true })
    expect(captured!.bytes).toBeGreaterThan(1024 * 1024)
    expect((await panel.archives.list()).archives).toEqual([])
    const { id } = await panel.publishChunked(threadId, captured!.id, 'full')
    const log = (
      await new ArchiveClient(panel.bridge.client).index(id, {
        terms: ['etimedout'],
      })
    ).records[0]!
    expect(log.kind).toBe('commandExecution')
    expect(log.bytes).toBeGreaterThan(1024 * 1024)

    const target = { cwd: f.target, sandbox: 'read-only' as const }
    const search = { query: 'fix handoff.spec.ts ETIMEDOUT' }
    const small = await panel.bridge.previewArchive(id, target, {
      ...search,
      contextWindow: 8192,
    })
    const large = await panel.bridge.previewArchive(id, target, {
      ...search,
      contextWindow: 32768,
    })
    expect(small.selected.length).toBeLessThan(large.selected.length)
    expect(
      small.selected.some(
        (entry) => entry.seq === log.seq && entry.length < log.bytes,
      ),
    ).toBe(true)
    expect(small.inputTokens).toBeLessThanOrEqual(small.historyBudget)
    expect(large.inputTokens).toBeLessThanOrEqual(large.historyBudget)
    const imported = await panel.bridge.import({
      sourceAdapter: 'codex',
      sourceId: id,
      target,
      resume: { ...search, contextWindow: 8192, planDigest: small.planDigest },
    })
    const state = JSON.parse(await readFile(fixture, 'utf8'))
    const injected = JSON.stringify(state.threads[imported.threadId].injected)
    expect(injected).toContain('ETIMEDOUT')
    expect(injected).toContain('CONTINUITY-PHRASE-4817')
    expect(injected).not.toContain('FILLER-LOG-DATA'.repeat(32))
    expect(
      state.requests.filter(
        (request: { method: string }) => request.method === 'turn/start',
      ),
    ).toEqual([])

    const continued = await panel.bridge.run(
      imported.sessionId,
      'Continue the restart test.',
    )
    expect(continued.text).toBe('fixture continuation')
    const child = (await panel.archives.list()).archives.find(
      (archive) => archive.manifest.header.parent === id,
    )
    expect(child?.manifest.bytes).toBeGreaterThan(6 * 1024 * 1024)

    const preview = z
      .object({ planDigest: z.string(), selected: z.array(z.unknown()) })
      .parse(
        await dsh.rpc('m1', {
          command: {
            action: 'preview-codex-archive',
            sourceId: id,
            cwd: f.target,
            resume: { ...search, contextWindow: 65536 },
          },
        }),
      )
    const importedDsh = z.object({ sessionId: z.string() }).parse(
      await dsh.rpc('m1', {
        command: {
          action: 'import-codex',
          sourceId: id,
          cwd: f.target,
          confirmed: true,
          operationId: randomUUID(),
          resume: {
            ...search,
            contextWindow: 65536,
            planDigest: preview.planDigest,
          },
        },
      }),
    )
    const prompted = z
      .object({
        requests: z.number(),
        events: z.array(z.object({ type: z.string() }).passthrough()),
      })
      .parse(
        await dsh.rpc('prompt', {
          sessionId: importedDsh.sessionId,
          text: 'Continue with the saved restart test.',
        }),
      )
    expect(
      prompted.requests,
      JSON.stringify(
        prompted.events.slice(-5).map((event) => ({
          type: event.type,
          data: event.type.endsWith('/end') ? event.data : undefined,
        })),
      ).slice(0, 1500),
    ).toBe(1)
    const recorded = prompted.events.findLast(
      (event) => event.type === 'assistant/message',
    )
    expect(JSON.stringify(recorded)).toContain(
      'Context retained CONTINUITY-PHRASE-4817.',
    )
    await dsh.stop()
    const dshPlan = await panel.bridge.previewArchive(
      importedDsh.sessionId,
      target,
      { ...search, contextWindow: 16384 },
      'deepseek',
    )
    const fromDsh = await panel.bridge.import({
      sourceAdapter: 'deepseek',
      sourceId: importedDsh.sessionId,
      target,
      resume: {
        ...search,
        contextWindow: 16384,
        planDigest: dshPlan.planDigest,
      },
    })
    const after = JSON.parse(await readFile(fixture, 'utf8'))
    expect(JSON.stringify(after.threads[fromDsh.threadId].injected)).toContain(
      'Context retained CONTINUITY-PHRASE-4817.',
    )
  } finally {
    await f.close()
  }
}, 90000)

it.runIf(!!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'opens a v2 archive in the native Codex CLI and archives the continued turn with its parent',
  async () => {
    const f = await fixture()
    const root = await mkdtemp(join(tmpdir(), 'cm-native-v2-'))
    f.defer(() => rm(root, { recursive: true, force: true }))
    const nativeHome = join(root, 'codex')
    const model = await codexModel(nativeHome)
    f.defer(() => model.app.close())
    const project = join(root, 'project')
    await mkdir(project)
    let dropCommit = false
    const bridge = new CodexBridge({
      connection: {
        endpoint: f.endpoint,
        token: TOKEN,
        retries: 0,
        fetch: async (input, options) => {
          const result = await fetch(input, options)
          if (dropCommit && result.ok && String(input).endsWith('/commit')) {
            dropCommit = false
            await result.arrayBuffer()
            throw new Error('Synthetic lost archive commit acknowledgement')
          }
          return result
        },
      },
      stateDir: join(root, 'bridge'),
      native: {
        executable: process.env.CONTEXTMESH_TEST_CODEX_BIN,
        env: {
          ...process.env,
          CODEX_HOME: nativeHome,
          OPENAI_API_KEY: undefined,
          CODEX_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
        },
      },
    })
    const archives = new ArchiveClient(f.client)
    const spool = new ArchiveSpool(join(root, 'source'), f.endpoint)
    const source = randomUUID()
    await spool.prepare(async (append) => {
      await append({
        role: 'user',
        kind: 'userMessage',
        turn: '1',
        text: 'Keep CODEX-RELAY-731 and total=17.',
      })
      await append({
        role: 'assistant',
        kind: 'agentMessage',
        turn: '1',
        text: 'Saved the verification checkpoint.',
      })
      return {
        version: 2,
        title: 'Native v2 fixture',
        scope: 'full',
        omittedAttachments: 0,
        unrecognizedItems: 0,
        interrupted: false,
        source: {
          adapter: 'codex',
          id: source,
          incarnation: source,
          eventCount: 2,
        },
      }
    })
    const { id } = await spool.upload(archives)
    const target = { cwd: project, sandbox: 'read-only' as const }
    const resume = { contextWindow: 32768 }
    const plan = await bridge.previewArchive(id, target, resume)
    const imported = await bridge.import({
      sourceId: id,
      sourceAdapter: 'codex',
      target,
      resume: { ...resume, planDigest: plan.planDigest },
    })
    expect(model.requests).toHaveLength(0)
    const continued = await bridge.run(
      imported.sessionId,
      'Continue with the saved checkpoint.',
    )
    expect(continued.text).toBe('CODEX-RELAY-731 total=17 next=verification')
    expect(model.requests).toHaveLength(1)
    const newArchive = (await archives.list()).archives.find(
      (archive) => archive.manifest.header.parent === id,
    )
    expect(newArchive?.manifest.header.source.id).toBe(imported.threadId)
    dropCommit = true
    await expect(
      bridge.run(imported.sessionId, 'Continue to the next step.'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await bridge.status(imported.sessionId)).toMatchObject({
      phase: 'needs-review',
    })
    expect(await bridge.reconcile(imported.sessionId, true)).toMatchObject({
      reconciled: true,
      replayed: false,
    })
    expect(model.requests).toHaveLength(2)
    expect(await bridge.status(imported.sessionId)).toMatchObject({
      phase: 'ready',
    })
  },
  60000,
)
