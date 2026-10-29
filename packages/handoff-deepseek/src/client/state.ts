import { z } from 'zod'
import type { ModelRoute } from '../../../protocol/src/model-relay.js'
const modelChoice = z.object({
  provider: z.string(),
  model: z.string(),
  name: z.string().optional(),
})
import { en, type Key } from './locales.js'
import type { ListDirectory } from './directory.js'
export const snapshotSchema = z.object({
  connection: z
    .object({
      endpoint: z.string(),
      role: z.enum(['owner', 'device']),
      nodeId: z.string().nullable(),
    })
    .optional(),
  nodeId: z.string(),
  name: z.string(),
  models: z.array(modelChoice).optional(),
  modelSwitching: z.array(z.string()).optional(),
  nodes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      online: z.boolean(),
      models: z.array(modelChoice).optional(),
    }),
  ),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  mappings: z.array(z.object({ projectId: z.string(), root: z.string() })),
  sessions: z.array(
    z.object({
      id: z.string(),
      incarnation: z.string(),
      title: z.string().nullable(),
      projectId: z.string().nullable(),
      activeNodeId: z.string().nullable(),
      activeNodeName: z.string().nullable(),
      handoffId: z.string().nullable(),
      handoffState: z.string().nullable(),
      recoveryRequired: z.boolean(),
    }),
  ),
  handoffs: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string(),
      sourceNodeId: z.string(),
      targetNodeId: z.string(),
      state: z.string(),
      error: z.string().nullable(),
    }),
  ),
  errors: z.record(z.string(), z.string()),
})
export type Snapshot = z.infer<typeof snapshotSchema>
export const historySchema = z.object({
  incarnation: z.string(),
  from: z.number(),
  total: z.number(),
  events: z.array(
    z.object({ seq: z.number(), type: z.string(), data: z.unknown() }),
  ),
})
export type History = z.infer<typeof historySchema>
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}
export interface ProjectSetup {
  sessionId: string
  incarnation: string
  sourceNodeId: string
  sourceName: string
  title: string
  projectId: string | null
}
export interface ViewState {
  data?: Snapshot
  error?: Error
  takingOver?: readonly string[]
  projectSetup?: ProjectSetup
  modelSelecting?: readonly string[]
}
export class UiModel {
  private takeovers = new Map<string, Promise<boolean>>()
  private takeoverTargets = new Map<string, string>()
  private selections = new Map<
    string,
    { promise: Promise<void>; finish: () => void }
  >()
  async beforeModelSelect(
    sessionId: string,
    previous: ModelRoute | null,
    target: ModelRoute,
    t: (key: Key) => string,
  ): Promise<true | undefined> {
    try {
      if (
        previous &&
        previous.provider !== target.provider &&
        !this.confirmTakeover(`${t('providerConfirm')} ${target.provider}`)
      )
        return true
      const data = snapshotSchema.parse(
        await this.request({ action: 'status' }),
      )
      this.set({ ...this.state, data, error: undefined })
      const session = data.sessions.find((s) => s.id === sessionId)
      if (session?.activeNodeId && session.activeNodeId !== data.nodeId) {
        await this.ensureOwned(sessionId, t, undefined, target)
        return true
      }
      if (this.selections.has(sessionId))
        throw new ControlError('MODEL_RELAY_BUSY', t('MODEL_RELAY_BUSY'))
      let finish!: () => void
      const promise = new Promise<void>((resolve) => {
        finish = resolve
      })
      this.selections.set(sessionId, { promise, finish })
      this.set({
        ...this.state,
        modelSelecting: [...(this.state.modelSelecting ?? []), sessionId],
      })
      return undefined
    } catch (error) {
      this.set({
        ...this.state,
        error: error instanceof Error ? error : new Error(String(error)),
      })
      return true
    }
  }
  finishModelSelect(sessionId: string) {
    this.selections.get(sessionId)?.finish()
    this.selections.delete(sessionId)
    this.set({
      ...this.state,
      modelSelecting: this.state.modelSelecting?.filter(
        (id) => id !== sessionId,
      ),
    })
  }
  async waitForModelSelect(sessionId: string, signal?: AbortSignal) {
    const pending = this.selections.get(sessionId)
    if (pending)
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          cleanup()
          reject(signal?.reason ?? this.abort.signal.reason)
        }
        const cleanup = () => {
          signal?.removeEventListener('abort', aborted)
          this.abort.signal.removeEventListener('abort', aborted)
        }
        signal?.addEventListener('abort', aborted, { once: true })
        this.abort.signal.addEventListener('abort', aborted, { once: true })
        if (signal?.aborted || this.abort.signal.aborted) aborted()
        void pending.promise.then(() => {
          cleanup()
          resolve()
        })
      })
    signal?.throwIfAborted()
    if (this.abort.signal.aborted) throw this.abort.signal.reason
    const data = snapshotSchema.parse(await this.request({ action: 'status' }))
    if (data.modelSwitching?.includes(sessionId))
      throw new ControlError(
        'MODEL_RELAY_UNCONFIRMED',
        en.MODEL_RELAY_UNCONFIRMED,
      )
  }
  private setupPending?: {
    sessionId: string
    promise: Promise<boolean>
    finish: (ready: boolean) => void
  }
  chooseProject(
    sessionId: string,
    t: (key: Key) => string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return this.request({ action: 'status' }).then((value) => {
      const data = snapshotSchema.parse(value)
      this.set({ ...this.state, data })
      const session = data.sessions.find((s) => s.id === sessionId)
      if (!session?.activeNodeId)
        throw new ControlError(
          'TAKEOVER_UNAVAILABLE',
          t('TAKEOVER_UNAVAILABLE'),
        )
      return this.showProjectSetup(data, session, signal)
    })
  }
  private showProjectSetup(
    data: Snapshot,
    session: Snapshot['sessions'][number],
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted()
    if (this.setupPending) {
      if (this.setupPending.sessionId === session.id)
        return this.setupPending.promise
      throw new ControlError('PROJECT_SETUP_BUSY', en.PROJECT_SETUP_BUSY)
    }
    let resolve!: (ready: boolean) => void
    const promise = new Promise<boolean>((done) => {
      resolve = done
    })
    const finish = (ready: boolean) => {
      if (this.setupPending?.promise !== promise) return
      signal?.removeEventListener('abort', cancel)
      this.abort.signal.removeEventListener('abort', cancel)
      this.setupPending = undefined
      this.set({ ...this.state, projectSetup: undefined })
      resolve(ready)
    }
    const cancel = () => finish(false)
    this.setupPending = { sessionId: session.id, promise, finish }
    signal?.addEventListener('abort', cancel, { once: true })
    this.abort.signal.addEventListener('abort', cancel, { once: true })
    this.set({
      ...this.state,
      data,
      projectSetup: {
        sessionId: session.id,
        incarnation: session.incarnation,
        sourceNodeId: session.activeNodeId!,
        sourceName: session.activeNodeName ?? '',
        title: session.title ?? session.id,
        projectId: session.projectId,
      },
    })
    return promise
  }
  cancelProjectSetup() {
    this.setupPending?.finish(false)
  }
  async saveProjectSetup(projectId: string, root?: string, name?: string) {
    const setup = this.state.projectSetup,
      pending = this.setupPending
    if (!setup || !pending) return
    if (name) await this.request({ action: 'project', projectId, name })
    try {
      await this.request({
        action: 'configure-project',
        sessionId: setup.sessionId,
        incarnation: setup.incarnation,
        expectedSourceNodeId: setup.sourceNodeId,
        projectId,
        ...(root ? { root } : {}),
      })
    } catch (error) {
      if (
        error instanceof ControlError &&
        ['WORKSPACE_MISMATCH', '128', 'ENOENT', 'ENOTDIR'].includes(error.code)
      )
        throw new ControlError(
          'PROJECT_DIRECTORY_INVALID',
          en.PROJECT_DIRECTORY_INVALID,
        )
      throw error
    }
    const data = snapshotSchema.parse(await this.request({ action: 'status' }))
    if (
      data.sessions.find((s) => s.id === setup.sessionId)?.projectId !==
      projectId
    )
      throw new ControlError('PROJECT_CHANGED', en.PROJECT_CHANGED)
    this.set({ ...this.state, data })
    pending.finish(true)
  }

  constructor(
    private readonly confirmTakeover: (message: string) => boolean = (
      message,
    ) => window.confirm(message),
    private readonly browse?: ListDirectory,
  ) {}
  listDirectories: ListDirectory = (path, signal) => {
    if (!this.browse)
      return Promise.reject(new Error('Directory browsing is unavailable'))
    return this.browse(path, signal)
  }
  ensureOwned(
    sessionId: string,
    t: (key: Key) => string,
    signal?: AbortSignal,
    targetModel?: ModelRoute,
  ): Promise<boolean> {
    const existing = this.takeovers.get(sessionId)
    if (existing) {
      if (
        targetModel &&
        this.takeoverTargets.get(sessionId) !== JSON.stringify(targetModel)
      )
        throw new ControlError('MODEL_RELAY_BUSY', en.MODEL_RELAY_BUSY)
      return existing
    }
    const operation = this.acquireHere(sessionId, t, signal, targetModel)
    this.takeovers.set(sessionId, operation)
    this.takeoverTargets.set(sessionId, JSON.stringify(targetModel))
    const clear = () => {
      if (this.takeovers.get(sessionId) === operation)
        this.takeovers.delete(sessionId)
      this.takeoverTargets.delete(sessionId)
      this.set({
        ...this.state,
        takingOver: this.state.takingOver?.filter((id) => id !== sessionId),
      })
    }
    void operation.then(clear, clear)
    return operation
  }
  private async acquireHere(
    sessionId: string,
    t: (key: Key) => string,
    signal?: AbortSignal,
    targetModel?: ModelRoute,
  ): Promise<boolean> {
    const friendly = (code: string) =>
      new ControlError(code, t(code in en ? (code as Key) : 'TAKEOVER_FAILED'))
    signal?.throwIfAborted()
    const data = snapshotSchema.parse(await this.request({ action: 'status' }))
    this.set({ ...this.state, data, error: undefined })
    const session = data.sessions.find((s) => s.id === sessionId)
    if (!session) return true
    if (session.recoveryRequired) throw friendly('TAKEOVER_UNAVAILABLE')
    if (session.handoffId) throw friendly('HANDOFF_IN_PROGRESS')
    if (!session.activeNodeId || session.activeNodeId === data.nodeId)
      return true
    if (
      !session.projectId ||
      !data.mappings.some((m) => m.projectId === session.projectId)
    ) {
      if (!(await this.showProjectSetup(data, session, signal))) return false
      return this.acquireHere(sessionId, t, signal, targetModel)
    }
    signal?.throwIfAborted()
    if (
      !this
        .confirmTakeover(`${t('takeoverConfirm')} ${session.activeNodeName ?? t('remote')}

${t('takeoverEffect')}${targetModel ? '\n\n' + t('targetModel') + ': ' + targetModel.provider + '/' + targetModel.model + '\n' + t('providerNotice') : ''}`)
    )
      return false
    this.set({
      ...this.state,
      takingOver: [...new Set([...(this.state.takingOver ?? []), sessionId])],
    })
    const intent = z.object({ id: z.string() }).parse(
      await this.request({
        action: 'takeover',
        sessionId,
        confirmed: true,
        ...(targetModel ? { targetModel } : {}),
        operationId: crypto.randomUUID(),
      }),
    )
    const deadline = Date.now() + 125000
    while (Date.now() < deadline) {
      signal?.throwIfAborted()
      const status = z
        .object({
          state: z.string(),
          errorCode: z.string().nullable(),
          error: z.string().nullable(),
          handoffState: z.string().optional(),
          handoffError: z.string().nullable().optional(),
        })
        .parse(
          await this.request({
            action: 'takeover-status',
            takeoverId: intent.id,
          }),
        )
      if (status.state === 'failed')
        throw friendly(status.errorCode ?? 'TAKEOVER_FAILED')
      if (
        ['failed', 'cancelled', 'recovery_required'].includes(
          status.handoffState ?? '',
        )
      )
        throw friendly('TAKEOVER_FAILED')
      if (status.handoffState === 'completed') {
        const fresh = snapshotSchema.parse(
          await this.request({ action: 'status' }),
        )
        this.set({ ...this.state, data: fresh, error: undefined })
        const current = fresh.sessions.find((s) => s.id === sessionId)
        if (
          current?.activeNodeId !== fresh.nodeId ||
          current.handoffId ||
          current.recoveryRequired
        )
          throw friendly('TAKEOVER_CHANGED')
        return true
      }
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', aborted)
          this.abort.signal.removeEventListener('abort', aborted)
          reject(signal?.reason ?? this.abort.signal.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', aborted)
          this.abort.signal.removeEventListener('abort', aborted)
          resolve()
        }, 500)
        signal?.addEventListener('abort', aborted, { once: true })
        this.abort.signal.addEventListener('abort', aborted, { once: true })
      })
    }
    throw friendly('TAKEOVER_EXPIRED')
  }

  private state: ViewState = {}
  private listeners = new Set<() => void>()
  private abort = new AbortController()
  private failures = 0
  private refreshing: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private set(state: ViewState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }
  async request(command: unknown): Promise<unknown> {
    const response = await fetch('/api/contextmesh', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    }).catch((error) => {
      if (this.abort.signal.aborted) throw error
      throw new ControlError('CONNECTION_LOST', en.CONNECTION_LOST)
    })
    const envelope = z
      .object({
        ok: z.boolean(),
        value: z.unknown().optional(),
        error: z
          .object({
            code: z.union([z.string(), z.number()]).transform(String),
            message: z.string(),
          })
          .optional(),
      })
      .parse(await response.json())
    if (!response.ok || !envelope.ok)
      throw new ControlError(
        envelope.error?.code === 'UNAVAILABLE'
          ? 'CONNECTION_LOST'
          : (envelope.error?.code ?? 'FAILED'),
        envelope.error?.code === 'UNAVAILABLE'
          ? en.CONNECTION_LOST
          : (envelope.error?.message ?? response.statusText),
      )
    return envelope.value
  }
  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.request({ action: 'status' })
      .then((value) => {
        this.failures = 0
        this.set({
          ...this.state,
          data: snapshotSchema.parse(value),
          error: undefined,
        })
      })
      .catch((error) => {
        this.failures = Math.min(4, this.failures + 1)
        if (!this.abort.signal.aborted)
          this.set({
            ...this.state,
            error: error instanceof Error ? error : new Error(String(error)),
          })
      })
      .finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }
  start() {
    const poll = async () => {
      await this.refresh()
      if (!this.abort.signal.aborted)
        this.timer = setTimeout(
          () => void poll(),
          Math.min(30000, 2500 * 2 ** this.failures),
        )
    }
    void poll()
  }
  close() {
    clearTimeout(this.timer)
    for (const selection of this.selections.values()) selection.finish()
    this.selections.clear()
    this.cancelProjectSetup()
    this.abort.abort()
    this.listeners.clear()
  }
}
