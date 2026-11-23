import { it, expect, vi } from 'vitest'
import {
  realpath,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  appendFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fixture } from '../fixture.js'
import { AntigravityArchives } from '../../apps/antigravity/src/actions.js'
import { AntigravityLive } from '../../apps/antigravity/src/live.js'
import { SharedClient } from '../../packages/client/src/shared.js'
import { codexArchives } from '../../packages/client/src/codex-context.js'

it('publishes a portable note and reads it back through the receiver catalog and bounded preview', async () => {
  const f = await fixture(),
    panel = new AntigravityArchives(f.client),
    id = randomUUID()
  const archive = await panel.publish(id, 'Task', 'Resume from step four.')
  expect(await panel.publish(id, 'Task', 'Resume from step four.')).toEqual(
    archive,
  )
  expect(await codexArchives(f.client)).toContainEqual(
    expect.objectContaining({ id: archive.id, title: 'Task' }),
  )
  expect((await panel.preview(archive.id, 'continue')).messages).toContainEqual(
    { role: 'user', text: 'Resume from step four.' },
  )
})
it('drains a running Antigravity source after receiver preflight and continues the same share once, including the final tool output', async () => {
  const f = await fixture(),
    root = await realpath(await mkdtemp(join(tmpdir(), 'cm-agy-')))
  f.defer(() => rm(root, { recursive: true, force: true }))
  const a = new AntigravityLive(
      new SharedClient(f.client),
      join(root, 'a'),
      join(root, 'native-a'),
    ),
    b = new AntigravityLive(
      new SharedClient(f.client),
      join(root, 'b'),
      join(root, 'native-b'),
    )
  const from = randomUUID(),
    to = randomUUID(),
    file = join(
      a.gemini,
      'antigravity',
      'brain',
      from,
      '.system_generated/logs',
    )
  await mkdir(file, { recursive: true })
  const log = join(file, 'transcript.jsonl')
  await writeFile(
    log,
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      source: 'USER_EXPLICIT',
      status: 'DONE',
      content:
        '<USER_REQUEST>Continue the build</USER_REQUEST><METADATA>private</METADATA>',
    }) + '\n',
  )
  const { id } = await a.share('antigravity', from, 'Build')
  const s = (await a.source(from))!
  await a.boundary(s, 'PreInvocation', false)
  await b.followers.follow(id)
  const ticket = await b.ticket(id)
  const accepting = b.accept(
    ticket.prompt.split('\n')[0]!.split(' ').at(-1)!,
    to,
    'antigravity',
  )
  await expect
    .poll(async () => (await a.client.pull(id)).share.transfer?.phase)
    .toBe('requested')
  expect(await a.boundary(s, 'PreToolUse', false)).toBe('stop')
  await a.boundary(s, 'Stop', false)
  expect((await a.client.pull(id)).share.source.id).toBe(from)
  await appendFile(
    log,
    JSON.stringify({
      step_index: 1,
      type: 'GENERIC',
      source: 'MODEL',
      status: 'DONE',
      content: 'Build finished 271',
      thinking: 'private',
    }) + '\n',
  )
  await a.boundary(s, 'Stop', true)
  const resumed = await accepting
  expect(resumed?.injectSteps?.[0]?.userMessage).toContain('Build finished 271')
  expect(resumed?.injectSteps?.[0]?.userMessage).not.toContain('private')
  expect((await a.client.pull(id)).share).toMatchObject({
    generation: 1,
    source: { id: to, adapter: 'antigravity' },
  })
  expect(await a.boundary(s, 'PreInvocation', false)).toBe('stop')
  const directory = join(
    b.gemini,
    'antigravity',
    'brain',
    to,
    '.system_generated/logs',
  )
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'transcript.jsonl'),
    JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      source: 'MODEL',
      status: 'DONE',
      content: 'Next step complete',
    }) + '\n',
  )
  await b.tick()
  expect((await b.followers.list())[0]?.records.map((r) => r.preview)).toEqual([
    'Continue the build',
    'Build finished 271',
    'Next step complete',
  ])
})

it('catches up a restarted follower after a lost upload receipt and a split UTF-8 record, and publishes the complete chunked snapshot', async () => {
  const f = await fixture(),
    root = await realpath(await mkdtemp(join(tmpdir(), 'cm-agy-offline-')))
  f.defer(() => rm(root, { recursive: true, force: true }))
  const client = new SharedClient(f.client),
    state = join(root, 'a'),
    gemini = join(root, 'native')
  const a = new AntigravityLive(client, state, gemini),
    reader = new AntigravityLive(client, join(root, 'b'), gemini)
  const thread = randomUUID(),
    directory = join(
      gemini,
      'antigravity',
      'brain',
      thread,
      '.system_generated/logs',
    )
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'transcript_full.jsonl')
  const line = (index: number, text: string) =>
    Buffer.from(
      JSON.stringify({
        step_index: index,
        type: 'PLANNER_RESPONSE',
        source: 'MODEL',
        status: 'DONE',
        content: text,
      }) + '\r\n',
    )
  await writeFile(file, line(0, 'first'))
  const { id } = await a.share('antigravity', thread, 'Offline')
  await reader.followers.follow(id)
  const long = '中'.repeat(360000) + ' END-MARKER'
  const entry = line(1, long),
    split = entry.indexOf(Buffer.from('中')) + 1
  await appendFile(file, entry.subarray(0, split))
  await a.tick()
  expect((await client.pull(id)).events).toHaveLength(1)
  await appendFile(file, entry.subarray(split))
  const append = client.append.bind(client)
  vi.spyOn(client, 'append').mockImplementationOnce(async (...args) => {
    await append(...args)
    throw Error('Lost acknowledgement')
  })
  await a.tick()
  const resumed = new AntigravityLive(client, state, gemini)
  await resumed.tick()
  await reader.tick()
  const feed = (await reader.followers.list())[0]!
  expect(feed.records).toHaveLength(2)
  expect((await client.pull(id)).events.map((e) => e.bytes)).toEqual([
    5,
    Buffer.byteLength(long),
  ])
  const archive = await resumed.snapshot('antigravity', thread, 'Offline')
  const info = await new AntigravityArchives(f.client).archives.info(archive.id)
  expect(info.manifest.bytes).toBeGreaterThan(1024 * 1024)
  expect(info.manifest.records).toBe(2)
})
