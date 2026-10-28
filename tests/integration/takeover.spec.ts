import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { HandoffClient } from '../../packages/client/src/handoff.js'
import { MeshClient } from '../../packages/client/src/index.js'

async function prepared() {
  const f = await fixture(),
    id = randomUUID(),
    projectId = randomUUID()
  const a = new HandoffClient(f.client, randomUUID())
  const b = new HandoffClient(
    new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
    randomUUID(),
  )
  await a.register('source')
  await b.register('target')
  await a.project('project', projectId)
  const mapping = await a.mapping(projectId, '/source')
  await b.mapping(projectId, '/target')
  const handle = await f.client.create(
    { id, version: 4, createdAt: 0, isSeeded: false, cwd: '/source' },
    0,
  )
  await f.client.append(
    handle,
    [{ seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } }],
    randomUUID(),
  )
  await f.client.flush(handle, randomUUID())
  await a.summary(id, {
    incarnation: handle.session.incarnation,
    nextSeq: 1,
    title: 'example',
    projectId,
    lastActivity: 1,
  })
  const manifest = {
    version: 1 as const,
    sandbox: { mode: 'workspace-write' as const, relativeRoot: '' },
    workspace: {
      projectId,
      commit: 'a'.repeat(40),
      relativeCwd: '',
      mappingRevision: mapping.revision,
    },
    model: { provider: 'scripted', model: 'test' },
    harness: '0.2.1-rc.3' as const,
    adapter: 'deepseek' as const,
  }
  return { ...f, id, a, b, handle, projectId, manifest }
}
it('records confirmed takeover durably and atomically links the original writer to one handoff', async () => {
  const f = await prepared(),
    operationId = randomUUID()
  const intent = await f.b.takeover(f.id, f.a.nodeId, operationId)
  expect(await f.b.takeover(f.id, f.a.nodeId, operationId)).toEqual(intent)
  expect((await f.a.takeovers()).map((r) => r.id)).toEqual([intent.id])
  expect((await f.client.stat(f.id))?.nextSeq).toBe(1)
  await expect(f.b.mesh.open(f.id, 'write')).rejects.toMatchObject({
    code: 'ALREADY_OWNED',
  })
  const record = await f.a.request(
    f.id,
    f.b.nodeId,
    f.handle.handleId,
    f.handle.epoch,
    f.manifest,
    intent.handoffOperationId,
    intent.id,
  )
  expect(await f.b.getTakeover(intent.id)).toMatchObject({
    state: 'linked',
    handoffId: record.id,
  })
  expect(await f.a.takeovers()).toEqual([])
  expect(
    await f.a.request(
      f.id,
      f.b.nodeId,
      f.handle.handleId,
      f.handle.epoch,
      f.manifest,
      intent.handoffOperationId,
      intent.id,
    ),
  ).toEqual(record)
  await expect(f.b.mesh.open(f.id, 'write')).rejects.toMatchObject({
    code: 'HANDOFF_IN_PROGRESS',
  })
})
it('rejects competing devices and ownership changes without stealing the live writer', async () => {
  const f = await prepared()
  await expect(f.b.takeover(f.id, randomUUID())).rejects.toMatchObject({
    code: 'TAKEOVER_CHANGED',
  })
  const intent = await f.b.takeover(f.id, f.a.nodeId)
  const c = new HandoffClient(
    new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
    randomUUID(),
  )
  await c.register('third')
  await c.mapping(f.projectId, '/third')
  await expect(c.takeover(f.id, f.a.nodeId)).rejects.toMatchObject({
    code: 'TAKEOVER_IN_PROGRESS',
  })
  await expect(
    f.b.failTakeover(intent, 'TAKEOVER_FAILED', 'wrong source'),
  ).rejects.toMatchObject({ code: 'WRONG_DEVICE' })
  await f.client.append(
    f.handle,
    [{ seq: 1, type: 'turn/end', time: 2, data: { turn: 1 } }],
    randomUUID(),
  )
})
it('refuses offline sources and expires pending requests before source admission', async () => {
  const f = await prepared()
  await f.a.offline()
  await expect(f.b.takeover(f.id, f.a.nodeId)).rejects.toMatchObject({
    code: 'NODE_UNAVAILABLE',
  })
  await f.a.register('source')
  const intent = await f.b.takeover(f.id, f.a.nodeId)
  await f.store.pool.query(
    "UPDATE cm_takeovers SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
    [f.namespace, intent.id],
  )
  expect(await f.b.getTakeover(intent.id)).toMatchObject({
    state: 'failed',
    errorCode: 'TAKEOVER_EXPIRED',
  })
  await expect(
    f.a.request(
      f.id,
      f.b.nodeId,
      f.handle.handleId,
      f.handle.epoch,
      f.manifest,
      intent.handoffOperationId,
      intent.id,
    ),
  ).rejects.toMatchObject({ code: 'TAKEOVER_CHANGED' })
  expect(await f.a.takeovers()).toEqual([])
  await f.client.append(
    f.handle,
    [{ seq: 1, type: 'turn/end', time: 2, data: { turn: 1 } }],
    randomUUID(),
  )
})
it('requires explicit confirmation and a prepared target directory', async () => {
  const f = await prepared()
  await expect(
    f.b.mesh.request(`/v1/sessions/${f.id}/takeovers`, {
      ...f.b.identity,
      operationId: randomUUID(),
      expectedSourceNodeId: f.a.nodeId,
      confirmed: false,
    }),
  ).rejects.toBeDefined()
  const c = new HandoffClient(
    new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
    randomUUID(),
  )
  await c.register('unmapped')
  await expect(c.takeover(f.id, f.a.nodeId)).rejects.toMatchObject({
    code: 'WORKSPACE_MISMATCH',
  })
  await f.store.pool.query(
    'UPDATE cm_nodes SET capabilities=$3 WHERE namespace=$1 AND id=$2',
    [
      f.namespace,
      f.a.nodeId,
      JSON.stringify({
        controlVersion: 1,
        harness: '0.2.1-rc.3',
        adapter: 'deepseek',
      }),
    ],
  )
  await expect(f.b.takeover(f.id, f.a.nodeId)).rejects.toMatchObject({
    code: 'TAKEOVER_UNSUPPORTED',
  })
  expect(await f.a.takeovers()).toEqual([])
})
