import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { HandoffRecord } from '../../protocol/src/handoff.js'
import { MeshError } from '../../protocol/src/index.js'

declare module '@deepseek-ai/dsh-llm/types' {
  interface MessageSourceMap {
    'contextmesh-continuation': {
      kind: 'contextmesh-continuation'
      handoffId: string
      sourceTurn: number
      form: 'notice'
      summary: string
    }
  }
}
interface ContinuationAgent extends Agent {
  continuationControlVersion: 1
  stageContinuation(message: UserMessage): void
  wakePending(): void
}
function bridge(agent: Agent): ContinuationAgent {
  const candidate = agent as ContinuationAgent
  if (candidate.continuationControlVersion !== 1)
    throw new MeshError(
      'CONTINUATION_UNSUPPORTED',
      'install the pinned continuation bridge',
    )
  return candidate
}
export function stageContinuation(agent: Agent, record: HandoffRecord) {
  const plan = record.manifest.continuation
  if (!plan) return
  // A consumed or explicitly discarded instruction must never be enqueued again.
  if (
    agent.session
      .snapshotEvents()
      .some(
        (e) =>
          (e.type === 'user/message' && e.data.id === plan.messageId) ||
          (e.type === 'agent/inbox/spliced' &&
            e.data.inserted.some((m) => m.id === plan.messageId)),
      )
  )
    return
  bridge(agent).stageContinuation({
    id: MessageId(plan.messageId),
    role: 'user',
    source: {
      kind: 'contextmesh-continuation',
      handoffId: record.id,
      sourceTurn: plan.turn,
      form: 'notice',
      summary: 'Task transferred here. Continuing unfinished work.',
    },
    content: [
      {
        type: 'text',
        text: `ContextMesh transferred this conversation while turn ${plan.turn} was unfinished. Continue the original user's unfinished task now using the preceding conversation, completed tool results and current workspace. This is an automatic continuation after the confirmed handoff, not a new task. Do not repeat completed operations. Check the current state before any action whose effects are uncertain. If necessary files or permissions are unavailable, explain what is missing instead of guessing. Complete the original task and report its result.`,
      },
    ],
  })
}
export function wakeContinuation(agent: Agent, record: HandoffRecord) {
  const plan = record.manifest.continuation
  if (plan && agent.inbox.nextTurn.some((m) => m.id === plan.messageId))
    bridge(agent).wakePending()
}

/** Stops admission of new tool bodies, but lets an already running body settle. */
export class ToolBoundary {
  private active = new Map<string, number>()
  private gates = new Map<
    string,
    { promise: Promise<void>; release: () => void }
  >()
  private listeners = new Map<string, Set<() => void>>()
  async enter(id: string, signal: AbortSignal) {
    const gate = this.gates.get(id)
    if (gate)
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort)
          reject(signal.reason)
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
        void gate.promise.then(() => {
          signal.removeEventListener('abort', abort)
          resolve()
        })
      })
    signal.throwIfAborted()
    this.active.set(id, (this.active.get(id) ?? 0) + 1)
    return () => {
      const count = (this.active.get(id) ?? 1) - 1
      if (count) this.active.set(id, count)
      else {
        this.active.delete(id)
        for (const done of this.listeners.get(id) ?? []) done()
      }
    }
  }
  async pause(id: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.gates.has(id)) {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      this.gates.set(id, { promise, release })
    }
    if (!this.active.has(id)) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener('abort', abort)
        const listeners = this.listeners.get(id)
        listeners?.delete(done)
        if (!listeners?.size) this.listeners.delete(id)
      }
      const done = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      const listeners = this.listeners.get(id) ?? new Set()
      listeners.add(done)
      this.listeners.set(id, listeners)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  release(id: string) {
    this.gates.get(id)?.release()
    this.gates.delete(id)
  }
}
