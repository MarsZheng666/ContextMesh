import { test, expect, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { inventory } from '../../packages/runtime-manager/src/manifest.js'
import {
  installBundle,
  selection,
} from '../../packages/runtime-manager/src/install.js'
import {
  upgrade,
  rollback,
} from '../../packages/runtime-manager/src/upgrade.js'
import { atomicJson } from '../../packages/runtime-manager/src/files.js'
import { fixture, TOKEN } from '../fixture.js'
const header = () => ({
  id: randomUUID(),
  version: 4,
  createdAt: 1,
  isSeeded: false,
})
const event = (seq: number) => ({
  seq,
  type: 'turn/start',
  time: seq + 1,
  data: { turn: seq + 1 },
})
async function bundle(root: string, version: string) {
  const dir = join(root, version)
  await mkdir(join(dir, 'bin'), { recursive: true })
  await mkdir(join(dir, 'app/dist'), { recursive: true })
  for (const p of ['bin/node', 'bin/contextmesh', 'app/dist/cli.js'])
    await writeFile(join(dir, p), 'fixture', { mode: 0o755 })
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      format: 1,
      version,
      platform: process.platform + '-' + process.arch,
      node: process.version,
      dsh: '0.2.1-rc.3',
      protocol: 1,
      schema: 6,
      minSchema: 6,
      maxSchema: 6,
      sourceCommit: 'a'.repeat(40),
      lockHash: 'b'.repeat(64),
      patchHash: 'c'.repeat(64),
      files: await inventory(dir),
    }),
  )
  return dir
}
test('upgrade refuses busy tasks, resumes its journal and preserves data through rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-upgrade-')),
    home = join(root, 'home')
  vi.stubEnv('CONTEXTMESH_TOKEN', '')
  vi.stubEnv('CONTEXTMESH_ENDPOINT', '')
  try {
    const before = await bundle(root, '0.6.1'),
      after = await bundle(root, '0.7.0')
    await installBundle(before, home)
    const id = randomUUID(),
      state = join(home, 'data/dsh/contextmesh')
    await mkdir(state, { recursive: true, mode: 0o700 })
    await atomicJson(join(state, 'node.json'), {
      nodeId: id,
      bindings: { preserve: 'this' },
    })
    let running = true,
      busy = true,
      failStart = false
    const hooks = {
      async running() {
        return running
      },
      async stop() {
        if (busy) throw Error('busy')
        running = false
      },
      async start() {
        running = true
        if (failStart) {
          failStart = false
          throw Error('start failed')
        }
      },
      async health() {},
    }
    await expect(upgrade(after, home, undefined, hooks)).rejects.toThrow('busy')
    expect((await selection(home))?.version).toBe('0.6.1')
    busy = false
    expect((await upgrade(after, home, undefined, hooks)).phase).toBe(
      'verified',
    )
    expect((await selection(home))?.version).toBe('0.7.0')
    expect(
      JSON.parse(await readFile(join(state, 'node.json'), 'utf8')).nodeId,
    ).toBe(id)
    await rollback(home, hooks)
    expect((await selection(home))?.version).toBe('0.6.1')
    failStart = true
    await expect(upgrade(after, home, undefined, hooks)).rejects.toThrow(
      'start failed',
    )
    expect((await selection(home))?.version).toBe('0.6.1')
    expect(
      JSON.parse(await readFile(join(home, 'upgrade.json'), 'utf8')).phase,
    ).toBe('rolled-back')
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
test('maintenance fences new writers transactionally while existing writers drain', async () => {
  const f = await fixture()
  const h = await f.client.create(header(), 0)
  await f.client.append(h, [event(0)], randomUUID())
  const result = (await f.client.request('/v1/admin/maintenance', {
    enabled: true,
  })) as any
  expect(result.writers).toBe(1)
  await expect(f.client.create(header(), 0)).rejects.toMatchObject({
    code: 'MAINTENANCE',
  })
  // Direct store callers cannot race the HTTP maintenance guard.
  await expect(
    f.store.create(f.namespace, {
      operationId: randomUUID(),
      instanceId: randomUUID(),
      adapter: 'deepseek',
      header: header(),
      inheritedEventCount: 0,
    }),
  ).rejects.toMatchObject({ code: 'MAINTENANCE' })
  await f.client.append(h, [event(1)], randomUUID())
  await f.client.flush(h, randomUUID())
  await f.client.close(h, randomUUID())
  const drained = (await f.client.request('/v1/admin/maintenance')) as any
  expect(drained.writers).toBe(0)
  await f.client.request('/v1/admin/maintenance', { enabled: false })
  expect((await f.client.list())[0]?.nextSeq).toBe(2)
})
