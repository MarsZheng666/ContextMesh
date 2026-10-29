import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { HandoffClient } from '../../packages/client/src/handoff.js'
import { ModelRelayClient } from '../../packages/client/src/model-relay.js'

async function prepared() {
  const f = await fixture(),
    id = randomUUID(),
    node = new HandoffClient(f.client, randomUUID())
  await node.register('fixture')
  const handle = await f.client.create(
    { id, version: 4, isSeeded: false, createdAt: 0, cwd: '/fixture' },
    0,
  )
  await f.client.flush(handle, randomUUID())
  const relay = new ModelRelayClient(f.client, node.nodeId)
  const request = {
    operationId: randomUUID(),
    handleId: handle.handleId,
    epoch: handle.epoch,
    incarnation: handle.session.incarnation,
    historyCut: 0,
    source: { provider: 'a', model: 'one' },
    target: { provider: 'b', model: 'two' },
  }
  return { ...f, id, node, handle, relay, request }
}
it('reserves one writer-bound cut, rejects conflicting retries and only completes a durable model event', async () => {
  const f = await prepared()
  const record = await f.relay.prepare(f.id, f.request)
  expect(await f.relay.prepare(f.id, f.request)).toEqual(record)
  await expect(
    f.relay.prepare(f.id, {
      ...f.request,
      target: { provider: 'c', model: 'three' },
    }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  await expect(
    f.relay.prepare(f.id, { ...f.request, operationId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'MODEL_RELAY_BUSY' })
  await expect(f.relay.finish(record.id)).rejects.toMatchObject({
    code: 'MODEL_RELAY_UNCONFIRMED',
  })
  await f.client.append(
    f.handle,
    [{ seq: 0, type: 'model/selection', time: 1, data: f.request.target }],
    randomUUID(),
  )
  await f.client.flush(f.handle, randomUUID())
  expect(await f.relay.finish(record.id)).toMatchObject({
    state: 'completed',
    selectionSeq: 0,
  })
  expect(await f.relay.finish(record.id)).toMatchObject({
    state: 'completed',
    selectionSeq: 0,
  })
  expect(
    (
      await f.store.pool.query(
        'SELECT active_model_relay FROM cm_sessions WHERE namespace=$1 AND id=$2',
        [f.namespace, f.id],
      )
    ).rows[0].active_model_relay,
  ).toBeNull()
  await expect(
    f.store.getModelRelay('another-namespace', record.id),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' })
})

for (const durable of [false, true])
  it(`reconciles a stopped original process with ${durable ? 'a durable' : 'no'} model event without replay`, async () => {
    const f = await prepared()
    const record = await f.relay.prepare(f.id, f.request)
    if (durable)
      await f.client.append(
        f.handle,
        [{ seq: 0, type: 'model/selection', time: 1, data: f.request.target }],
        randomUUID(),
      )
    await f.client.close(f.handle, randomUUID())
    await f.node.offline()
    const mesh = new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
      node = new HandoffClient(mesh, f.node.nodeId)
    await node.register('restarted')
    const relay = new ModelRelayClient(mesh, node.nodeId)
    expect(await relay.finish(record.id)).toMatchObject({
      state: durable ? 'completed' : 'failed',
    })
    const handle = await mesh.open(f.id, 'write')
    expect((await mesh.read(handle, 0, 10)).events).toHaveLength(
      durable ? 1 : 0,
    )
    await mesh.close(handle, randomUUID())
  })

it('does not infer model rollback from an expired lease and fences other writers', async () => {
  const f = await prepared(),
    record = await f.relay.prepare(f.id, f.request)
  await f.store.pool.query(
    "UPDATE cm_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
    [f.namespace, f.id],
  )
  await expect(f.relay.finish(record.id)).rejects.toMatchObject({
    code: 'MODEL_RELAY_UNCONFIRMED',
  })
  const other = new MeshClient({ endpoint: f.endpoint, token: TOKEN })
  await expect(other.open(f.id, 'write')).rejects.toMatchObject({
    code: 'MODEL_RELAY_BUSY',
  })
  await f.store.pool.query(
    "UPDATE cm_sessions SET lease_until=clock_timestamp()+interval '60 seconds' WHERE namespace=$1 AND id=$2",
    [f.namespace, f.id],
  )
  expect(await f.relay.finish(record.id, true)).toMatchObject({
    state: 'failed',
  })
})

it('blocks handoff while a model selection is unresolved and binds takeover to its requested target model', async () => {
  const f = await prepared(),
    projectId = randomUUID()
  await f.node.project('fixture', projectId)
  const mapping = await f.node.mapping(projectId, '/fixture')
  const mesh = new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
    other = new HandoffClient(mesh, randomUUID())
  await other.register('target')
  await other.mapping(projectId, '/target')
  await f.node.summary(f.id, {
    incarnation: f.handle.session.incarnation,
    nextSeq: 0,
    title: 'fixture',
    projectId,
    lastActivity: 1,
  })
  const record = await f.relay.prepare(f.id, f.request)
  const manifest = {
    version: 1 as const,
    workspace: {
      kind: 'directory' as const,
      projectId,
      commit: null,
      relativeCwd: '',
      mappingRevision: mapping.revision,
    },
    sandbox: { mode: 'read-only' as const, relativeRoot: '' },
    model: f.request.source,
    targetModel: f.request.target,
    harness: '0.2.1-rc.3' as const,
    adapter: 'deepseek' as const,
  }
  await expect(
    f.node.request(
      f.id,
      other.nodeId,
      f.handle.handleId,
      f.handle.epoch,
      manifest,
    ),
  ).rejects.toMatchObject({ code: 'MODEL_RELAY_BUSY' })
  await expect(other.takeover(f.id, f.node.nodeId)).rejects.toMatchObject({
    code: 'MODEL_RELAY_BUSY',
  })
  await f.relay.finish(record.id, true)
  const intent = await other.takeover(
    f.id,
    f.node.nodeId,
    randomUUID(),
    f.request.target,
  )
  await expect(
    f.node.request(
      f.id,
      other.nodeId,
      f.handle.handleId,
      f.handle.epoch,
      { ...manifest, targetModel: { provider: 'c', model: 'other' } },
      intent.handoffOperationId,
      intent.id,
    ),
  ).rejects.toMatchObject({ code: 'TAKEOVER_CHANGED' })
  const handoff = await f.node.request(
    f.id,
    other.nodeId,
    f.handle.handleId,
    f.handle.epoch,
    manifest,
    intent.handoffOperationId,
    intent.id,
  )
  expect(handoff.manifest.targetModel).toEqual(f.request.target)
})
