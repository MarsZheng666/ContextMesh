import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { it, expect, vi } from 'vitest'
import {
  inspectWorkspace,
  localDirectory,
  mappedDirectory,
  relativeInside,
} from '../../packages/handoff-deepseek/src/workspace.js'
const execute = promisify(execFile)
it('validates a clean Git root and rejects dirty, untracked, traversal, symlink and submodule workspaces', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mesh-workspace-')),
    root = join(base, 'repo'),
    outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)
  const git = (...args: string[]) => execute('git', ['-C', root, ...args])
  try {
    await git('init')
    await writeFile(join(root, 'file'), 'clean')
    await git('add', '.')
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'fixture',
    )
    const mapping = {
      projectId: randomUUID(),
      nodeId: randomUUID(),
      root,
      revision: 1,
    }
    const clean = await inspectWorkspace(mapping, '')
    expect(await localDirectory(mapping, root)).toBe(clean.root)
    expect(await localDirectory(mapping, outside)).toBeUndefined()
    await expect(
      localDirectory(mapping, join(root, 'missing')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(clean.proof.commit).toMatch(/^[a-f0-9]{40}$/)
    await writeFile(join(root, 'file'), 'dirty')
    await expect(inspectWorkspace(mapping, '')).rejects.toMatchObject({
      code: 'WORKSPACE_DIRTY',
    })
    await git('checkout', '--', 'file')
    await writeFile(join(root, 'untracked'), 'new')
    await expect(inspectWorkspace(mapping, '')).rejects.toMatchObject({
      code: 'WORKSPACE_DIRTY',
    })
    await rm(join(root, 'untracked'))
    await expect(mappedDirectory(mapping, '../outside')).rejects.toMatchObject({
      code: 'WORKSPACE_MISMATCH',
    })
    await symlink(outside, join(root, 'escape'))
    await expect(mappedDirectory(mapping, 'escape')).rejects.toMatchObject({
      code: 'WORKSPACE_MISMATCH',
    })
    await expect(
      localDirectory(mapping, join(root, 'escape')),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    await rm(join(root, 'escape'))
    expect(() => relativeInside(root, outside)).toThrow()
    await git(
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${clean.proof.commit},nested`,
    )
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@localhost',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-m',
      'submodule fixture',
    )
    await expect(inspectWorkspace(mapping, '')).rejects.toMatchObject({
      code: 'UNSUPPORTED_RESOURCE',
    })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

it('allows plain directories without Git installed while refusing to downgrade a Git transfer', async () => {
  const base = await mkdtemp(join(tmpdir(), 'mesh-plain-')),
    root = join(base, 'notes')
  await mkdir(root)
  await writeFile(join(root, 'ordinary-file'), 'local content')
  const mapping = {
    projectId: randomUUID(),
    nodeId: randomUUID(),
    root,
    revision: 1,
  }
  try {
    vi.stubEnv('PATH', '')
    expect((await inspectWorkspace(mapping, '')).proof).toMatchObject({
      kind: 'directory',
      commit: null,
    })
    await expect(
      inspectWorkspace(mapping, '', undefined, 'git'),
    ).rejects.toMatchObject({ code: 'WORKSPACE_MISMATCH' })
    await expect(
      inspectWorkspace(mapping, '../outside', undefined, 'directory'),
    ).rejects.toThrow()
    await writeFile(join(root, '.git'), 'gitdir: /missing-fixture-worktree')
    await expect(inspectWorkspace(mapping, '')).rejects.toThrow()
  } finally {
    vi.unstubAllEnvs()
    await rm(base, { recursive: true, force: true })
  }
})
