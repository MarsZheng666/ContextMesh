import { it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, stat, readFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../fixture.js'
import { DeviceClient } from '../../packages/client/src/devices.js'
import { MeshClient } from '../../packages/client/src/index.js'
import { connectDevice } from '../../apps/cli/src/setup.js'
import {
  readConnection,
  writeConnection,
} from '../../packages/client/src/config.js'
import type { DeviceConnection } from '../../packages/protocol/src/devices.js'
const invitation = (value: unknown) =>
  value as { code: string; id: string; expiresAt: number }
it('pairs once, keeps secrets hashed, binds device identity, and revokes access without changing history', async () => {
  const f = await fixture(),
    owner = new DeviceClient(f.client)
  const original = await f.client.create(
    { id: randomUUID(), version: 4, isSeeded: false, createdAt: 0 },
    0,
  )
  await f.client.flush(original, randomUUID())
  const requestId = randomUUID(),
    pair = invitation(await owner.create('Laptop', requestId))
  expect(await owner.create('Laptop', requestId)).toEqual(pair)
  const claimId = randomUUID(),
    config = await DeviceClient.claim(f.endpoint, pair.code, claimId)
  expect(await DeviceClient.claim(f.endpoint, pair.code, claimId)).toEqual(
    config,
  )
  const device = new MeshClient(config),
    client = new DeviceClient(device)
  expect(await device.list()).toHaveLength(1)
  expect(await client.identity()).toEqual({
    role: 'device',
    nodeId: config.nodeId,
  })
  await expect(client.create('Another')).rejects.toMatchObject({
    code: 'OWNER_REQUIRED',
  })
  await expect(
    device.request('/v1/nodes/register', { nodeId: randomUUID() }),
  ).rejects.toMatchObject({ code: 'WRONG_DEVICE' })
  await expect(
    device.request(`/v1/nodes/${randomUUID()}/offline`, {
      instanceId: device.instanceId,
    }),
  ).rejects.toMatchObject({ code: 'WRONG_DEVICE' })
  await expect(
    DeviceClient.claim(f.endpoint, pair.code, randomUUID()),
  ).rejects.toMatchObject({ code: 'PAIRING_INVALID' })
  const stored = (
    await f.store.pool.query(
      'SELECT * FROM cm_device_credentials WHERE namespace=$1',
      [f.namespace],
    )
  ).rows
  expect(stored).toHaveLength(1)
  expect(JSON.stringify(stored)).not.toContain(config.token)
  const invitations = (
    await f.store.pool.query('SELECT * FROM cm_pairings WHERE namespace=$1', [
      f.namespace,
    ])
  ).rows
  expect(JSON.stringify(invitations)).not.toContain(pair.code)
  expect(
    await f.store.authenticateDevice('wrong-namespace', config.token),
  ).toBeUndefined()
  await owner.revoke(stored[0].id)
  await expect(device.capabilities()).rejects.toMatchObject({
    code: 'UNAUTHORIZED',
  })
  await expect(
    DeviceClient.claim(f.endpoint, pair.code, claimId),
  ).rejects.toMatchObject({ code: 'PAIRING_INVALID' })
  expect((await f.client.stat(original.session.id))?.header).toEqual(
    original.session.header,
  )
})
it('serializes concurrent redemption and expires invitations without extending retries', async () => {
  const f = await fixture(),
    owner = new DeviceClient(f.client)
  const operationId = randomUUID(),
    pair = invitation(await owner.create('Tablet', operationId, 30))
  const results = await Promise.allSettled([
    DeviceClient.claim(f.endpoint, pair.code, randomUUID()),
    DeviceClient.claim(f.endpoint, pair.code, randomUUID()),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const expired = invitation(await owner.create('Expired'))
  await f.store.pool.query(
    "UPDATE cm_pairings SET expires_at=clock_timestamp()-interval '1 second' WHERE namespace=$1 AND id=$2",
    [f.namespace, expired.id],
  )
  await expect(
    DeviceClient.claim(f.endpoint, expired.code, randomUUID()),
  ).rejects.toMatchObject({ code: 'PAIRING_INVALID' })
  await expect(owner.create('Changed', operationId, 30)).rejects.toMatchObject({
    code: 'IDEMPOTENCY_CONFLICT',
  })
  expect(
    invitation(await owner.create('Tablet', operationId, 30)).expiresAt,
  ).toBe(pair.expiresAt)
})
it('limits outstanding invitations transactionally across different requests', async () => {
  const f = await fixture(),
    owner = new DeviceClient(f.client)
  const results = await Promise.allSettled(
    Array.from({ length: 12 }, (_, i) => owner.create('Device ' + i)),
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
})
it('resumes interrupted host setup with the same claim and saves only one private credential', async () => {
  const f = await fixture(),
    owner = new DeviceClient(f.client),
    dir = await mkdtemp(join(tmpdir(), 'cm-setup-')),
    path = join(dir, 'connection.json')
  f.defer(() => rm(dir, { recursive: true, force: true }))
  const pair = invitation(await owner.create('New device')),
    transport = globalThis.fetch
  let dropped = 0
  vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
    const response = await transport(...args)
    if (String(args[0]).endsWith('/v1/pairings/claim') && dropped++ < 3)
      throw new Error('response lost')
    return response
  })
  try {
    await expect(
      connectDevice(f.endpoint, pair.code, path),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await readConnection(path)).toBeUndefined()
    expect(
      await readFile(join(dir, '.pairing-attempt.json'), 'utf8'),
    ).toContain('claimId')
    vi.stubGlobal('fetch', transport)
    const result = await connectDevice(f.endpoint, pair.code, path),
      config = (await readConnection(path))!
    expect(config.nodeId).toBe(result.nodeId)
    expect((await stat(path)).mode & 0o077).toBe(0)
    expect(await new MeshClient(config).capabilities()).toMatchObject({
      protocolVersion: 1,
    })
    expect(
      (
        await f.store.pool.query(
          'SELECT count(*) FROM cm_device_credentials WHERE namespace=$1',
          [f.namespace],
        )
      ).rows[0].count,
    ).toBe('1')
    await expect(connectDevice(f.endpoint, pair.code, path)).rejects.toThrow(
      'already exists',
    )
  } finally {
    vi.unstubAllGlobals()
  }
})
it('publishes credentials without clobbering or following a target symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cm-config-')),
    path = join(dir, 'connection.json')
  try {
    const config: DeviceConnection = {
      version: 1,
      endpoint: 'https://mesh.example',
      token: 'x'.repeat(32),
      nodeId: randomUUID(),
      name: 'Laptop',
    }
    const results = await Promise.allSettled([
      writeConnection(config, path),
      writeConnection({ ...config, name: 'Different' }, path),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    await chmod(path, 0o644)
    await expect(readConnection(path)).rejects.toThrow('private')
    await rm(path)
    await symlink(join(dir, 'missing'), path)
    await expect(writeConnection(config, path)).rejects.toThrow()
    await expect(readConnection(path)).rejects.toThrow('private')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
