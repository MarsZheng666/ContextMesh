import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture, TOKEN } from '../fixture.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { HandoffClient } from '../../packages/client/src/handoff.js'
import { TransferClient } from '../../packages/client/src/transfers.js'
import { treeHash, sha256 } from '../../packages/protocol/src/transfer-hash.js'
import type { TransferBundle } from '../../packages/protocol/src/transfers.js'
async function prepared() {
  const f = await fixture(),
    a = new HandoffClient(f.client, randomUUID()),
    other = new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
    b = new HandoffClient(other, randomUUID()),
    projectId = randomUUID(),
    sessionId = randomUUID()
  await a.register('A')
  await b.register('B')
  await a.project('fixture', projectId)
  await a.mapping(projectId, '/source')
  await b.mapping(projectId, '/target')
  const writer = await f.client.create(
    {
      id: sessionId,
      version: 4,
      isSeeded: false,
      createdAt: 0,
      cwd: '/source',
    },
    0,
  )
  await f.client.flush(writer, randomUUID())
  await a.summary(sessionId, {
    incarnation: writer.session.incarnation,
    projectId,
    nextSeq: 0,
    title: 'fixture',
    lastActivity: 0,
  })
  const bundle: TransferBundle = {
    version: 1,
    sessionId,
    incarnation: writer.session.incarnation,
    projectId,
    sourceNodeId: a.nodeId,
    targetNodeId: b.nodeId,
    baseCommit: null,
    files: [],
    treeHash: treeHash([]),
    attachments: [
      {
        ref: {
          name: 'note.txt',
          bytes: 4,
          attachmentId: 'sha256:' + sha256('note'),
        },
        data: Buffer.from('note').toString('base64'),
      },
    ],
  }
  return {
    ...f,
    a,
    b,
    bundle,
    writer,
    source: new TransferClient(f.client, a.nodeId),
    target: new TransferClient(other, b.nodeId),
  }
}
it('binds immutable transfer records to session, namespace and devices and records only target receipts', async () => {
  const f = await prepared(),
    id = randomUUID()
  const summary = await f.source.upload(id, f.bundle)
  expect(await f.source.upload(id, f.bundle)).toEqual(summary)
  await expect(
    f.source.upload(id, { ...f.bundle, attachments: [] }),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  const record = await f.target.get(id)
  expect(record.ready).toBe(false)
  expect(record.bundle).toEqual(f.bundle)
  await expect(f.source.receipt(record)).rejects.toMatchObject({
    code: 'TRANSFER_CHANGED',
  })
  await f.target.receipt(record)
  expect((await f.source.get(id)).ready).toBe(true)
  await f.target.receipt(record, false)
  expect((await f.target.get(id)).ready).toBe(false)
  expect(await f.source.list()).toHaveLength(1)
  await expect(
    f.store.readTransfer('other-namespace', id, {
      nodeId: f.b.nodeId,
      instanceId: f.b.mesh.instanceId,
    }),
  ).rejects.toThrow()
  const third = new HandoffClient(
    new MeshClient({ endpoint: f.endpoint, token: TOKEN }),
    randomUUID(),
  )
  await third.register('third')
  await expect(
    new TransferClient(third.mesh, third.nodeId).get(id),
  ).rejects.toMatchObject({ code: 'WRONG_DEVICE' })
})
it('rejects corrupted uploads, stale writers, expired records and fake readiness during handoff', async () => {
  const f = await prepared(),
    id = randomUUID()
  await f.store.pool.query(
    "UPDATE cm_sessions SET lease_until=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
    [f.namespace, f.bundle.sessionId],
  )
  await expect(f.source.upload(randomUUID(), f.bundle)).rejects.toMatchObject({
    code: 'NOT_LOCAL_WRITER',
  })
  await f.store.pool.query(
    "UPDATE cm_sessions SET lease_until=clock_timestamp()+interval '60 seconds' WHERE namespace=$1 AND id=$2",
    [f.namespace, f.bundle.sessionId],
  )
  const corrupt = structuredClone(f.bundle)
  corrupt.attachments[0]!.data = Buffer.from('oops').toString('base64')
  await expect(f.source.upload(id, corrupt)).rejects.toMatchObject({
    code: 'TRANSFER_CORRUPT',
  })
  await f.source.upload(id, f.bundle)
  const manifest = {
    version: 1 as const,
    transferId: id,
    workspace: {
      kind: 'directory' as const,
      projectId: f.bundle.projectId,
      commit: null,
      relativeCwd: '',
      mappingRevision: 1,
    },
    sandbox: { mode: 'read-only' as const, relativeRoot: '' },
    model: { provider: 'fixture', model: 'fixture' },
    harness: '0.2.1-rc.3' as const,
    adapter: 'deepseek' as const,
  }
  await expect(
    f.a.request(
      f.bundle.sessionId,
      f.b.nodeId,
      f.writer.handleId,
      f.writer.epoch,
      manifest,
    ),
  ).rejects.toMatchObject({ code: 'TRANSFER_NOT_READY' })
  const record = await f.target.get(id)
  await f.target.receipt(record)
  await f.a.request(
    f.bundle.sessionId,
    f.b.nodeId,
    f.writer.handleId,
    f.writer.epoch,
    manifest,
  )
  await expect(f.target.receipt(record, false)).rejects.toMatchObject({
    code: 'HANDOFF_IN_PROGRESS',
  })
  await f.store.pool.query(
    "UPDATE cm_workspace_transfers SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
    [f.namespace, id],
  )
  await expect(f.target.get(id)).rejects.toMatchObject({
    code: 'TRANSFER_EXPIRED',
  })
  await f.client.close(f.writer, randomUUID())
  await expect(f.source.upload(randomUUID(), f.bundle)).rejects.toMatchObject({
    code: 'NOT_LOCAL_WRITER',
  })
})
