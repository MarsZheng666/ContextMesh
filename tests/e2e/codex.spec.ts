import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { test, expect } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { meta, oneTurnLog } from '../upstream/contract.js'
import { codexModel } from '../helpers/codex-model.js'
import { CodexBridge } from '../../packages/adapter-codex/src/bridge.js'
import { MeshClient } from '../../packages/client/src/index.js'
import type { StoredEvent } from '../../packages/protocol/src/index.js'

test.runIf(!!process.env.CONTEXTMESH_TEST_CODEX_BIN)(
  'real Codex CLI imports DSH context, continues on its own model, and resumes after restart',
  async () => {
    const f = await fixture(),
      root = await mkdtemp(join(tmpdir(), 'cm-real-codex-'))
    f.defer(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'codex'),
      cwd = join(root, 'project')
    await mkdir(cwd)
    const model = await codexModel(home)
    f.defer(() => model.app.close())
    const id = randomUUID(),
      handle = await f.client.create(meta(id) as any, 0)
    const events = JSON.parse(JSON.stringify(oneTurnLog()))
    events[1].data.content[0].text =
      'Remember CODEX-RELAY-731. The completed tool returned total=17.'
    events[3].data.message.content[0].text =
      'The count is total=17; next step is verification.'
    // Preserve the native stream text consistently with the final assistant message.
    events[3].data.stream[1].texts[0] = events[3].data.message.content[0].text
    events[3].data.stream[2].chunk.block.text =
      events[3].data.message.content[0].text
    const call = {
      type: 'tool-call',
      id: 'completed-inspection',
      name: 'inspect_fixture',
      arguments: '{"file":"fixture.txt"}',
    }
    events[3].data.message.content.push(call)
    events[3].data.message.source = {
      kind: 'model',
      provider: 'source-provider',
      model: 'ds-flash',
      replayState: { privateState: 'NEVER-FORWARD-REPLAY-STATE' },
    }
    events[3].data.stream.splice(
      3,
      0,
      {
        type: 'chunk',
        time: 4,
        chunk: { type: 'block-start', index: 1, blockType: 'tool-call' },
      },
      {
        type: 'chunk',
        time: 4,
        chunk: { type: 'block-end', index: 1, block: call },
      },
    )
    events.splice(
      4,
      0,
      {
        type: 'tool/call',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          callId: call.id,
          name: call.name,
          arguments: call.arguments,
        },
      },
      {
        type: 'tool/result',
        seq: 5,
        time: 5,
        surfaceOp: 'append',
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'completed-inspection-result',
            role: 'tool',
            source: { kind: 'tool', callId: call.id },
            toolCallId: call.id,
            content: [{ type: 'text', text: 'total=17' }],
          },
        },
      },
    )
    events.forEach((event: any, seq: number) => {
      event.seq = seq
    })
    await f.client.append(handle, events as StoredEvent[], randomUUID())
    await f.client.flush(handle, randomUUID())
    await f.client.close(handle, randomUUID())
    const env = {
      ...process.env,
      CODEX_HOME: home,
      OPENAI_API_KEY: undefined,
      CODEX_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
    }
    const bridge = new CodexBridge({
      connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
      stateDir: join(root, 'bridge'),
      native: {
        executable: process.env.CONTEXTMESH_TEST_CODEX_BIN,
        env,
        timeoutMs: 15000,
      },
    })
    const imported = await bridge.import({
      sourceId: id,
      target: { cwd, model: 'gpt-6.1-sol', sandbox: 'read-only' },
    })
    expect(model.requests).toHaveLength(0)
    const first = await bridge.run(
      imported.sessionId,
      'Use the remembered marker and result. What is next?',
    )
    expect(first).toMatchObject({
      status: 'completed',
      text: 'CODEX-RELAY-731 total=17 next=verification',
    })
    expect(JSON.stringify(model.requests[0])).toContain('CODEX-RELAY-731')
    expect(JSON.stringify(model.requests[0])).toContain('total=17')
    expect(JSON.stringify(model.requests[0])).toContain(
      'Historical tool result',
    )
    expect(JSON.stringify(model.requests[0])).not.toContain(
      'NEVER-FORWARD-REPLAY-STATE',
    )
    expect(
      (model.requests[0].input as any[]).some(
        (i) => i.type === 'function_call',
      ),
    ).toBe(false)
    expect(model.requests[0].model).toBe('gpt-6.1-sol')
    expect(
      await bridge.run(
        imported.sessionId,
        'Continue after the app-server restarted.',
      ),
    ).toMatchObject({ status: 'completed' })
    const codex = new MeshClient({
      endpoint: f.endpoint,
      token: TOKEN,
      adapter: 'codex',
    })
    const reader = await codex.open(imported.sessionId, 'read'),
      history = await codex.read(reader, 0, 100)
    expect(history.events).toHaveLength(3)
    expect((history.events[2]!.snapshot as any).turns).toHaveLength(2)
    await codex.close(reader, randomUUID())
    const secondHome = join(root, 'second-codex'),
      secondCwd = join(root, 'second-project')
    await mkdir(secondCwd)
    const secondModel = await codexModel(secondHome)
    f.defer(() => secondModel.app.close())
    const receiver = new CodexBridge({
      connection: { endpoint: f.endpoint, token: TOKEN, retries: 0 },
      stateDir: join(root, 'receiver-bridge'),
      native: {
        executable: process.env.CONTEXTMESH_TEST_CODEX_BIN,
        env: { ...env, CODEX_HOME: secondHome },
        timeoutMs: 15000,
      },
    })
    const copied = await receiver.import({
      sourceId: imported.sessionId,
      sourceAdapter: 'codex',
      target: { cwd: secondCwd, model: 'gpt-6.1-sol', sandbox: 'read-only' },
    })
    expect(
      await receiver.run(
        copied.sessionId,
        'Continue in the receiver workspace.',
      ),
    ).toMatchObject({
      status: 'completed',
      text: 'CODEX-RELAY-731 total=17 next=verification',
    })
    expect(JSON.stringify(secondModel.requests[0])).toContain(
      'Continue after the app-server restarted.',
    )
    expect((await f.client.stat(id))?.nextSeq).toBe(8)
  },
  90000,
)
