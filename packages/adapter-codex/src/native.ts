import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { CodexRpc, type CodexOptions } from './rpc.js'
import { codexItems, nativeSnapshot, type NativeSnapshot } from './context.js'
import type { PortableContext } from '../../protocol/src/portable.js'

export interface Target {
  cwd: string
  model: string
  provider?: string
  sandbox: 'read-only' | 'workspace-write'
}
export const targetSchema = z
  .object({
    cwd: z.string().min(1),
    model: z.string().trim().min(1).max(256),
    provider: z.string().min(1).max(256).optional(),
    sandbox: z.enum(['read-only', 'workspace-write']),
  })
  .strict()
export class NativeCodex {
  readonly rpc: CodexRpc
  selectedProvider?: string
  constructor(options: CodexOptions = {}) {
    this.rpc = new CodexRpc(options)
  }
  async init() {
    await this.rpc.initialize()
  }
  async target(input: Target): Promise<Target> {
    const target = targetSchema.parse(input)
    const cwd = await realpath(target.cwd)
    if (!(await stat(cwd)).isDirectory())
      throw new Error('Choose an existing project directory on this device')
    return { ...target, cwd }
  }
  async start(
    target: Target,
    config?: Record<string, unknown>,
    developerInstructions?: string,
  ) {
    const r = z
      .object({
        thread: nativeSnapshot.shape.thread,
        model: z.string(),
        cwd: z.string(),
        sandbox: z.object({ type: z.string() }).passthrough(),
        approvalPolicy: z.literal('never'),
      })
      .passthrough()
      .parse(
        await this.rpc.request('thread/start', {
          ...target,
          ...(target.provider ? { modelProvider: target.provider } : {}),
          ...(config ? { config } : {}),
          ...(developerInstructions ? { developerInstructions } : {}),
          approvalPolicy: 'never',
        }),
      )
    if (
      r.sandbox.type !==
        (target.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite') ||
      (target.provider !== undefined && r.modelProvider !== target.provider) ||
      r.model !== target.model ||
      (await realpath(r.cwd)) !== target.cwd
    )
      throw new Error(
        'Codex did not accept the selected local model and directory',
      )
    if (!/^0\.(15[4-9]|1[6-9]\d|[2-9]\d\d)\./.test(r.thread.cliVersion))
      throw new Error('Use Codex CLI 0.154.x or a compatible newer 0.x CLI')
    this.selectedProvider = z
      .string()
      .min(1)
      .parse(r.modelProvider ?? r.thread.modelProvider)
    return r.thread.id
  }
  async inject(threadId: string, context: PortableContext) {
    await this.rpc.request('thread/inject_items', {
      threadId,
      items: codexItems(context),
    })
  }
  async resume(threadId: string, target: Target) {
    const r = z
      .object({
        thread: nativeSnapshot.shape.thread,
        model: z.string(),
        cwd: z.string(),
        sandbox: z.object({ type: z.string() }).passthrough(),
        approvalPolicy: z.literal('never'),
      })
      .passthrough()
      .parse(
        await this.rpc.request('thread/resume', {
          threadId,
          ...target,
          ...(target.provider ? { modelProvider: target.provider } : {}),
          approvalPolicy: 'never',
          excludeTurns: true,
        }),
      )
    if (
      r.sandbox.type !==
        (target.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite') ||
      r.thread.id !== threadId ||
      (target.provider !== undefined && r.modelProvider !== target.provider) ||
      r.model !== target.model ||
      (await realpath(r.cwd)) !== target.cwd
    )
      throw new Error('Codex resumed a different thread, model or directory')
    if (r.thread.status.type !== 'idle')
      throw new Error('The local Codex thread is not idle')
  }
  private async page(method: string, threadId: string) {
    const data: unknown[] = [],
      cursors = new Set<string>()
    let cursor: string | null = null
    do {
      const result = z
        .object({
          data: z.array(z.unknown()),
          nextCursor: z.string().nullable(),
        })
        .parse(
          await this.rpc.request(method, {
            threadId,
            cursor,
            limit: 100,
            sortDirection: 'asc',
            ...(method === 'thread/turns/list' ? { itemsView: 'summary' } : {}),
          }),
        )
      data.push(...result.data)
      if (data.length > 10000)
        throw new Error(
          'Native history exceeds the snapshot limit; no history was truncated',
        )
      cursor = result.nextCursor
      if (cursor && cursors.has(cursor))
        throw new Error('Codex pagination did not advance')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    return data
  }
  async snapshot(threadId: string): Promise<NativeSnapshot> {
    const read = async () =>
      z.object({ thread: nativeSnapshot.shape.thread }).parse(
        await this.rpc.request('thread/read', {
          threadId,
          includeTurns: false,
        }),
      ).thread
    const thread = await read()
    if (thread.id !== threadId || thread.status.type !== 'idle')
      throw new Error('Wait for native Codex work to finish before exporting')
    const turns = await this.page('thread/turns/list', threadId),
      items = await this.page('thread/items/list', threadId)
    const result = nativeSnapshot.parse({ thread, turns, items })
    if (result.turns.some((t) => t.status === 'inProgress'))
      throw new Error('A native turn is still executing')
    for (const { item } of result.items) {
      if (
        'status' in item &&
        !['completed', 'failed', 'declined'].includes(String(item.status))
      )
        throw new Error('Native tool work is not settled')
      if (
        item.type === 'commandExecution' &&
        item.processId != null &&
        item.exitCode == null
      )
        throw new Error('Stop native background commands before exporting')
    }
    const final = await read()
    if (
      final.status.type !== 'idle' ||
      JSON.stringify(turns) !==
        JSON.stringify(await this.page('thread/turns/list', threadId))
    )
      throw new Error(
        'Native history changed during export; no snapshot was committed',
      )
    if (Buffer.byteLength(JSON.stringify(result)) > 6 * 1024 * 1024)
      throw new Error('Native snapshot exceeds the archive limit')
    return result
  }
  async execute(
    threadId: string,
    message: string,
    timeoutMs = 30 * 60 * 1000,
    clientMessageId?: string,
  ) {
    if (!message.trim())
      throw new Error('Provide a new instruction to continue the task')
    let completed: { id: string; status: string } | undefined
    let accept: (value: { id: string; status: string }) => void = () => {}
    let reject: (error: Error) => void = () => {}
    const done = new Promise<{ id: string; status: string }>((ok, fail) => {
      accept = ok
      reject = fail
    })
    // Attach a rejection handler before dispatch; a transport can fail while turn/start is pending.
    void done.catch(() => {})
    const notification = (method: string, input: unknown) => {
      if (method !== 'turn/completed') return
      const parsed = z
        .object({
          threadId: z.string(),
          turn: z.object({ id: z.string(), status: z.string() }),
        })
        .safeParse(input)
      if (parsed.success && parsed.data.threadId === threadId) {
        completed = parsed.data.turn
        accept(completed)
      }
    }
    const disconnected = () =>
      reject(
        new Error(
          'Codex disconnected during execution; inspect the previous task before recovery',
        ),
      )
    this.rpc.on('notification', notification)
    this.rpc.on('disconnected', disconnected)
    const timer = setTimeout(() => {
      void this.rpc
        .request('turn/interrupt', { threadId, turnId: startedId })
        .catch(() => {})
      reject(
        new Error(
          'Codex execution timed out; confirm the process and its tools stopped before recovery',
        ),
      )
    }, timeoutMs)
    let startedId: string | undefined
    try {
      const response = z.object({ turn: z.object({ id: z.string() }) }).parse(
        await this.rpc.request('turn/start', {
          threadId,
          ...(clientMessageId ? { clientUserMessageId: clientMessageId } : {}),
          input: [{ type: 'text', text: message, text_elements: [] }],
        }),
      )
      startedId = response.turn.id
      const turn = completed ?? (await done)
      if (
        turn.id !== startedId ||
        !['completed', 'failed', 'interrupted'].includes(turn.status)
      )
        throw new Error('Codex returned an inconsistent turn completion')
      return turn
    } finally {
      clearTimeout(timer)
      this.rpc.off('notification', notification)
      this.rpc.off('disconnected', disconnected)
    }
  }
  close() {
    return this.rpc.close()
  }
}
