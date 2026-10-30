import { it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  mkdtemp,
  realpath,
  writeFile,
  mkdir,
  rm,
  readFile,
  symlink,
  link,
  chmod,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  snapshotGit,
  WorkspaceJournal,
  verifyWorkspace,
} from '../../packages/handoff-deepseek/src/workspace-files.js'
import {
  validateBundle,
  treeHash,
} from '../../packages/protocol/src/transfer-hash.js'
import { transferPath } from '../../packages/protocol/src/transfers.js'
const execute = promisify(execFile)
async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cm-files-'))),
    source = join(root, 'source'),
    target = join(root, 'target')
  await mkdir(source)
  const git = (cwd: string, args: string[]) =>
    execute('git', ['-C', cwd, ...args])
  await git(source, ['init', '-b', 'fixture'])
  await writeFile(join(source, 'a.txt'), 'original\n')
  await writeFile(join(source, 'delete.txt'), 'delete base\n')
  await writeFile(join(source, '.gitignore'), 'ignored/\n')
  await git(source, ['add', '.'])
  await git(source, [
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
  ])
  await execute('git', ['clone', '--local', source, target])
  const bundle = async () =>
    validateBundle({
      version: 1,
      sessionId: 'fixture',
      incarnation: randomUUID(),
      projectId: randomUUID(),
      sourceNodeId: randomUUID(),
      targetNodeId: randomUUID(),
      ...(await snapshotGit(source)),
      attachments: [],
    })
  return {
    root,
    source,
    target,
    git,
    bundle,
    close: () => rm(root, { recursive: true, force: true }),
  }
}
it('transfers binary, added, deleted and staged changes byte-for-byte, preserves executable mode, and rolls back without touching the source index', async () => {
  const f = await workspace()
  try {
    await writeFile(join(f.source, 'a.txt'), Buffer.from([0, 255, 17, 42]))
    await chmod(join(f.source, 'a.txt'), 0o755)
    await f.git(f.source, ['add', 'a.txt'])
    await rm(join(f.source, 'delete.txt'))
    await mkdir(join(f.source, 'nested'))
    await writeFile(join(f.source, 'nested/new.txt'), 'new\n')
    await mkdir(join(f.source, 'ignored'))
    await writeFile(join(f.source, 'ignored/secret.key'), 'not transferred')
    const b = await f.bundle(),
      id = randomUUID(),
      journal = new WorkspaceJournal(join(f.root, 'state'))
    expect(b.files.map((v) => v.path)).toEqual([
      'a.txt',
      'delete.txt',
      'nested/new.txt',
    ])
    await journal.apply(id, f.target, b)
    await journal.apply(id, f.target, b)
    expect(await readFile(join(f.target, 'a.txt'))).toEqual(
      Buffer.from([0, 255, 17, 42]),
    )
    expect((await snapshotGit(f.target)).treeHash).toBe(b.treeHash)
    expect(
      (await f.git(f.target, ['diff', '--cached', '--name-only'])).stdout,
    ).toBe('')
    expect(
      (await f.git(f.source, ['diff', '--cached', '--name-only'])).stdout,
    ).toContain('a.txt')
    await journal.rollback(id, f.target)
    await journal.rollback(id, f.target)
    expect((await f.git(f.target, ['status', '--porcelain'])).stdout).toBe('')
    expect(await readFile(join(f.target, 'delete.txt'), 'utf8')).toBe(
      'delete base\n',
    )
  } finally {
    await f.close()
  }
})
it('leaves a durable interrupted journal, blocks retry, preserves later edits, and allows explicit rollback after reconciliation', async () => {
  const f = await workspace()
  try {
    await writeFile(join(f.source, 'a.txt'), 'transferred\n')
    await writeFile(join(f.source, 'new.txt'), 'added')
    const b = await f.bundle(),
      id = randomUUID(),
      state = join(f.root, 'state')
    await expect(
      new WorkspaceJournal(state).apply(id, f.target, b, async () => {
        throw new Error('simulated crash')
      }),
    ).rejects.toThrow('crash')
    const restarted = new WorkspaceJournal(state)
    expect((await restarted.read(id))?.phase).toBe('prepared')
    await expect(restarted.apply(id, f.target, b)).rejects.toMatchObject({
      code: 'TRANSFER_RECOVERY_REQUIRED',
    })
    await writeFile(join(f.target, 'a.txt'), 'later user edit')
    await expect(restarted.rollback(id, f.target)).rejects.toMatchObject({
      code: 'TRANSFER_RECOVERY_REQUIRED',
    })
    expect(await readFile(join(f.target, 'a.txt'), 'utf8')).toBe(
      'later user edit',
    )
    await writeFile(join(f.target, 'a.txt'), 'transferred\n')
    await restarted.rollback(id, f.target)
    expect((await f.git(f.target, ['status', '--porcelain'])).stdout).toBe('')
  } finally {
    await f.close()
  }
})
it('rejects dirty targets, unsafe paths, hash corruption, symlink parents and hardlinked files before writing', async () => {
  const f = await workspace()
  try {
    await writeFile(join(f.source, 'a.txt'), 'change')
    const b = await f.bundle()
    await writeFile(join(f.target, 'a.txt'), 'target change')
    await expect(verifyWorkspace(f.target, b, 'base')).rejects.toMatchObject({
      code: 'WORKSPACE_DIRTY',
    })
    expect(await readFile(join(f.target, 'a.txt'), 'utf8')).toBe(
      'target change',
    )
    const bad = structuredClone(b)
    bad.files[0]!.data = Buffer.from('tampered').toString('base64')
    expect(() => validateBundle(bad)).toThrow('digest')
    for (const path of [
      '../outside',
      '/tmp/file',
      '.git/config',
      '.env',
      'nested/.ENV.prod',
      'credentials.json',
      'a/../../b',
      'a\\b',
      'a:stream',
    ])
      expect(transferPath.safeParse(path).success).toBe(false)
    await link(join(f.source, 'a.txt'), join(f.root, 'hardlink'))
    await expect(snapshotGit(f.source)).rejects.toMatchObject({
      code: 'TRANSFER_UNSUPPORTED_FILE',
    })
    await rm(join(f.root, 'hardlink'))
    await symlink(f.root, join(f.source, 'escape'))
    await expect(snapshotGit(f.source)).rejects.toThrow()
    await rm(join(f.source, 'escape'))
    await writeFile(join(f.source, '.env'), 'secret')
    await expect(snapshotGit(f.source)).rejects.toMatchObject({
      code: 'TRANSFER_UNSAFE_PATH',
    })
    const duplicate = structuredClone(b)
    duplicate.files.push({ ...duplicate.files[0]!, path: 'A.txt' })
    duplicate.treeHash = treeHash(duplicate.files)
    expect(() => validateBundle(duplicate)).toThrow()
  } finally {
    await f.close()
  }
})
