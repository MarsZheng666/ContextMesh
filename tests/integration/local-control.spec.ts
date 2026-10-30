import { it, expect } from 'vitest'
import { mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listenLocal,
  callLocal,
  controlSocketPath,
} from '../../packages/handoff-deepseek/src/local-control.js'
it('serves private, isolated control sockets from long and aliased state directories without replacing a live listener', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-control-')),
    a = join(root, 'a'.repeat(90)),
    b = join(root, 'b'.repeat(90))
  await mkdir(a)
  await mkdir(b)
  await symlink(a, join(root, 'alias'))
  const first = await listenLocal(a, async () => ({ device: 'A' })),
    second = await listenLocal(b, async () => ({ device: 'B' }))
  try {
    const path = await controlSocketPath(a)
    expect(Buffer.byteLength(path)).toBeLessThan(100)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await callLocal(join(root, 'alias'), {})).toEqual({
      ok: true,
      value: { device: 'A' },
    })
    expect(await callLocal(b, {})).toEqual({ ok: true, value: { device: 'B' } })
    await expect(
      listenLocal(a, async () => ({ device: 'Wrong' })),
    ).rejects.toThrow('Another ContextMesh')
    expect(await callLocal(a, {})).toEqual({ ok: true, value: { device: 'A' } })
  } finally {
    await first.close()
    await second.close()
    await rm(root, { recursive: true, force: true })
  }
})
