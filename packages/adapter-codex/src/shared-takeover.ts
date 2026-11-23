import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ArchiveClient } from '../../client/src/archives.js'
import { planArchiveResume } from '../../client/src/resume-archive.js'
import { prepareSharedArchive } from '../../handoff-deepseek/src/shared-archive.js'
import { atomicJson, optionalJson } from '../../runtime-manager/src/files.js'
import { CodexSharedSync } from './shared-sync.js'
import { ConfirmedCodexTakeover } from './takeover.js'
import { NativeCodex, type StartTarget, targetSchema } from './native.js'
import { codexArchiveBudget } from './archive-budget.js'

const journal = z.object({
  shareId: z.uuid(),
  generation: z.number(),
  thread: z.uuid(),
  token: z.uuid(),
  target: targetSchema,
  archive: z.object({ cut: z.number(), archiveId: z.string() }).optional(),
  injected: z.boolean().default(false),
  dispatch: z.boolean().default(false),
})

export async function receiveAntigravity(
  sync: CodexSharedSync,
  id: string,
  operationId: string,
  requested: StartTarget,
) {
  const file = join(
    sync.directory,
    'takeovers',
    z.uuid().parse(operationId) + '.json',
  )
  let state = journal.optional().parse(await optionalJson(file))
  if (state && state.shareId !== id)
    throw Error('This operation belongs to another shared conversation')
  const client = sync.client
  const native = new NativeCodex(sync.options.native)
  try {
    await native.init()
    if (!state) {
      const { share, events } = await client.pull(id)
      if (share.source.adapter !== 'antigravity' || !events.length)
        throw Error('Refresh the source conversation and its saved history')
      const checked = await new ConfirmedCodexTakeover(sync.options).probe(
        { ...requested, cwd: await realpath(requested.cwd) },
        {
          version: 1,
          source: { ...share.source, eventCount: share.nextSeq },
          messages: events.map((e) => ({ role: e.role, text: e.preview })),
        },
      )
      await codexArchiveBudget(native, checked.target)
      const { threadId } = await native.start(checked.target)
      state = {
        shareId: id,
        generation: share.generation,
        thread: threadId,
        target: checked.target,
        token: randomUUID(),
        injected: false,
        dispatch: false,
      }
      await atomicJson(file, state)
    } else await native.resume(state.thread, state.target)
    if (state.dispatch)
      throw Error(
        'A continuation was already dispatched. Inspect the local Codex conversation before continuing.',
      )
    const proof = {
      operationId,
      thread: state.thread,
      generation: state.generation,
      token: state.token,
      receiver: 'codex' as const,
    }
    let head = await client.transfer(id, { action: 'request', ...proof })
    while (head.transfer?.phase === 'requested') {
      await delay(1000)
      head = (await client.pull(id)).share
      if (head.transfer?.id !== operationId) throw Error('The transfer changed')
    }
    if (!state.archive) {
      state.archive = await prepareSharedArchive(
        client,
        join(sync.directory, 'cuts'),
        id,
      )
      await atomicJson(file, state)
    }
    if (!state.injected) {
      const budget = await codexArchiveBudget(native, state.target)
      const plan = await planArchiveResume(
        new ArchiveClient(client.mesh),
        state.archive.archiveId,
        budget,
      )
      await native.inject(state.thread, plan.context)
      state.injected = true
      await atomicJson(file, state)
    }
    const owner = await client.transfer(id, {
      ...proof,
      action: 'claim',
      cut: state.archive.cut,
    })
    await sync.bindTransferred(owner, state.thread, state.token, native)
    if (!owner.transfer?.interrupted) {
      await client.activity(
        id,
        { generation: owner.generation, writerToken: state.token },
        'import',
        'idle',
      )
      await sync.tick()
      return state.thread
    }
    state.dispatch = true
    await atomicJson(file, state)
    const result = await native.execute(
      state.thread,
      'Continue the unfinished task from the transferred history. Verify uncertain side effects before repeating an operation.',
      undefined,
      operationId,
    )
    if (await native.threadSettled(state.thread))
      await client.activity(
        id,
        { generation: owner.generation, writerToken: state.token },
        result.id,
        'idle',
      )
    await sync.tick()
    if (result.status !== 'completed')
      throw Error(
        'The continued turn did not complete. Open its Codex conversation to inspect it.',
      )
    return state.thread
  } finally {
    await native.close()
  }
}
