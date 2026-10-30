import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { environment } from '../helpers/handoff-environment.js'
import { DeviceClient } from '../../packages/client/src/devices.js'
import { MeshClient } from '../../packages/client/src/index.js'
it('loads the single installed plugin from a paired host file, preserves node identity across restart, and uses native remote persistence', async () => {
  const f = await environment()
  try {
    const owner = new DeviceClient(f.client),
      pair = z
        .object({ code: z.string() })
        .parse(await owner.create('Paired laptop'))
    const config = await DeviceClient.claim(f.endpoint, pair.code, randomUUID())
    const a = await f.launch(
      'Paired',
      f.source,
      true,
      false,
      undefined,
      false,
      config,
    )
    expect(a.nodeId).toBe(config.nodeId)
    const sessionId = randomUUID()
    await a.rpc('create', { sessionId })
    await a.rpc('prompt', {
      sessionId,
      text: 'Remember PAIRING-CONTINUITY-4817.',
    })
    const before = await f.client.open(sessionId, 'read')
    const log = await f.client.read(before, 0, Number.MAX_SAFE_INTEGER)
    expect(JSON.stringify(log.events)).toContain('PAIRING-CONTINUITY-4817')
    await f.client.close(before, randomUUID())
    await a.stop()
    const restarted = await f.launch(
      'Paired',
      f.source,
      true,
      false,
      undefined,
      false,
      config,
    )
    expect(restarted.nodeId).toBe(config.nodeId)
    await restarted.rpc('native-resume', { sessionId })
    await restarted.rpc('prompt', {
      sessionId,
      text: 'Recall the original marker.',
    })
    const after = await f.client.open(sessionId, 'read')
    expect((await f.client.read(after, 0, log.events.length)).events).toEqual(
      log.events,
    )
    await f.client.close(after, randomUUID())
    await restarted.stop()
    const list = z.array(z.object({ id: z.string() })).parse(await owner.list())
    await owner.revoke(list[0]!.id)
    await expect(new MeshClient(config).capabilities()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  } finally {
    await f.close()
  }
}, 60000)
