import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { HandoffClient } from '../../packages/client/src/handoff.js'
import { MeshClient } from '../../packages/client/src/index.js'
async function example() {
  const f = await fixture(),
    a = new HandoffClient(f.client, randomUUID()),
    b = new HandoffClient(
      new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
      randomUUID(),
    ),
    id = randomUUID(),
    projectId = randomUUID()
  await a.register('source')
  await b.register('target')
  await a.project('Shared', projectId)
  await b.mapping(projectId, '/target')
  const handle = await f.client.create(
    { id, version: 4, isSeeded: false, createdAt: 0, cwd: '/source' },
    0,
  )
  await f.client.append(
    handle,
    [{ seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } }],
    randomUUID(),
  )
  await f.client.flush(handle, randomUUID())
  return { ...f, a, b, id, projectId, handle }
}
it('associates an unassigned remote session without moving its writer or altering its log', async () => {
  const f = await example(),
    before = await f.client.stat(f.id),
    operationId = randomUUID()
  const body = {
    operationId,
    ...f.b.identity,
    incarnation: f.handle.session.incarnation,
    expectedSourceNodeId: f.a.nodeId,
    projectId: f.projectId,
  }
  const url = `/v1/sessions/${f.id}/project`
  expect(await f.b.mesh.request(url, body)).toEqual({ projectId: f.projectId })
  expect(await f.b.mesh.request(url, body)).toEqual({ projectId: f.projectId })
  expect(await f.client.stat(f.id)).toEqual(before)
  expect((await f.b.sessions()).find((s) => s.id === f.id)).toMatchObject({
    projectId: f.projectId,
    activeNodeId: f.a.nodeId,
  })
  const other = randomUUID()
  await f.a.project('Other', other)
  await f.b.mapping(other, '/other')
  await expect(
    f.b.assignProject(f.id, other, f.handle.session.incarnation, f.a.nodeId),
  ).rejects.toMatchObject({ code: 'PROJECT_CHANGED' })
})
it('rejects stale ownership, missing local directories and offline sources during setup', async () => {
  const f = await example()
  await expect(
    f.b.assignProject(f.id, f.projectId, randomUUID(), f.a.nodeId),
  ).rejects.toMatchObject({ code: 'TAKEOVER_CHANGED' })
  await expect(
    f.b.assignProject(
      f.id,
      f.projectId,
      f.handle.session.incarnation,
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'TAKEOVER_CHANGED' })
  const other = randomUUID()
  await f.a.project('Unmapped', other)
  await expect(
    f.b.assignProject(f.id, other, f.handle.session.incarnation, f.a.nodeId),
  ).rejects.toMatchObject({ code: 'PROJECT_DIRECTORY_REQUIRED' })
  await f.a.offline()
  await expect(
    f.b.assignProject(
      f.id,
      f.projectId,
      f.handle.session.incarnation,
      f.a.nodeId,
    ),
  ).rejects.toMatchObject({ code: 'NODE_UNAVAILABLE' })
})
it('first-time directory setup never replaces a mapping created by another request', async () => {
  const f = await example(),
    projectId = randomUUID()
  await f.a.project('New', projectId)
  const results = await Promise.allSettled([
    f.a.mapping(projectId, '/first', true),
    f.a.mapping(projectId, '/second', true),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  const saved = (await f.a.mappings()).find((m) => m.projectId === projectId)!
  expect(saved.revision).toBe(1)
  expect(await f.a.mapping(projectId, saved.root, true)).toMatchObject({
    root: saved.root,
    revision: 1,
  })
  expect(
    (await f.a.mappings()).find((m) => m.projectId === projectId)?.revision,
  ).toBe(1)
})
