import { randomUUID } from 'node:crypto'
import { writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { it, expect } from 'vitest'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
const reference = z.object({
  attachmentId: z.string(),
  name: z.string(),
  bytes: z.number(),
})
it('hands native DSH history to a second installed plugin with confirmed dirty Git files and original immutable file attachments', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, true),
      b = await f.launch('B', f.target, true),
      projectId = randomUUID(),
      sessionId = randomUUID()
    const control = (host: typeof a, command: unknown) =>
      host.rpc('m1', { command })
    await control(a, { action: 'project', projectId, name: 'fixture' })
    await control(a, { action: 'mapping', projectId, root: f.source })
    await control(b, { action: 'mapping', projectId, root: f.target })
    await a.rpc('create', { sessionId })
    const fileData = Buffer.from('native attachment continuity\n').toString(
      'base64',
    )
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember FILE-CONTINUITY-7331.',
      fileName: 'evidence.txt',
      fileData,
    })
    const refs = z
      .array(z.object({ ref: reference, data: z.string() }))
      .parse(await a.rpc('file-read', { sessionId }))
    expect(refs).toHaveLength(1)
    await writeFile(
      join(f.source, 'handoff-sentinel.txt'),
      'modified fixture-sentinel\n',
    )
    await mkdir(join(f.source, 'changes'))
    await writeFile(
      join(f.source, 'changes/new.bin'),
      Buffer.from([0, 255, 19]),
    )
    await rm(join(f.source, 'nested/handoff-sentinel.txt'))
    const before = await f.client.open(sessionId, 'read'),
      original = (await f.client.read(before, 0, Number.MAX_SAFE_INTEGER))
        .events
    await f.client.close(before, randomUUID())
    const plan = z
      .object({
        id: z.string(),
        files: z.array(z.unknown()),
        attachments: z.array(z.unknown()),
      })
      .parse(
        await control(a, {
          action: 'workspace-plan',
          sessionId,
          targetNodeId: b.nodeId,
        }),
      )
    expect(plan.files).toHaveLength(3)
    expect(plan.attachments).toHaveLength(1)
    await control(a, {
      action: 'workspace-export',
      planId: plan.id,
      confirmed: true,
    })
    await expect(
      control(a, { action: 'handoff', sessionId, targetNodeId: b.nodeId }),
    ).rejects.toThrow('target')
    expect(
      z.object({ live: z.boolean() }).parse(await a.rpc('state', { sessionId }))
        .live,
    ).toBe(true)
    const preview = z
      .object({
        previewId: z.string(),
        recoveryRequired: z.boolean(),
        ready: z.boolean(),
      })
      .parse(
        await control(b, { action: 'workspace-preview', transferId: plan.id }),
      )
    expect(preview).toMatchObject({ recoveryRequired: false, ready: false })
    await control(b, {
      action: 'workspace-apply',
      previewId: preview.previewId,
      transferId: plan.id,
      confirmed: true,
    })
    await control(b, {
      action: 'workspace-apply',
      previewId: preview.previewId,
      transferId: plan.id,
      confirmed: true,
    })
    expect(await readFile(join(f.target, 'changes/new.bin'))).toEqual(
      Buffer.from([0, 255, 19]),
    )
    const requested = z.object({ id: z.string() }).parse(
      await control(a, {
        action: 'handoff',
        sessionId,
        targetNodeId: b.nodeId,
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string(), error: z.string().nullable() })
            .parse(await f.client.request('/v1/handoffs/' + requested.id)),
        { timeout: 15000 },
      )
      .toMatchObject({ state: 'completed', error: null })
    expect(await b.rpc('file-read', { sessionId })).toEqual(refs)
    const handle = await f.client.open(sessionId, 'read')
    expect((await f.client.read(handle, 0, original.length)).events).toEqual(
      original,
    )
    await f.client.close(handle, randomUUID())
    const continued = await b.rpc('prompt', {
      sessionId,
      text: 'READ_WORKSPACE and retain FILE-CONTINUITY-7331.',
    })
    expect(JSON.stringify(continued)).toContain('modified fixture-sentinel')
    expect(JSON.stringify(continued)).toContain('FILE-CONTINUITY-7331')
    await b.stop()
    const restarted = await f.launch('B', f.target, true)
    await restarted.rpc('native-resume', { sessionId })
    expect(await restarted.rpc('file-read', { sessionId })).toEqual(refs)
  } finally {
    await f.close()
  }
}, 60000)
it('rejects changed source previews and dirty target imports while keeping source input and target changes', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      b = await f.launch('B', f.target),
      projectId = randomUUID(),
      sessionId = randomUUID()
    const control = (host: typeof a, command: unknown) =>
      host.rpc('m1', { command })
    await control(a, { action: 'project', projectId, name: 'fixture' })
    await control(a, { action: 'mapping', projectId, root: f.source })
    await control(b, { action: 'mapping', projectId, root: f.target })
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember source remains active.',
    })
    await writeFile(
      join(f.source, 'handoff-sentinel.txt'),
      'first source revision',
    )
    const first = z.object({ id: z.string() }).parse(
      await control(a, {
        action: 'workspace-plan',
        sessionId,
        targetNodeId: b.nodeId,
      }),
    )
    await writeFile(
      join(f.source, 'handoff-sentinel.txt'),
      'second source revision',
    )
    await expect(
      control(a, {
        action: 'workspace-export',
        planId: first.id,
        confirmed: true,
      }),
    ).rejects.toThrow('changed')
    const second = z.object({ id: z.string() }).parse(
      await control(a, {
        action: 'workspace-plan',
        sessionId,
        targetNodeId: b.nodeId,
      }),
    )
    await control(a, {
      action: 'workspace-export',
      planId: second.id,
      confirmed: true,
    })
    const preview = z.object({ previewId: z.string() }).parse(
      await control(b, {
        action: 'workspace-preview',
        transferId: second.id,
      }),
    )
    await writeFile(join(f.target, 'handoff-sentinel.txt'), 'keep target edit')
    await expect(
      control(b, {
        action: 'workspace-apply',
        previewId: preview.previewId,
        transferId: second.id,
        confirmed: true,
      }),
    ).rejects.toThrow('local changes')
    expect(await readFile(join(f.target, 'handoff-sentinel.txt'), 'utf8')).toBe(
      'keep target edit',
    )
    expect(
      z
        .object({ controlled: z.boolean() })
        .parse(await a.rpc('state', { sessionId })).controlled,
    ).toBe(false)
    await a.rpc('prompt', {
      sessionId,
      text: 'Source continues after rejected import.',
    })
  } finally {
    await f.close()
  }
}, 30000)

it('binds target approval to the inspected directory, rechecks imported content before handoff, and can roll back after server expiry', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      b = await f.launch('B', f.target),
      projectId = randomUUID(),
      sessionId = randomUUID()
    const control = (host: typeof a, command: unknown) =>
      host.rpc('m1', { command })
    await control(a, { action: 'project', projectId, name: 'fixture' })
    await control(a, { action: 'mapping', projectId, root: f.source })
    await control(b, { action: 'mapping', projectId, root: f.target })
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember imported content is checked.',
    })
    await writeFile(join(f.source, 'handoff-sentinel.txt'), 'approved content')
    const plan = z.object({ id: z.string() }).parse(
      await control(a, {
        action: 'workspace-plan',
        sessionId,
        targetNodeId: b.nodeId,
      }),
    )
    await control(a, {
      action: 'workspace-export',
      planId: plan.id,
      confirmed: true,
    })
    const preview = z
      .object({ previewId: z.string() })
      .parse(
        await control(b, { action: 'workspace-preview', transferId: plan.id }),
      )
    await control(b, { action: 'mapping', projectId, root: f.root })
    await expect(
      control(b, {
        action: 'workspace-apply',
        transferId: plan.id,
        previewId: preview.previewId,
        confirmed: true,
      }),
    ).rejects.toThrow('directory changed')
    await control(b, { action: 'mapping', projectId, root: f.target })
    const fresh = z
      .object({ previewId: z.string() })
      .parse(
        await control(b, { action: 'workspace-preview', transferId: plan.id }),
      )
    await control(b, {
      action: 'workspace-apply',
      transferId: plan.id,
      previewId: fresh.previewId,
      confirmed: true,
    })
    await writeFile(join(f.target, 'handoff-sentinel.txt'), 'later target edit')
    const handoff = z.object({ id: z.string() }).parse(
      await control(a, {
        action: 'handoff',
        sessionId,
        targetNodeId: b.nodeId,
      }),
    )
    await expect
      .poll(
        async () =>
          z
            .object({ state: z.string() })
            .parse(await f.client.request('/v1/handoffs/' + handoff.id)).state,
        { timeout: 10000 },
      )
      .toBe('failed')
    await expect
      .poll(
        async () =>
          z
            .object({ controlled: z.boolean() })
            .parse(await a.rpc('state', { sessionId })).controlled,
        { timeout: 10000 },
      )
      .toBe(false)
    expect(await readFile(join(f.target, 'handoff-sentinel.txt'), 'utf8')).toBe(
      'later target edit',
    )
    await f.store.pool.query(
      "UPDATE cm_workspace_transfers SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
      [f.namespace, plan.id],
    )
    await expect(
      control(b, {
        action: 'workspace-rollback',
        transferId: plan.id,
        confirmed: true,
      }),
    ).rejects.toThrow('later edits')
    await writeFile(join(f.target, 'handoff-sentinel.txt'), 'approved content')
    expect(
      await control(b, {
        action: 'workspace-rollback',
        transferId: plan.id,
        confirmed: true,
      }),
    ).toMatchObject({ rolledBack: true })
    expect(await readFile(join(f.target, 'handoff-sentinel.txt'), 'utf8')).toBe(
      'fixture-sentinel\n',
    )
  } finally {
    await f.close()
  }
}, 40000)
