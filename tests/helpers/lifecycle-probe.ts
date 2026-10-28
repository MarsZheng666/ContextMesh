import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-working-directory'

export const inject = [
  'agentLoop',
  'agents',
  'sessions',
  'sessionPersistence',
  'workingDirectory',
  'llm',
  ...(process.env.LIFECYCLE_SCENARIO?.startsWith('web')
    ? ['sessionController']
    : []),
]

const phrase = 'CM-LIFECYCLE-CONTEXT-4817'
const route = { provider: 'contextmesh-lifecycle', model: 'scripted' }

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((accept) => {
    release = accept
  })
  return { promise, release }
}

class LifecycleModel extends LlmAdapter {
  hold = false
  started = barrier()
  aborted = barrier()
  release = barrier()
  requests: GenerateOptions[] = []

  override async listModels() {
    return [{ provider: route.provider, id: route.model, name: route.model }]
  }

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === undefined) this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    if (this.hold) {
      const signal = options.signal
      assert.ok(signal)
      const abort = () => this.aborted.release()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      this.started.release()
      try {
        await this.aborted.promise
        await this.release.promise
        throw new Error('scripted stream stopped after cancellation')
      } finally {
        signal.removeEventListener('abort', abort)
      }
    }
    yield { type: 'text-delta', index: 0, text: 'Recorded.' }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Recorded.' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Loaded only by isolated test overlays through the official DSH launcher. */
export async function apply(ctx: Context): Promise<void> {
  const scenario = process.env.LIFECYCLE_SCENARIO
  const id = SessionId(process.env.TEST_SESSION_ID!)
  const source = process.env.LIFECYCLE_SOURCE!
  const target = process.env.LIFECYCLE_TARGET!
  const checks: string[] = []
  const model = new LifecycleModel()
  ctx.llm.registerAdapter([route.provider], model)
  const create = () =>
    ctx.agents.create({
      sessionId: id,
      meta: { cwd: source },
      agentOptions: route,
    })
  const read = async () => {
    const reader = await ctx.sessionPersistence.open(id, 'read')
    try {
      return await reader.read()
    } finally {
      await reader.close()
    }
  }
  const prompt = async (agent: Agent, text: string) => {
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }),
    )
    await agent.whenIdle()
    assert.equal(agent.inbox.nextTurn.length + agent.inbox.nextStep.length, 0)
  }
  const assertReleased = async () => {
    assert.equal(ctx.agents.get(id), undefined)
    assert.equal(ctx.sessions.get(id), undefined)
    const writer = await ctx.sessionPersistence.open(id, 'write')
    await writer.close()
  }
  let owned: AgentHandle | undefined
  try {
    switch (scenario) {
      case 'stop': {
        owned = await create()
        await prompt(owned.agent, phrase)
        assert.equal(model.requests.length, 1)
        const session = owned.agent.session
        // A valid native event emitted during scope teardown must be drained too.
        owned.agent.ctx.effect(
          () => () => {
            session.append('working-directory/change', { cwd: target })
          },
          'contextmesh-test: final scoped event',
        )
        await ctx.sessions.flush(session)
        const before = (await read()).events.length
        await Promise.all([owned.dispose(), owned.dispose()])
        const final = await read()
        assert.ok(final.events.length > before)
        assert.equal(final.events.at(-1)?.type, 'working-directory/change')
        assert.deepEqual(final.events.at(-1)?.data, { cwd: target })
        assert.ok(final.events.some((event) => event.type === 'turn/end'))
        assert.deepEqual(
          final.events.map((event) => event.seq),
          final.events.map((_, index) => index),
        )
        await assertReleased()
        checks.push(
          'final-events-drained',
          'disposal-joined',
          'writer-released',
        )
        break
      }
      case 'active-stop': {
        owned = await create()
        model.hold = true
        owned.agent.followup(
          createUserMessage({
            content: [
              { type: 'text', text: 'Hold this request until canceled.' },
            ],
            source: { kind: 'user' },
          }),
        )
        await model.started.promise
        let settled = false
        const stopping = owned.dispose().finally(() => {
          settled = true
        })
        try {
          await model.aborted.promise
          assert.equal(settled, false)
          assert.ok(ctx.agents.get(id))
          assert.ok(ctx.sessions.get(id))
        } finally {
          model.release.release()
        }
        await stopping
        const final = await read()
        const end = final.events.findLast((event) => event.type === 'turn/end')
        assert.ok(end)
        assert.deepEqual(end.data.reason, {
          kind: 'aborted',
          reason: { kind: 'disposed' },
        })
        await assertReleased()
        checks.push('disposal-waits-for-active-stream', 'aborted-turn-durable')
        break
      }
      case 'cancel': {
        owned = await create()
        await ctx.sessions.flush(owned.agent.session)
        owned.agent.cancel({ kind: 'user' })
        await owned.agent.whenIdle()
        assert.equal(ctx.agents.get(id), owned.agent)
        await assert.rejects(ctx.sessionPersistence.open(id, 'write'), {
          name: 'SessionAlreadyOwnedError',
        })
        await prompt(owned.agent, 'A new message after cancel still runs.')
        assert.equal(model.requests.length, 1)
        checks.push('cancel-keeps-writer', 'cancel-does-not-gate-new-input')
        await owned.dispose()
        await assertReleased()
        break
      }
      case 'pending': {
        owned = await create()
        owned.agent.inject(
          createUserMessage({
            content: [
              { type: 'text', text: 'Do not silently discard this input.' },
            ],
            source: { kind: 'user' },
          }),
        )
        assert.equal(
          owned.agent.inbox.nextTurn.length + owned.agent.inbox.nextStep.length,
          1,
        )
        assert.equal(owned.agent.status, 'idle')
        await ctx.sessions.flush(owned.agent.session)
        assert.equal(
          owned.agent.inbox.nextTurn.length + owned.agent.inbox.nextStep.length,
          1,
        )
        await owned.dispose()
        const restored = await ctx.agents.resume({
          resumeSessionId: id,
          agentOptions: route,
        })
        owned = restored
        assert.equal(
          restored.agent.inbox.nextTurn.length +
            restored.agent.inbox.nextStep.length,
          0,
        )
        assert.equal(model.requests.length, 0)
        checks.push(
          'idle-can-have-pending-input',
          'normal-dispose-clears-inbox',
        )
        await owned.dispose()
        break
      }
      case 'resume-source': {
        owned = await create()
        await prompt(owned.agent, `Remember ${phrase}.`)
        assert.equal(model.requests.length, 1)
        await owned.dispose()
        await assertReleased()
        checks.push('source-history-persisted')
        break
      }
      case 'resume-target': {
        await assert.rejects(access(source))
        let setupRan = false
        let published = false
        ctx.on('agent/created', ({ agent }) => {
          if (agent.id !== id) return
          assert.equal(setupRan, true)
          assert.equal(ctx.workingDirectory.get(agent.session), target)
          published = true
        })
        owned = await ctx.agents.resume({
          resumeSessionId: id,
          agentOptions: route,
          setup: async (_agentCtx, agent) => {
            assert.equal(ctx.agents.get(id), undefined)
            assert.equal(ctx.sessions.get(id), undefined)
            assert.equal(model.requests.length, 0)
            await ctx.workingDirectory.set(agent, target)
            await assert.rejects(async () => {
              await ctx.sessions.flush(agent.session)
            }, /not live in this store/)
            const duringSetup = await read()
            assert.equal(
              duringSetup.events.some(
                (event) =>
                  event.type === 'working-directory/change' &&
                  event.data.cwd === target,
              ),
              false,
            )
            setupRan = true
          },
        })
        assert.equal(published, true)
        await ctx.sessions.flush(owned.agent.session)
        const afterPublication = await read()
        assert.ok(
          afterPublication.events.some(
            (event) =>
              event.type === 'working-directory/change' &&
              event.data.cwd === target,
          ),
        )
        assert.equal(owned.agent.session.header.cwd, source)
        assert.equal(model.requests.length, 0)
        await prompt(owned.agent, 'Continue using the previous context.')
        assert.equal(model.requests.length, 1)
        assert.ok(JSON.stringify(model.requests[0]!.messages).includes(phrase))
        await owned.dispose()
        const final = await read()
        assert.ok(
          final.events.some(
            (event) =>
              event.type === 'working-directory/change' &&
              event.data.cwd === target,
          ),
        )
        checks.push(
          'setup-before-publication',
          'setup-flush-rejects-unpublished-session',
          'mapped-cwd',
          'history-in-request',
        )
        break
      }
      case 'setup-failure': {
        owned = await create()
        await ctx.sessions.flush(owned.agent.session)
        await owned.dispose()
        await assert.rejects(
          ctx.agents.resume({
            resumeSessionId: id,
            agentOptions: route,
            setup: async (_agentCtx, agent) => {
              await ctx.workingDirectory.set(agent, target)
              throw new Error('injected setup failure')
            },
          }),
          /injected setup failure/,
        )
        await assertReleased()
        const final = await read()
        assert.equal(
          final.events.some(
            (event) =>
              event.type === 'working-directory/change' &&
              event.data.cwd === target,
          ),
          false,
        )
        assert.equal(model.requests.length, 0)
        checks.push(
          'setup-failure-releases-writer',
          'unpublished-setup-events-not-committed',
        )
        break
      }
      case 'close-failure': {
        owned = await create()
        await ctx.sessions.flush(owned.agent.session)
        await assert.rejects(owned.dispose())
        assert.equal(ctx.agents.get(id), undefined)
        assert.equal(ctx.sessions.get(id), undefined)
        checks.push('close-failure-rejects-disposal')
        // The memoized failing disposer has already settled; do not call it again.
        owned = undefined
        break
      }
      case 'activity-gate': {
        owned = await create()
        let finish!: () => void
        const admitted = ctx.agents.activity(
          id,
          () =>
            new Promise<void>((resolve) => {
              finish = resolve
            }),
        )
        const control = ctx.agents.acquireControl(id)
        assert.throws(() => ctx.agents.activity(id, async () => {}), {
          code: 'SESSION_FROZEN',
        })
        let joined = false
        const quiesced = control.quiesce().then(() => {
          joined = true
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(joined, false)
        finish()
        await admitted
        await quiesced
        await control.stop()
        owned = undefined
        checks.push('admitted-activity-joined', 'new-activity-frozen')
        break
      }
      case 'creation-race': {
        const entered = barrier(),
          proceed = barrier()
        const creating = ctx.agents.create({
          sessionId: id,
          meta: { cwd: source },
          agentOptions: route,
          setup: async () => {
            entered.release()
            await proceed.promise
          },
        })
        const rejected = assert.rejects(creating, { code: 'SESSION_FROZEN' })
        await entered.promise
        const control = ctx.agents.acquireControl(id)
        const stopping = control.stop()
        proceed.release()
        await rejected
        await stopping
        assert.equal(ctx.agents.get(id), undefined)
        assert.equal(ctx.sessions.get(id), undefined)
        control.release()
        checks.push('inflight-create-drained-before-stop')
        break
      }
      case 'web-control': {
        await ctx.sessionController.create({ sessionId: id, cwd: source })
        const agent = ctx.agents.get(id)
        assert.ok(agent)
        await ctx.sessionController.selectModel({ sessionId: id, ...route })
        const control = ctx.agents.acquireControl(id)
        const message = () =>
          createUserMessage({
            content: [{ type: 'text', text: 'Must be denied.' }],
            source: { kind: 'user' },
          })
        for (const submit of [
          () => agent.followup(message()),
          () => agent.steer(message()),
          () => agent.inject(message()),
          () => agent.inbox.append('next-turn', message()),
          () => agent.inbox.splice('next-step', 0, 0, [message()]),
          () => control.run(() => agent.followup(message())),
        ]) {
          assert.throws(submit, { code: 'SESSION_FROZEN' })
        }
        await ctx.sessions.flush(agent.session)
        await control.stop()
        assert.equal(ctx.agents.get(id), undefined)
        await assert.rejects(
          ctx.agents.resume({ resumeSessionId: id, agentOptions: route }),
          { code: 'SESSION_FROZEN' },
        )
        const restored = await control.run(() =>
          ctx.agents.resume({ resumeSessionId: id, agentOptions: route }),
        )
        owned = restored
        assert.equal(model.requests.length, 0)
        control.release()
        await prompt(
          restored.agent,
          'Controlled restoration now accepts input.',
        )
        assert.equal(model.requests.length, 1)
        await owned.dispose()
        checks.push(
          'web-owner-stopped',
          'all-input-paths-frozen',
          'controlled-resume',
        )
        break
      }
      case 'web': {
        const created = await ctx.sessionController.create({
          sessionId: id,
          cwd: source,
        })
        assert.equal(created.sessionId, id)
        const result = await ctx.sessionController.resolveAgent(id)
        assert.ok('agent' in result)
        const agent = ctx.agents.get(id)
        assert.ok(agent)
        assert.equal(result.agent, agent)
        assert.equal('dispose' in agent, false)
        assert.equal('dispose' in created, false)
        await ctx.sessionController.selectModel({ sessionId: id, ...route })
        agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        await ctx.sessions.flush(agent.session)
        await assert.rejects(ctx.sessionPersistence.open(id, 'write'), {
          name: 'SessionAlreadyOwnedError',
        })
        await prompt(
          agent,
          'A Web-owned session still accepts work after cancel.',
        )
        assert.equal(model.requests.length, 1)
        checks.push('web-returns-no-owned-handle', 'web-cancel-keeps-writer')
        break
      }
      default:
        throw new Error(`Unknown lifecycle scenario: ${scenario}`)
    }
    process.stdout.write(
      JSON.stringify({ contextmeshLifecycle: true, scenario, checks }) + '\n',
    )
  } catch (error) {
    let failure = error
    model.release.release()
    if (owned !== undefined) {
      try {
        await owned.dispose()
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'lifecycle probe failed',
        )
      }
    }
    process.stdout.write(
      JSON.stringify({
        contextmeshLifecycle: true,
        scenario,
        checks,
        error: failure instanceof Error ? failure.stack : String(failure),
      }) + '\n',
    )
    throw failure
  }
}
