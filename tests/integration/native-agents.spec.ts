import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { it, expect } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'
import {
  nativeAdapterId,
  STORAGE_SCHEMA_VERSION,
} from '../../packages/protocol/src/index.js'

const header = (id: string = randomUUID()) => ({
  id,
  version: 4,
  createdAt: 1,
  isSeeded: false,
})
const event = (seq: number) => ({
  seq,
  type: 'native/item',
  time: seq + 1,
  item: {
    role: 'assistant',
    content: [{ type: 'output_text', text: '原始上下文 ✓' }],
    metadata: { arbitrary: [null, true, 17] },
  },
})
async function saved(client: MeshClient, id?: string) {
  const h = await client.create(
    {
      ...header(id),
      ...(client.adapter === 'deepseek'
        ? {}
        : { origin: { threadId: 'original-native-id', provider: 'fixture' } }),
    },
    0,
  )
  const operation = randomUUID()
  await client.append(h, [event(0)], operation)
  // A retried request must not duplicate native items.
  await client.append(h, [event(0)], operation)
  await client.flush(h, randomUUID())
  await client.close(h, randomUUID())
  return h.session.id
}
it('validates adapter IDs without fixing the protocol to a list of vendors', () => {
  for (const name of ['deepseek', 'codex', 'claude-code', 'org.agent_v2'])
    expect(nativeAdapterId.parse(name)).toBe(name)
  for (const name of [
    '',
    'Codex',
    '../codex',
    'a/b',
    'codex--v2',
    'a'.repeat(65),
  ])
    expect(nativeAdapterId.safeParse(name).success).toBe(false)
})
it('stores opaque native logs and keeps legacy DSH catalog and pagination isolated', async () => {
  const f = await fixture()
  const codex = new MeshClient({
    endpoint: f.endpoint,
    token: TOKEN,
    adapter: 'codex',
  })
  const codexId = await saved(codex, 'a-codex')
  const dsId = await saved(f.client, 'b-deepseek')
  await saved(codex, 'c-codex')
  expect((await f.client.list()).map((s) => s.id)).toEqual([dsId])
  expect((await codex.list()).map((s) => s.id)).toEqual([codexId, 'c-codex'])
  // Query without adapter is the exact legacy HTTP read contract.
  const page = (await f.client.request(
    `/v1/sessions?instanceId=${f.client.instanceId}&limit=1`,
  )) as any
  expect(page.sessions.map((s: any) => s.id)).toEqual([dsId])
  expect(page.cursor).toBeNull()
  const nativePage = (await codex.request(
    `/v1/sessions?instanceId=${codex.instanceId}&adapter=codex&limit=1`,
  )) as any
  expect(nativePage.cursor).toBe(codexId)
  expect(await f.client.stat(codexId)).toBeNull()
  expect(await codex.stat(dsId)).toBeNull()
  const handle = await codex.open(codexId, 'read')
  expect((await codex.read(handle, 0, 100)).events).toEqual([event(0)])
  expect(handle.session.header.origin).toEqual({
    threadId: 'original-native-id',
    provider: 'fixture',
  })
  await codex.close(handle, randomUUID())
  const ctx = await f.mount()
  expect((await ctx.sessionPersistence.list()).map((s) => s.header.id)).toEqual(
    [dsId],
  )
  expect(await f.client.capabilities()).toMatchObject({
    features: expect.arrayContaining(['native-agent-storage-v1']),
  })
  expect(await f.client.request('/health/ready')).toMatchObject({
    schemaVersion: STORAGE_SCHEMA_VERSION,
  })
})
it('rejects mismatched open and recovery before acquiring or closing a writer', async () => {
  const f = await fixture()
  const codex = new MeshClient({
    endpoint: f.endpoint,
    token: TOKEN,
    adapter: 'codex',
    retries: 0,
  })
  const id = await saved(codex)
  const writer = await codex.open(id, 'write')
  for (const access of ['read', 'write'] as const)
    await expect(f.client.open(id, access)).rejects.toMatchObject({
      code: 'ADAPTER_MISMATCH',
    })
  const count = await f.store.pool.query(
    'SELECT count(*)::int AS n FROM cm_handles WHERE namespace=$1',
    [f.namespace],
  )
  expect(count.rows[0].n).toBe(2) // create + matching writer, no mismatched handles
  await expect(
    f.client.request(`/v1/sessions/${id}/recover`, {
      operationId: randomUUID(),
      confirmStopped: true,
    }),
  ).rejects.toMatchObject({ code: 'ADAPTER_MISMATCH' })
  await codex.append(writer, [event(1)], randomUUID())
  await expect(codex.open(id, 'write')).rejects.toMatchObject({
    code: 'ALREADY_OWNED',
  })
  await codex.close(writer, randomUUID(), true)
  await expect(codex.open(id, 'write')).rejects.toMatchObject({
    code: 'RECOVERY_REQUIRED',
  })
  await codex.request(`/v1/sessions/${id}/recover`, {
    operationId: randomUUID(),
    confirmStopped: true,
    adapter: 'codex',
  })
  const recovered = await codex.open(id, 'write')
  await expect(
    codex.append(writer, [event(2)], randomUUID()),
  ).rejects.toBeDefined()
  expect((await codex.read(recovered, 0, 100)).events).toEqual([
    event(0),
    event(1),
  ])
  await codex.close(recovered, randomUUID())
})
it('keeps global session identities and old omitted-adapter operation digests stable', async () => {
  const f = await fixture()
  const id = await saved(f.client)
  const codex = new MeshClient({
    endpoint: f.endpoint,
    token: TOKEN,
    adapter: 'codex',
  })
  await expect(codex.create(header(id), 0)).rejects.toMatchObject({
    code: 'ALREADY_EXISTS',
  })
  const operationId = randomUUID()
  const body = {
    operationId,
    instanceId: f.client.instanceId,
    access: 'read' as const,
  }
  const a = await f.client.request(`/v1/sessions/${id}/handles`, body)
  const b = await f.client.request(`/v1/sessions/${id}/handles`, body)
  expect(a).toEqual(b)
  await expect(
    f.client.request(`/v1/sessions/${id}/handles`, {
      ...body,
      adapter: 'codex',
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await f.client.close(a as any, randomUUID())
})

it('exposes native export through the CLI without changing the default DSH catalog', async () => {
  const f = await fixture()
  const codex = new MeshClient({
    endpoint: f.endpoint,
    token: TOKEN,
    adapter: 'codex',
  })
  const id = await saved(codex)
  const env = {
    ...process.env,
    CONTEXTMESH_ENDPOINT: f.endpoint,
    CONTEXTMESH_TOKEN: TOKEN,
  }
  const run = promisify(execFile)
  const exported = await run(
    process.execPath,
    [
      '--import',
      'tsx',
      'apps/cli/src/main.ts',
      'export',
      id,
      '--adapter',
      'codex',
    ],
    { env },
  )
  expect(JSON.parse(exported.stdout)).toMatchObject({
    adapter: 'codex',
    header: { id },
    events: [event(0)],
  })
  const listed = await run(
    process.execPath,
    ['--import', 'tsx', 'apps/cli/src/main.ts', 'list'],
    { env },
  )
  expect(JSON.parse(listed.stdout)).toEqual([])
})
it('refuses DSH handoff reservation for a foreign native writer', async () => {
  const f = await fixture()
  const codex = new MeshClient({
    endpoint: f.endpoint,
    token: TOKEN,
    adapter: 'codex',
  })
  const handle = await codex.create(header(), 0)
  await codex.flush(handle, randomUUID())
  await expect(
    f.store.requestHandoff(f.namespace, handle.session.id, {
      operationId: randomUUID(),
      sourceNodeId: randomUUID(),
      sourceInstanceId: codex.instanceId,
      sourceHandleId: handle.handleId,
      sourceEpoch: handle.epoch,
      targetNodeId: randomUUID(),
      manifest: {
        version: 1,
        sandbox: { mode: 'workspace-write', relativeRoot: '' },
        workspace: {
          projectId: randomUUID(),
          commit: 'a'.repeat(40),
          relativeCwd: '',
          mappingRevision: 1,
        },
        model: { provider: 'fixture', model: 'test' },
        harness: '0.2.1-rc.3',
        adapter: 'deepseek',
      },
    }),
  ).rejects.toMatchObject({ code: 'ADAPTER_MISMATCH' })
  expect(
    (
      await f.store.pool.query(
        'SELECT active_handoff FROM cm_sessions WHERE namespace=$1 AND id=$2',
        [f.namespace, handle.session.id],
      )
    ).rows[0].active_handoff,
  ).toBeNull()
  await codex.append(handle, [event(0)], randomUUID())
  await codex.close(handle, randomUUID())
})
