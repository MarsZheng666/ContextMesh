import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixture, TOKEN } from '../fixture.js'
import { SharedClient } from '../../packages/client/src/shared.js'
import { SharedFollowers } from '../../packages/client/src/shared-follow.js'
import { MeshClient } from '../../packages/client/src/index.js'

async function publisher() {
  const f = await fixture()
  const client = new SharedClient(f.client)
  const id = randomUUID(),
    thread = randomUUID(),
    writer = { generation: 0, writerToken: randomUUID() }
  await client.create({
    id,
    title: 'Shared test',
    scope: 'full',
    source: { adapter: 'codex', id: thread, incarnation: thread },
    writerToken: writer.writerToken,
  })
  return { f, client, id, writer }
}
it('recovers a lost upload receipt and a restarted follower without duplicating or losing records', async () => {
  const { f, client, id, writer } = await publisher()
  const directory = await mkdtemp(join(tmpdir(), 'cm-shared-'))
  f.defer(() => rm(directory, { recursive: true, force: true }))
  const before = new SharedFollowers(client, directory)
  await before.follow(id)
  let lost = false
  const unreliable = new SharedClient(
    new MeshClient({
      endpoint: f.endpoint,
      token: TOKEN,
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        if (
          init?.method === 'POST' &&
          String(input).endsWith('/events') &&
          !lost
        ) {
          lost = true
          await response.arrayBuffer()
          throw new Error('acknowledgement lost')
        }
        return response
      },
    }),
  )
  await unreliable.append(id, writer, {
    key: 'tool-1',
    turn: 'turn-1',
    role: 'reference',
    kind: 'tool',
    status: 'running',
    text: 'run tests',
  })
  await before.tick()
  expect((await before.list())[0]?.records).toHaveLength(1)
  await client.append(id, writer, {
    key: 'tool-1',
    turn: 'turn-1',
    role: 'reference',
    kind: 'tool',
    status: 'completed',
    text: 'all tests passed',
  })
  await client.append(id, writer, {
    key: 'reply',
    turn: 'turn-1',
    role: 'assistant',
    kind: 'message',
    text: 'finished',
  })
  const after = new SharedFollowers(client, directory)
  await after.tick()
  const saved = (await after.list())[0]!
  expect(saved.cursor).toBe(3)
  expect(saved.records).toHaveLength(2)
  expect(saved.records[0]?.status).toBe('completed')
  await after.tick()
  expect((await after.list())[0]?.cursor).toBe(3)
})
it('shares long UTF-8 tool output in verified blocks and rejects another publisher', async () => {
  const { client, id, writer } = await publisher()
  const text = '\uFEFF' + '日志😀\n'.repeat(180000)
  const item = {
    key: 'large-tool',
    turn: 'turn-1',
    role: 'reference' as const,
    kind: 'tool',
    status: 'completed',
    text,
  }
  await client.append(id, writer, item)
  let read = '',
    offset: number | null = 0
  while (offset !== null) {
    const page = await client.text(id, 0, offset, 4093)
    read += page.text
    offset = page.next
  }
  expect(read).toBe(text)
  await expect(
    client.append(id, { ...writer, writerToken: randomUUID() }, item),
  ).rejects.toMatchObject({ code: 'OWNERSHIP_LOST' })
})
it('follows native DSH history while new events are appended across page boundaries', async () => {
  const f = await fixture(),
    client = new SharedClient(f.client)
  const handle = await f.client.create(
    { id: randomUUID(), version: 4, createdAt: 1, isSeeded: false },
    0,
  )
  const make = (seq: number) => ({
    seq,
    type: 'user/message',
    time: seq,
    data: {
      turn: seq,
      id: 'user-' + seq,
      content: [{ type: 'text', text: 'message ' + seq }],
    },
  })
  await f.client.append(
    handle,
    Array.from({ length: 250 }, (_, i) => make(i)),
    randomUUID(),
  )
  const share = await client.create({
    id: randomUUID(),
    title: 'DSH',
    scope: 'full',
    source: {
      adapter: 'deepseek',
      id: handle.session.id,
      incarnation: handle.session.incarnation,
    },
    writerToken: randomUUID(),
  })
  const first = await client.pull(share.id)
  expect(first.events).toHaveLength(200)
  await f.client.append(handle, [make(250)], randomUUID())
  const next = await client.pull(share.id, first.next)
  expect(next.events).toHaveLength(51)
  expect(next.next).toBe(251)
  expect((await client.text(share.id, 250)).text).toBe('message 250')
  await f.client.close(handle, randomUUID())
})
it('enforces the selected scope and namespaces for shared records', async () => {
  const { client, id, writer, f } = await publisher()
  const other = await fixture()
  expect(await new SharedClient(other.client).list()).toEqual([])
  await expect(new SharedClient(other.client).pull(id)).rejects.toMatchObject({
    code: 'NOT_FOUND',
  })
  await f.store.pool.query(
    "UPDATE cm_shared_sessions SET scope='text' WHERE namespace=$1 AND id=$2",
    [f.namespace, id],
  )
  await expect(
    client.append(id, writer, {
      key: 'tool',
      turn: 't',
      role: 'reference',
      kind: 'tool',
      text: 'private tool',
    }),
  ).rejects.toMatchObject({ code: 'SHARING_SCOPE' })
})

it('keeps tools busy across Stop and ignores delayed Stop from an earlier turn', async () => {
  const { client, id, writer } = await publisher()
  await client.activity(id, writer, 'one', 'busy')
  await client.activity(id, writer, 'one', 'busy', 'tool')
  await client.activity(id, writer, 'one', 'idle')
  expect((await client.pull(id)).share.activity).toBe('busy')
  await client.activity(id, writer, 'one', 'idle', 'tool')
  expect((await client.pull(id)).share.activity).toBe('idle')
  await client.activity(id, writer, 'two', 'busy')
  await client.activity(id, writer, 'one', 'idle')
  expect((await client.pull(id)).share.activity).toBe('busy')
})

it('does not regress a completed tool when its start arrives late', async () => {
  const { client, id, writer } = await publisher()
  await client.append(id, writer, {
    key: 'tool',
    turn: 't',
    role: 'reference',
    kind: 'tool',
    status: 'completed',
    text: 'done',
  })
  await client.append(id, writer, {
    key: 'tool',
    turn: 't',
    role: 'reference',
    kind: 'tool',
    status: 'running',
    text: 'start',
  })
  const page = await client.pull(id)
  expect(page.next).toBe(1)
  expect(page.events[0]?.status).toBe('completed')
})

it('serializes concurrent follower processes so an older page cannot replace a newer cursor', async () => {
  const { f, client, id, writer } = await publisher()
  const directory = await mkdtemp(join(tmpdir(), 'cm-shared-concurrent-'))
  f.defer(() => rm(directory, { recursive: true, force: true }))
  const a = new SharedFollowers(client, directory),
    b = new SharedFollowers(client, directory)
  await Promise.all([a.follow(id), b.follow(id)])
  for (let i = 0; i < 4; i++)
    await client.append(id, writer, {
      key: 'm' + i,
      turn: 't',
      role: 'user',
      kind: 'message',
      text: 'message ' + i,
    })
  await Promise.all([a.tick(), b.tick()])
  const result = (await a.list())[0]!
  expect(result.cursor).toBe(4)
  expect(result.records).toHaveLength(4)
})
