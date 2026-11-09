import { buildServer } from '../../apps/server/src/app.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ArchiveSpool } from '../../packages/adapter-codex/src/archive-spool.js'
import { ArchiveClient } from '../../packages/client/src/archives.js'
import { MeshClient } from '../../packages/client/src/index.js'
import {
  archiveBlockBytes,
  archiveIdentity,
  archiveSha256,
} from '../../packages/protocol/src/archives.js'
import { fixture, TOKEN } from '../fixture.js'

it('commits more than 64 MiB without assembling the archive, resumes a lost acknowledgement, and verifies exact ranges', async () => {
  const f = await fixture()
  const directory = await mkdtemp(join(tmpdir(), 'cm-v2-archive-'))
  f.defer(() => rm(directory, { recursive: true, force: true }))
  const client = new ArchiveClient(f.client)
  const spool = new ArchiveSpool(directory, f.endpoint)
  const sourceId = randomUUID()
  const line = 'fixture data ' + 'x'.repeat(1980) + '\n'
  const body =
    line.repeat(Math.ceil((16 * 1024 ** 2) / Buffer.byteLength(line))) +
    '测试失败 tests/handoff.spec.ts ECONNREFUSED 🌏\n'
  const { manifest } = await spool.prepare(async (append) => {
    await append({
      role: 'user',
      kind: 'userMessage',
      turn: '1',
      text: 'Fix tests/handoff.spec.ts ECONNREFUSED',
    })
    for (let index = 0; index < 4; index++)
      await append({
        role: 'reference',
        kind: 'commandExecution',
        turn: '1',
        status: 'failed',
        text: body,
      })
    await append({
      role: 'assistant',
      kind: 'agentMessage',
      turn: '1',
      text: 'The timeout is still unresolved.',
    })
    return {
      version: 2,
      title: 'Synthetic large archive',
      scope: 'full',
      source: {
        adapter: 'codex',
        id: sourceId,
        incarnation: sourceId,
        eventCount: 6,
      },
      omittedAttachments: 0,
      unrecognizedItems: 0,
      interrupted: true,
    }
  })
  expect(manifest.bytes).toBeGreaterThan(64 * 1024 ** 2)
  const id = archiveIdentity(manifest)
  const begun = await client.begin(manifest)
  expect(begun).toEqual({ id, next: 0, committed: false })
  const block = Buffer.alloc(archiveBlockBytes)
  await expect(client.put(id, 0, block, '0'.repeat(64))).rejects.toMatchObject({
    code: 'ARCHIVE_BLOCK_CHECKSUM',
  })
  await expect(
    client.put(id, 1, block, archiveSha256(block)),
  ).rejects.toMatchObject({ code: 'ARCHIVE_CONFLICT' })
  await expect(
    f.store.archiveUpload(f.namespace, 'other-device', id),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })

  let disconnected = false
  const unreliable = new ArchiveClient(
    new MeshClient({
      endpoint: f.endpoint,
      token: TOKEN,
      retries: 0,
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        if (!disconnected && String(input).endsWith('/blocks/2')) {
          expect(response.ok).toBe(true)
          await response.arrayBuffer()
          disconnected = true
          throw new Error('synthetic lost response')
        }
        return response
      },
    }),
  )
  await expect(spool.upload(unreliable)).rejects.toMatchObject({
    code: 'UNAVAILABLE',
  })
  expect(disconnected).toBe(true)
  expect((await client.begin(manifest)).next).toBe(3)
  await expect(client.commit(id)).rejects.toMatchObject({
    code: 'ARCHIVE_CONFLICT',
  })
  await expect(client.info(id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  expect((await client.list()).archives).toEqual([])

  await f.app.close()
  const restarted = buildServer({
    store: f.store,
    token: TOKEN,
    namespace: f.namespace,
  })
  f.defer(() => restarted.close())
  await restarted.listen({
    host: '127.0.0.1',
    port: Number(new URL(f.endpoint).port),
  })
  expect(
    (await restarted.inject({ method: 'GET', url: '/v2/archives/' + id }))
      .statusCode,
  ).toBe(401)
  expect(await new ArchiveSpool(directory, f.endpoint).upload(client)).toEqual({
    id,
  })
  expect(await spool.upload(client)).toEqual({ id })
  expect((await client.list()).archives[0]?.id).toBe(id)
  await expect(
    f.store.archiveInfo('another-namespace', id),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  const found = await client.index(id, {
    terms: ['econnrefused'],
    order: 'desc',
  })
  expect(found.records.map((record) => record.seq)).toEqual([4, 3, 2, 1, 0])
  const record = found.records[0]!
  const hit = record.anchors.find((anchor) =>
    anchor.terms.includes('econnrefused'),
  )!
  expect(
    (await client.text(id, record.seq, hit.offset, hit.bytes)).text,
  ).toContain('ECONNREFUSED 🌏')
  const digest = createHash('sha256')
  let offset: number | null = 0
  while (offset !== null) {
    const page = await client.read(id, 1, offset)
    digest.update(page.bytes)
    offset = page.next
  }
  expect(digest.digest('hex')).toBe(archiveSha256(body))
  expect(
    (await client.index(id, { textOnly: true })).records.map(
      (record) => record.role,
    ),
  ).toEqual(['user', 'assistant'])
}, 90000)

it('reserves namespace capacity across concurrent uploads and releases expired staging', async () => {
  const f = await fixture()
  const manifest = (source: string) => ({
    header: {
      version: 2 as const,
      title: 'Quota fixture',
      scope: 'full' as const,
      omittedAttachments: 0,
      unrecognizedItems: 0,
      interrupted: false,
      source: {
        adapter: 'codex' as const,
        id: source,
        incarnation: source,
        eventCount: 1,
      },
    },
    bytes: archiveBlockBytes,
    blocks: 1,
    records: 1,
    digest: 'a'.repeat(64),
  })
  const first = manifest(randomUUID()),
    second = manifest(randomUUID())
  const limit = archiveBlockBytes
  const attempts = await Promise.allSettled([
    f.store.beginArchive(f.namespace, 'first', first, limit),
    f.store.beginArchive(f.namespace, 'second', second, limit),
  ])
  const reserved = attempts.find((result) => result.status === 'fulfilled')
  const refused = attempts.find((result) => result.status === 'rejected')
  expect(reserved?.value.committed).toBe(false)
  expect(refused?.reason).toMatchObject({ code: 'ARCHIVE_QUOTA' })
  await f.store.pool.query(
    "UPDATE cm_archives SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1",
    [f.namespace],
  )
  await f.store.pruneArchiveUploads(f.namespace)
  expect(
    await f.store.beginArchive(f.namespace, 'new', second, limit),
  ).toMatchObject({ next: 0, committed: false })
}, 20000)
