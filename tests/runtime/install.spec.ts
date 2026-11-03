import { test, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  inventory,
  verifyBundle,
  sha256,
} from '../../packages/runtime-manager/src/manifest.js'
import {
  installBundle,
  selection,
} from '../../packages/runtime-manager/src/install.js'
test('verified install preserves an existing runtime and rejects tampering and escaping links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-install-')),
    bundle = join(root, 'bundle'),
    home = join(root, 'home')
  try {
    await mkdir(join(bundle, 'bin'), { recursive: true })
    await mkdir(join(bundle, 'app/dist'), { recursive: true })
    for (const p of ['bin/node', 'bin/contextmesh', 'app/dist/cli.js'])
      await writeFile(join(bundle, p), 'fixture', { mode: 0o755 })
    const m = {
      format: 1,
      version: '0.7.0',
      platform: process.platform + '-' + process.arch,
      node: process.version,
      dsh: '0.2.1-rc.3',
      protocol: 1,
      schema: 1,
      minSchema: 1,
      maxSchema: 1,
      sourceCommit: 'a'.repeat(40),
      lockHash: 'b'.repeat(64),
      patchHash: 'c'.repeat(64),
      files: await inventory(bundle),
    }
    const text = JSON.stringify(m)
    await writeFile(join(bundle, 'manifest.json'), text)
    await expect(
      verifyBundle(bundle, sha256(text), 'other-platform'),
    ).rejects.toThrow('not other-platform')
    await installBundle(bundle, home, sha256(text))
    expect((await selection(home))?.version).toBe('0.7.0')
    await expect(installBundle(bundle, home)).rejects.toThrow(
      'Already installed',
    )
    await writeFile(join(bundle, 'bin/node'), 'tampered')
    await expect(verifyBundle(bundle)).rejects.toThrow('integrity')
    await symlink('/etc/hosts', join(bundle, 'escape'))
    await expect(verifyBundle(bundle)).rejects.toThrow('escapes')
    expect((await selection(home))?.version).toBe('0.7.0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
