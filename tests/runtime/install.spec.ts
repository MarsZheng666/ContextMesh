import { test, expect } from 'vitest'
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
} from 'node:fs/promises'
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
    await symlink('node', join(bundle, 'bin/internal-link'))
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

test('adoption preserves stopped device identity and model configuration in a private copy', async () => {
  const { adoptHome } =
    await import('../../packages/runtime-manager/src/supervisor.js')
  const root = await mkdtemp(join(tmpdir(), 'cm-adopt-')),
    source = join(root, 'old'),
    home = join(root, 'managed')
  try {
    await mkdir(join(source, 'contextmesh'), { recursive: true, mode: 0o755 })
    await writeFile(
      join(source, 'contextmesh/node.json'),
      JSON.stringify({
        nodeId: 'fixture-device',
        bindings: { project: 'workspace' },
      }),
      { mode: 0o644 },
    )
    await writeFile(join(source, 'models.json'), 'fixture model settings', {
      mode: 0o644,
    })
    await adoptHome(source, home)
    expect(
      await readFile(join(home, 'data/dsh/contextmesh/node.json'), 'utf8'),
    ).toBe(await readFile(join(source, 'contextmesh/node.json'), 'utf8'))
    expect(await readFile(join(home, 'data/dsh/models.json'), 'utf8')).toBe(
      'fixture model settings',
    )
    expect((await stat(join(home, 'data/dsh'))).mode & 0o077).toBe(0)
    expect((await stat(join(home, 'data/dsh/models.json'))).mode & 0o077).toBe(
      0,
    )
    await expect(adoptHome(source, home)).rejects.toThrow('will not overwrite')
    await expect(adoptHome(source, join(source, 'nested'))).rejects.toThrow(
      'separate',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
