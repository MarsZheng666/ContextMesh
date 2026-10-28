import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { HandoffClient } from '../../packages/client/src/handoff.js'

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
  await a.project('test-project', projectId)
  const am = await a.mapping(projectId, '/source'),
    bm = await b.mapping(projectId, '/target')
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
  const workspace = {
    projectId,
    commit: 'a'.repeat(40),
    relativeCwd: '',
    mappingRevision: am.revision,
  }
  const proof = { ...workspace, mappingRevision: bm.revision }
  const requested = await a.request(
    id,
    b.nodeId,
    handle.handleId,
    handle.epoch,
    {
      version: 1,
      sandbox: { mode: 'workspace-write', relativeRoot: '' },
      workspace,
      model: { provider: 'scripted', model: 'test' },
      harness: '0.2.1-rc.3',
      adapter: 'deepseek',
    },
  )
  return { ...f, id, a, b, handle, requested, proof }
}

it('reserves the log, requires successful close, and permits only one atomic accept', async () => {
  const f = await prepared()
  await expect(f.b.mesh.open(f.id, 'write')).rejects.toMatchObject({
    code: 'HANDOFF_IN_PROGRESS',
  })
  const preparing = await f.b.preflight(f.requested, f.proof)
  await expect(f.a.finalize(preparing)).rejects.toMatchObject({
    code: 'CLOSE_UNCONFIRMED',
  })
  await f.client.close(f.handle, randomUUID())
  const ready = await f.a.finalize(preparing)
  expect(ready.finalNextSeq).toBe(1)
  await expect(
    f.client.request(`/v1/sessions/${f.id}/recover`, {
      operationId: randomUUID(),
      confirmStopped: true,
    }),
  ).rejects.toMatchObject({ code: 'HANDOFF_IN_PROGRESS' })
  const op = randomUUID()
  const accepted = await f.b.accept(ready, f.proof, op)
  expect(await f.b.accept(ready, f.proof, op)).toEqual(accepted)
  await expect(f.b.accept(ready, f.proof)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  })
  expect(accepted.handle.epoch).toBeGreaterThan(f.handle.epoch)
  await expect(
    f.client.append(
      f.handle,
      [{ seq: 1, type: 'turn/end', time: 2 }],
      randomUUID(),
    ),
  ).rejects.toMatchObject({ code: 'HANDLE_CLOSED' })
  await f.b.mesh.append(
    accepted.handle,
    [
      {
        seq: 1,
        type: 'working-directory/change',
        time: 2,
        data: { cwd: '/target' },
      },
    ],
    randomUUID(),
  )
  await f.b.mesh.flush(accepted.handle, randomUUID())
  const completed = await f.b.complete(accepted.handoff, 2)
  expect(completed.state).toBe('completed')
  await f.b.mesh.close(accepted.handle, randomUUID())
})

it('serializes simultaneous target claims', async () => {
  const f = await prepared(),
    preparing = await f.b.preflight(f.requested, f.proof)
  await f.client.close(f.handle, randomUUID())
  const ready = await f.a.finalize(preparing)
  const attempts = await Promise.allSettled([
    f.b.accept(ready, f.proof),
    f.b.accept(ready, f.proof),
  ])
  expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1)
  for (const a of attempts)
    if (a.status === 'fulfilled')
      await f.b.mesh.close(a.value.handle, randomUUID())
})

it('rejects mismatched workspace proof before stopping the source', async () => {
  const f = await prepared()
  await expect(
    f.b.preflight(f.requested, { ...f.proof, commit: 'b'.repeat(40) }),
  ).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
  expect((await f.a.cancel(f.requested)).state).toBe('cancelled')
  await f.client.append(
    f.handle,
    [{ seq: 1, type: 'turn/end', time: 2 }],
    randomUUID(),
  )
  await f.client.close(f.handle, randomUUID())
})

it('rejects changed mapping and wrong target, and preserves ready for explicit cancellation', async () => {
  const f = await prepared(),
    preparing = await f.b.preflight(f.requested, f.proof)
  await f.client.close(f.handle, randomUUID())
  const ready = await f.a.finalize(preparing)
  await expect(f.a.accept(ready, f.proof)).rejects.toMatchObject({
    code: 'WRONG_DEVICE',
  })
  await f.b.mapping(f.proof.projectId, '/another-target')
  await expect(f.b.accept(ready, f.proof)).rejects.toMatchObject({
    code: 'WORKSPACE_MISMATCH',
  })
  expect((await f.a.cancel(ready)).state).toBe('cancelled')
})

it('keeps reservation when target close fails and requires explicit confirmed recovery', async () => {
  const f = await prepared(),
    preparing = await f.b.preflight(f.requested, f.proof)
  await f.client.close(f.handle, randomUUID())
  const ready = await f.a.finalize(preparing),
    accepted = await f.b.accept(ready, f.proof)
  await f.b.mesh.close(accepted.handle, randomUUID(), true)
  const failed = await f.b.fail(
    accepted.handoff,
    'resume',
    'injected failure',
    true,
  )
  expect(failed.state).toBe('recovery_required')
  await expect(f.client.open(f.id, 'write')).rejects.toMatchObject({
    code: 'HANDOFF_IN_PROGRESS',
  })
  const recovered = await f.client.request(
    `/v1/handoffs/${failed.id}/recover`,
    {
      operationId: randomUUID(),
      revision: failed.revision,
      confirmStopped: true,
    },
  )
  expect(recovered).toMatchObject({ state: 'failed' })
  const next = await f.client.open(f.id, 'write')
  await f.client.close(next, randomUUID())
})

it('rejects concurrent device reuse and stale summary cuts', async () => {
  const f = await prepared()
  const duplicate = new HandoffClient(f.b.mesh, f.a.nodeId)
  await expect(duplicate.register('duplicate')).rejects.toMatchObject({
    code: 'NODE_CONFLICT',
  })
  await f.a.summary(f.id, {
    incarnation: f.requested.incarnation,
    nextSeq: 1,
    title: 'Shared title',
    projectId: f.proof.projectId,
    lastActivity: 1,
  })
  await f.a.summary(f.id, {
    incarnation: f.requested.incarnation,
    nextSeq: 0,
    title: 'Older title',
    projectId: f.proof.projectId,
    lastActivity: 0,
  })
  expect((await f.a.sessions())[0]?.title).toBe('Shared title')
  await expect(
    f.a.summary(f.id, {
      incarnation: randomUUID(),
      nextSeq: 1,
      title: 'Wrong incarnation',
      projectId: f.proof.projectId,
      lastActivity: 1,
    }),
  ).rejects.toMatchObject({ code: 'STALE_SUMMARY' })
  await f.a.cancel(f.requested)
  await f.client.close(f.handle, randomUUID())
})

it('does not finalize a failed source close', async () => {
  const f = await prepared(),
    preparing = await f.b.preflight(f.requested, f.proof)
  await f.client.close(f.handle, randomUUID(), true)
  await expect(f.a.finalize(preparing)).rejects.toMatchObject({
    code: 'CLOSE_UNCONFIRMED',
  })
  expect(
    (await f.a.fail(preparing, 'source-close', 'failed', false)).state,
  ).toBe('recovery_required')
})
