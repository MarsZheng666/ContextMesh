import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { HandoffClient } from '../../packages/client/src/handoff.js'
import { workspaceProof } from '../../packages/protocol/src/handoff.js'
async function prepared() {
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
  await a.project('Plain', projectId)
  const source = await a.mapping(projectId, '/plain-a'),
    target = await b.mapping(projectId, '/plain-b')
  const handle = await f.client.create(
    { id, version: 4, isSeeded: false, createdAt: 0, cwd: '/plain-a' },
    0,
  )
  await f.client.append(
    handle,
    [{ seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } }],
    randomUUID(),
  )
  await f.client.flush(handle, randomUUID())
  const manifest = {
    version: 1 as const,
    workspace: {
      kind: 'directory' as const,
      projectId,
      commit: null,
      relativeCwd: '',
      mappingRevision: source.revision,
    },
    sandbox: { mode: 'read-only' as const, relativeRoot: '' },
    model: { provider: 'scripted', model: 'test' },
    harness: '0.2.1-rc.3' as const,
    adapter: 'deepseek' as const,
  }
  return {
    ...f,
    a,
    b,
    id,
    projectId,
    handle,
    manifest,
    proof: { ...manifest.workspace, mappingRevision: target.revision },
  }
}
it('keeps directory and Git proofs distinct and rejects implicit null-commit downgrades', async () => {
  const f = await prepared()
  expect(
    workspaceProof.safeParse({ ...f.proof, kind: undefined }).success,
  ).toBe(false)
  expect(
    workspaceProof.safeParse({ ...f.proof, commit: 'a'.repeat(40) }).success,
  ).toBe(false)
  const record = await f.a.request(
    f.id,
    f.b.nodeId,
    f.handle.handleId,
    f.handle.epoch,
    f.manifest,
  )
  await expect(
    f.b.preflight(record, { ...f.proof, kind: 'git', commit: 'a'.repeat(40) }),
  ).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
  expect(await f.b.preflight(record, f.proof)).toMatchObject({
    state: 'preparing',
  })
})
it('requires directory support on both devices before reserving a handoff', async () => {
  const f = await prepared()
  await f.store.registerNode(f.namespace, {
    ...f.b.identity,
    operationId: randomUUID(),
    name: 'old target',
    capabilities: {
      controlVersion: 1,
      harness: '0.2.1-rc.3',
      adapter: 'deepseek',
    },
  })
  await expect(
    f.a.request(
      f.id,
      f.b.nodeId,
      f.handle.handleId,
      f.handle.epoch,
      f.manifest,
    ),
  ).rejects.toMatchObject({ code: 'DIRECTORY_HANDOFF_UNSUPPORTED' })
  expect((await f.a.sessions()).find((s) => s.id === f.id)).toMatchObject({
    handoffId: null,
    activeNodeId: f.a.nodeId,
  })
})

it('does not let a target turn a Git handoff into an ordinary directory handoff', async () => {
  const f = await prepared()
  const manifest = {
    ...f.manifest,
    workspace: {
      ...f.manifest.workspace,
      kind: 'git' as const,
      commit: 'a'.repeat(40),
    },
  }
  const record = await f.a.request(
    f.id,
    f.b.nodeId,
    f.handle.handleId,
    f.handle.epoch,
    manifest,
  )
  await expect(f.b.preflight(record, f.proof)).rejects.toMatchObject({
    code: 'WORKSPACE_MISMATCH',
  })
  expect((await f.a.get(record.id)).state).toBe('requested')
})
