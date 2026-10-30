import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
const target = { provider: 'contextmesh-second', model: 'balanced' }
const reportSchema = z.object({
  historyCut: z.number(),
  capacity: z.object({
    estimatedFits: z.boolean(),
    conservativeFits: z.boolean(),
  }),
})
it('checks capacity without mutation, requires consent for estimates, persists the policy, and continues native history', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source, true),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember CAPACITY-CONTINUITY. ' + 'a'.repeat(16000),
    })
    const before = await f.client.open(sessionId, 'read'),
      original = (await f.client.read(before, 0, Number.MAX_SAFE_INTEGER))
        .events
    await f.client.close(before, randomUUID())
    const report = reportSchema.parse(
      await a.rpc('m1', {
        command: { action: 'model-check', sessionId, ...target },
      }),
    )
    expect(report.capacity.estimatedFits).toBe(true)
    expect(report.capacity.conservativeFits).toBe(false)
    expect((await f.client.stat(sessionId))?.nextSeq).toBe(original.length)
    await expect(
      a.rpc('select-model', { sessionId, selection: target }),
    ).rejects.toThrow()
    await a.rpc('m1', {
      command: {
        action: 'approve-model-capacity',
        sessionId,
        ...target,
        historyCut: report.historyCut,
        confirmed: true,
      },
    })
    await a.rpc('select-model', { sessionId, selection: target })
    const node = JSON.parse(
      await readFile(join(a.stateDir, 'node.json'), 'utf8'),
    )
    expect(node.modelBudgets[sessionId].capacityMode).toBe('estimated')
    await a.rpc('prompt', {
      sessionId,
      text: 'Recall CAPACITY-CONTINUITY without any tools.',
    })
    const after = await f.client.open(sessionId, 'read')
    expect((await f.client.read(after, 0, original.length)).events).toEqual(
      original,
    )
    await f.client.close(after, randomUUID())
    await a.stop()
    const restarted = await f.launch('A', f.source, true)
    await restarted.rpc('native-resume', { sessionId })
    const retained = JSON.parse(
      await readFile(join(restarted.stateDir, 'node.json'), 'utf8'),
    )
    expect(retained.modelBudgets[sessionId].capacityMode).toBe('estimated')
  } finally {
    await f.close()
  }
}, 60000)
it('rejects capacity consent after native history changes, leaving the model and input available', async () => {
  const f = await environment()
  try {
    const a = await f.launch('A', f.source),
      sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', { sessionId, text: 'Remember the first message.' })
    const report = reportSchema.parse(
      await a.rpc('m1', {
        command: { action: 'model-check', sessionId, ...target },
      }),
    )
    await a.rpc('m1', {
      command: {
        action: 'approve-model-capacity',
        sessionId,
        ...target,
        historyCut: report.historyCut,
        confirmed: true,
      },
    })
    await a.rpc('prompt', {
      sessionId,
      text: 'Another message changes the native history cut.',
    })
    const before = await f.client.stat(sessionId)
    await expect(
      a.rpc('select-model', { sessionId, selection: target }),
    ).rejects.toThrow('changed')
    expect((await f.client.stat(sessionId))?.nextSeq).toBe(before?.nextSeq)
    expect(
      z
        .object({ controlled: z.boolean() })
        .parse(await a.rpc('state', { sessionId })).controlled,
    ).toBe(false)
  } finally {
    await f.close()
  }
}, 30000)
