import { archiveItem } from './archive-capture.js'
import type { ArchiveRecord } from '../../client/src/archive-record.js'
import type {
  ArchiveHeader,
  ResumeContext,
} from '../../protocol/src/archives.js'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { z } from 'zod'
import { CodexRpc, type CodexOptions } from './rpc.js'
import { codexItems, nativeSnapshot, type NativeSnapshot } from './context.js'
import {
  portableContextMaxBytes,
  portableContextMaxMessages,
  validatePortable,
  type PortableContext,
} from '../../protocol/src/portable.js'
import {
  assertCodexItemSettled,
  projectCodexMessage,
  type CodexArchiveScope,
} from '../../protocol/src/codex-context.js'

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
export const startTargetSchema = targetSchema.partial({ model: true })
export type StartTarget = z.infer<typeof startTargetSchema>

export class CodexArchiveTextFallback extends Error {}

export class NativeCodex {
  readonly rpc: CodexRpc
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
    target: StartTarget,
    config?: Record<string, unknown>,
    developerInstructions?: string,
    ephemeral = false,
  ) {
    const r = z
      .object({
        thread: nativeSnapshot.shape.thread,
        model: targetSchema.shape.model,
        cwd: z.string(),
        sandbox: z.object({ type: z.string() }).passthrough(),
        approvalPolicy: z.literal('never'),
      })
      .passthrough()
      .parse(
        await this.rpc.request('thread/start', {
          ...target,
          ...(ephemeral ? { ephemeral: true } : {}),
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
      (target.model !== undefined && r.model !== target.model) ||
      (await realpath(r.cwd)) !== target.cwd
    )
      throw new Error(
        'Codex did not accept the selected local model and directory',
      )
    if (!/^0\.(15[4-9]|1[6-9]\d|[2-9]\d\d)\./.test(r.thread.cliVersion))
      throw new Error('Use Codex CLI 0.154.x or a compatible newer 0.x CLI')
    const provider = targetSchema.shape.provider
      .unwrap()
      .parse(r.modelProvider ?? r.thread.modelProvider)
    return {
      threadId: r.thread.id,
      target: { ...target, model: r.model, provider },
    }
  }
  async inject(threadId: string, context: ResumeContext) {
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
  private async *pages(
    method: 'thread/turns/list' | 'thread/items/list',
    threadId: string,
    limit = 100,
    maxItems = 10000,
  ) {
    const cursors = new Set<string>()
    let cursor: string | null = null
    let count = 0
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
            limit,
            sortDirection: 'asc',
            ...(method === 'thread/turns/list' ? { itemsView: 'summary' } : {}),
          }),
        )
      count += result.data.length
      if (count > maxItems)
        throw new Error('Native history exceeds the scan limit for one archive')
      cursor = result.nextCursor
      if (cursor && cursors.has(cursor))
        throw new Error('Codex pagination did not advance')
      if (cursor) cursors.add(cursor)
      yield result.data
    } while (cursor)
  }
  private async page(
    method: 'thread/turns/list' | 'thread/items/list',
    threadId: string,
    maxItems = 10000,
  ) {
    const data: unknown[] = []
    for await (const page of this.pages(method, threadId, 100, maxItems))
      data.push(...page)
    return data
  }
  async savedThreads() {
    return z
      .object({
        data: z.array(
          z.object({
            id: z.uuid(),
            name: z.string().nullable().optional(),
            preview: z.string(),
            cwd: z.string(),
            updatedAt: z.number(),
          }),
        ),
      })
      .parse(
        await this.rpc.request('thread/list', {
          archived: false,
          limit: 50,
          sortKey: 'updated_at',
          modelProviders: [],
          sourceKinds: ['appServer', 'cli', 'vscode', 'unknown'],
        }),
      ).data
  }
  private async readThread(threadId: string) {
    return z.object({ thread: nativeSnapshot.shape.thread }).parse(
      await this.rpc.request('thread/read', {
        threadId,
        includeTurns: false,
      }),
    ).thread
  }
  async snapshot(threadId: string): Promise<NativeSnapshot> {
    const thread = await this.readThread(threadId)
    if (thread.id !== threadId || thread.status.type !== 'idle')
      throw new Error('Wait for native Codex work to finish before exporting')
    const turns = await this.page('thread/turns/list', threadId),
      items = await this.page('thread/items/list', threadId)
    const result = nativeSnapshot.parse({ thread, turns, items })
    if (result.turns.some((t) => t.status === 'inProgress'))
      throw new Error('A native turn is still executing')
    for (const { item } of result.items) assertCodexItemSettled(item)
    const final = await this.readThread(threadId)
    if (
      final.id !== threadId ||
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
  private async scanSavedItems(
    threadId: string,
    visit?: (value: unknown) => void | Promise<void>,
    largePage?: number,
  ) {
    const hash = createHash('sha256')
    let count = 0
    let bytes = 0
    for await (const page of this.pages(
      'thread/items/list',
      threadId,
      largePage ?? 50,
      largePage === undefined ? 50000 : Number.MAX_SAFE_INTEGER,
    )) {
      for (const entry of page) {
        const serialized = JSON.stringify(entry)
        bytes += Buffer.byteLength(serialized)
        if (largePage === undefined && bytes > 128 * 1024 * 1024)
          throw new Error(
            'Native history exceeds the scan limit for one archive',
          )
        hash.update(serialized).update('\n')
        count++
        await visit?.(entry)
      }
    }
    return { count, digest: hash.digest('hex') }
  }
  private async archiveCut(
    threadId: string,
    pageSize: number,
    allowEmpty: boolean,
    visit: (entry: NativeSnapshot['items'][number]) => void | Promise<void>,
  ) {
    const settled = (thread: NativeSnapshot['thread']) =>
      thread.id === threadId &&
      ['idle', 'notLoaded'].includes(thread.status.type)
    const thread = await this.readThread(threadId)
    if (!settled(thread))
      throw new Error('Wait for native Codex work to finish before publishing')
    const readTurns = () =>
      this.page('thread/turns/list', threadId, Number.MAX_SAFE_INTEGER)
    const turns = await readTurns()
    const checkedTurns = nativeSnapshot.shape.turns.parse(turns)
    if (
      (!allowEmpty && !checkedTurns.length) ||
      checkedTurns.some((turn) => turn.status === 'inProgress')
    )
      throw new Error(
        'Wait for the active Codex turn to settle before publishing',
      )

    const saved = await this.scanSavedItems(
      threadId,
      (value) => visit(nativeSnapshot.shape.items.element.parse(value)),
      pageSize,
    )
    const verified = await this.scanSavedItems(threadId, undefined, pageSize)
    if (
      saved.digest !== verified.digest ||
      JSON.stringify(turns) !== JSON.stringify(await readTurns()) ||
      !settled(await this.readThread(threadId))
    )
      throw new Error(
        'Native history changed during export; review a new snapshot',
      )
    return {
      thread,
      eventCount: saved.count,
      interrupted:
        checkedTurns.length > 0 && checkedTurns.at(-1)?.status !== 'completed',
      nativeDigest: createHash('sha256')
        .update(saved.digest)
        .update(JSON.stringify(turns))
        .digest('hex'),
    }
  }
  async captureArchive(
    threadId: string,
    scope: ArchiveHeader['scope'],
    append: (record: ArchiveRecord) => Promise<void>,
    pageSize: number,
  ) {
    const coverage = { omittedAttachments: 0, unrecognizedItems: 0 }
    const cut = await this.archiveCut(
      threadId,
      pageSize,
      false,
      async (item) => {
        const record = archiveItem(item, scope, coverage)
        if (record) await append(record)
      },
    )
    return { ...cut, ...coverage }
  }
  async savedCutDigest(threadId: string, pageSize: number) {
    const cut = await this.archiveCut(threadId, pageSize, true, ({ item }) =>
      assertCodexItemSettled(item),
    )
    return cut.nativeDigest
  }
  async savedArchive(
    threadId: string,
    inherited: PortableContext['messages'],
    scope: CodexArchiveScope,
  ) {
    const settled = (thread: NativeSnapshot['thread']) =>
      thread.id === threadId &&
      ['idle', 'notLoaded'].includes(thread.status.type)
    const thread = await this.readThread(threadId)
    if (!settled(thread))
      throw new Error('Wait for native Codex work to finish before publishing')
    const turns = await this.page('thread/turns/list', threadId)
    const statuses = nativeSnapshot.shape.turns.parse(turns)
    const latest = statuses.at(-1)?.status
    if (!latest || statuses.some((turn) => turn.status === 'inProgress'))
      throw new Error(
        'Wait for the active Codex turn to settle before publishing',
      )
    if (scope === 'full' && latest !== 'completed')
      throw new CodexArchiveTextFallback(
        'A full archive needs a completed latest turn. Choose Conversation text only to share the saved conversation.',
      )

    const tooLarge = (limit = '1 MiB') =>
      scope === 'full'
        ? new CodexArchiveTextFallback(
            `The full archive exceeds ${limit}. Choose Conversation text only to share the saved conversation.`,
          )
        : new Error(
            `The conversation text exceeds the archive limit of ${limit}.`,
          )
    const messages: PortableContext['messages'] = []
    let messageBytes = 0
    const append = (message: PortableContext['messages'][number]) => {
      messageBytes +=
        Buffer.byteLength(JSON.stringify(message)) + (messages.length ? 1 : 0)
      if (messageBytes > portableContextMaxBytes) throw tooLarge()
      if (messages.length >= portableContextMaxMessages)
        throw tooLarge('10,000 messages')
      messages.push(message)
    }
    if (scope === 'text')
      append({
        role: 'reference',
        text: 'ContextMesh archive contains conversation text only. Tool outputs and attachments remain in the source conversation.',
      })
    for (const message of inherited)
      if (scope === 'full' || message.role !== 'reference') append(message)
    const saved = await this.scanSavedItems(threadId, (value) => {
      const { item } = nativeSnapshot.shape.items.element.parse(value)
      assertCodexItemSettled(item)
      let message
      try {
        message = projectCodexMessage(item, scope)
      } catch (error) {
        if (scope === 'full')
          throw new CodexArchiveTextFallback(
            'The full archive contains unsupported items. Choose Conversation text only to share the saved conversation.',
            { cause: error },
          )
        throw error
      }
      if (message) append(message)
    })
    if (messages.length === (scope === 'text' ? 1 : 0))
      throw new Error('There are no saved conversation messages to publish')
    const checked = await this.scanSavedItems(threadId)
    if (
      saved.digest !== checked.digest ||
      JSON.stringify(turns) !==
        JSON.stringify(await this.page('thread/turns/list', threadId)) ||
      !settled(await this.readThread(threadId))
    )
      throw new Error(
        'Native history changed during export; no snapshot was committed',
      )
    const context: PortableContext = {
      version: 1,
      source: {
        adapter: 'codex',
        id: threadId,
        incarnation: threadId,
        eventCount: saved.count,
      },
      messages,
    }
    if (Buffer.byteLength(JSON.stringify(context)) > portableContextMaxBytes)
      throw tooLarge()
    return { thread, context: validatePortable(context) }
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
