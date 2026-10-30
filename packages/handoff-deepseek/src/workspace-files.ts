import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import {
  open,
  lstat,
  mkdir,
  rename,
  unlink,
  rmdir,
  realpath,
} from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MeshError } from '../../protocol/src/index.js'
import {
  MAX_FILE_BYTES,
  MAX_TRANSFER_BYTES,
  transferPath,
  transferBundle,
  type TransferFile,
  type TransferBundle,
} from '../../protocol/src/transfers.js'
import {
  sha256,
  treeHash,
  validateBundle,
  bundleDigest,
} from '../../protocol/src/transfer-hash.js'
const execute = promisify(execFile)
async function git(root: string, args: string[]) {
  return (
    await execute('git', ['-C', root, ...args], {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15000,
    })
  ).stdout
}
const absent = (e: unknown) =>
  !!e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT'
async function checkedPath(
  root: string,
  path: string,
  create = false,
  created: string[] = [],
) {
  transferPath.parse(path)
  const parts = path.split('/')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (e) {
      if (!absent(e)) throw e
      if (!create) continue
      await mkdir(current, { mode: 0o755 })
      created.push(current)
      info = await lstat(current)
    }
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new MeshError(
        'TRANSFER_UNSAFE_PATH',
        'file parent must be a real directory',
      )
  }
  return join(root, path)
}
export async function readRegular(root: string, path: string) {
  const full = await checkedPath(root, path)
  let handle
  try {
    handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (e) {
    if (absent(e)) return null
    throw e
  }
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_FILE_BYTES)
      throw new MeshError(
        'TRANSFER_UNSUPPORTED_FILE',
        'only bounded regular files with one link can transfer',
      )
    const bytes = await handle.readFile(),
      after = await handle.stat()
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length > MAX_FILE_BYTES
    )
      throw new MeshError('TRANSFER_CHANGED', 'file changed while reading')
    return {
      data: bytes.toString('base64'),
      hash: sha256(bytes),
      mode: (before.mode & 0o111 ? '100755' : '100644') as '100644' | '100755',
    }
  } finally {
    await handle.close()
  }
}
export async function snapshotGit(root: string) {
  if (
    (await realpath(
      (await git(root, ['rev-parse', '--show-toplevel'])).toString().trim(),
    )) !== root
  )
    throw new MeshError('WORKSPACE_MISMATCH', 'mapping must be a Git root')
  if ((await git(root, ['ls-files', '--unmerged', '-z'])).length)
    throw new MeshError(
      'UNSUPPORTED_RESOURCE',
      'resolve Git merge conflicts before transfer',
    )
  const index = (await git(root, ['ls-files', '--stage', '-z'])).toString()
  if (/(?:^|\0)(?:120000|160000) /.test(index))
    throw new MeshError(
      'UNSUPPORTED_RESOURCE',
      'symlinks and submodules are not supported for workspace transfer',
    )
  if (
    (await git(root, ['ls-files', '-v', '-z']))
      .toString()
      .split('\0')
      .some((line) => /^(?:[a-z]|S) /.test(line))
  )
    throw new MeshError(
      'UNSUPPORTED_RESOURCE',
      'clear assume-unchanged and skip-worktree flags before transfer',
    )
  const baseCommit = (await git(root, ['rev-parse', 'HEAD'])).toString().trim()
  const changed = (
    await git(root, [
      'diff',
      '--no-ext-diff',
      '--no-renames',
      '--name-only',
      '-z',
      'HEAD',
      '--',
    ])
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const added = (
    await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
  const paths = [...new Set([...changed, ...added])].sort()
  if (paths.length > 64)
    throw new MeshError(
      'TRANSFER_TOO_LARGE',
      'at most 64 workspace files can transfer',
    )
  const files: TransferFile[] = []
  let size = 0
  for (const path of paths) {
    if (!transferPath.safeParse(path).success)
      throw new MeshError(
        'TRANSFER_UNSAFE_PATH',
        'a changed path is unsafe or may contain credentials; remove it from this transfer workspace',
      )
    const entry =
      (await git(root, ['ls-tree', '-z', 'HEAD', '--', path]))
        .toString()
        .split('\t')[0] ?? ''
    const mode = entry.split(' ')[0]
    let baseHash: string | null = null,
      baseMode: TransferFile['baseMode'] = null
    if (entry) {
      if (!['100644', '100755'].includes(mode!))
        throw new MeshError(
          'UNSUPPORTED_RESOURCE',
          'only regular Git files can transfer',
        )
      const base = await git(root, ['cat-file', 'blob', `HEAD:${path}`])
      if (base.length > MAX_FILE_BYTES)
        throw new MeshError(
          'TRANSFER_TOO_LARGE',
          'base file is too large for safe rollback',
        )
      baseHash = sha256(base)
      baseMode = mode as '100644' | '100755'
    }
    const current = await readRegular(root, path)
    if (!current && baseHash === null)
      throw new MeshError(
        'TRANSFER_CHANGED',
        'file disappeared during snapshot',
      )
    size += current?.data ? Buffer.from(current.data, 'base64').length : 0
    if (size > MAX_TRANSFER_BYTES)
      throw new MeshError(
        'TRANSFER_TOO_LARGE',
        'workspace exceeds transfer size limit',
      )
    files.push({
      path,
      baseHash,
      baseMode,
      hash: current?.hash ?? null,
      mode: current?.mode ?? null,
      data: current?.data ?? null,
    })
  }
  if ((await git(root, ['rev-parse', 'HEAD'])).toString().trim() !== baseCommit)
    throw new MeshError('TRANSFER_CHANGED', 'Git commit changed while reading')
  return { baseCommit, files, treeHash: treeHash(files) }
}
export async function verifyWorkspace(
  root: string,
  b: TransferBundle,
  mode: 'base' | 'applied',
) {
  if (b.baseCommit === null) return
  const snapshot = await snapshotGit(root)
  if (snapshot.baseCommit !== b.baseCommit)
    throw new MeshError(
      'WORKSPACE_MISMATCH',
      'prepare the same Git commit before applying files',
    )
  if (mode === 'applied') {
    if (snapshot.treeHash !== b.treeHash)
      throw new MeshError(
        'TRANSFER_CHANGED',
        'workspace contents no longer match the approved transfer',
      )
    return
  }
  if (
    (
      await git(root, [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ])
    ).length
  )
    throw new MeshError(
      'WORKSPACE_DIRTY',
      'destination has local changes; preserve them before applying',
    )
  for (const f of b.files) {
    const current = await readRegular(root, f.path)
    if (
      (current?.hash ?? null) !== f.baseHash ||
      (current?.mode ?? null) !== f.baseMode
    )
      throw new MeshError(
        'TRANSFER_CONFLICT',
        'destination content conflicts with the recorded base',
      )
  }
}
const journalSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  digest: z.string(),
  bundle: transferBundle,
  phase: z.enum(['prepared', 'applied', 'rolled-back']),
  created: z.array(z.string()),
})
async function syncDirectory(path: string) {
  const dir = await open(path, 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}
async function save(path: string, value: unknown) {
  const tmp = path + '.' + randomUUID() + '.tmp',
    file = await open(tmp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(value))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(tmp, path)
  await syncDirectory(dirname(path))
}
async function writeDesired(
  root: string,
  f: TransferFile,
  base: boolean,
  created: string[],
) {
  const full = await checkedPath(root, f.path, true, created)
  if (base) throw new Error('base writes require journal bytes')
  if (f.data === null) {
    await unlink(full)
    await syncDirectory(dirname(full))
    return
  }
  const tmp = join(dirname(full), '.cm-transfer-' + randomUUID()),
    file = await open(tmp, 'wx', f.mode === '100755' ? 0o755 : 0o644)
  try {
    await file.writeFile(Buffer.from(f.data, 'base64'))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(tmp, full)
  await syncDirectory(dirname(full))
}
export class WorkspaceJournal {
  constructor(readonly stateDir: string) {}
  private async directory(id: string) {
    z.uuid().parse(id)
    const parent = join(this.stateDir, 'workspace-transfers')
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const info = await lstat(parent)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new MeshError(
        'TRANSFER_UNSAFE_PATH',
        'transfer journal must be a private owned directory',
      )
    const dir = join(parent, id)
    try {
      await mkdir(dir, { mode: 0o700 })
    } catch (e) {
      if (!(e && typeof e === 'object' && 'code' in e && e.code === 'EEXIST'))
        throw e
    }
    const child = await lstat(dir)
    if (
      !child.isDirectory() ||
      child.isSymbolicLink() ||
      (child.mode & 0o077) !== 0
    )
      throw new MeshError('TRANSFER_UNSAFE_PATH', 'invalid journal directory')
    return dir
  }
  async read(id: string) {
    const path = join(await this.directory(id), 'journal.json')
    let file
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (e) {
      if (absent(e)) return undefined
      throw e
    }
    try {
      return journalSchema.parse(JSON.parse(await file.readFile('utf8')))
    } finally {
      await file.close()
    }
  }
  async apply(
    id: string,
    root: string,
    input: TransferBundle,
    afterWrite?: (index: number) => Promise<void>,
  ) {
    const bundle = validateBundle(input),
      dir = await this.directory(id),
      prior = await this.read(id)
    if (prior && prior.phase !== 'rolled-back') {
      if (prior.root !== root || prior.digest !== bundleDigest(bundle))
        throw new MeshError(
          'TRANSFER_CONFLICT',
          'journal belongs to another workspace or snapshot',
        )
      if (prior.phase === 'applied') {
        await verifyWorkspace(root, bundle, 'applied')
        return
      }
      throw new MeshError(
        'TRANSFER_RECOVERY_REQUIRED',
        'an interrupted import needs explicit rollback before retry',
      )
    }
    await verifyWorkspace(root, bundle, 'base')
    const before: Record<
      string,
      Awaited<ReturnType<typeof readRegular>>
    > = Object.create(null)
    for (const f of bundle.files)
      before[f.path] = await readRegular(root, f.path)
    await save(join(dir, 'before.json'), before)
    const journal = {
      version: 1 as const,
      root,
      digest: bundleDigest(bundle),
      bundle,
      phase: 'prepared' as 'prepared' | 'applied' | 'rolled-back',
      created: [] as string[],
    }
    await save(join(dir, 'journal.json'), journal)
    // A failed write leaves the durable journal for explicit, content-checked recovery.
    for (const [index, f] of bundle.files.entries()) {
      const current = await readRegular(root, f.path)
      if (
        (current?.hash ?? null) !== f.baseHash ||
        (current?.mode ?? null) !== f.baseMode
      )
        throw new MeshError(
          'TRANSFER_CONFLICT',
          'destination changed during import; inspect recovery journal',
        )
      await checkedPath(root, f.path, true, journal.created)
      await save(join(dir, 'journal.json'), journal)
      await writeDesired(root, f, false, journal.created)
      await afterWrite?.(index)
    }
    await verifyWorkspace(root, bundle, 'applied')
    journal.phase = 'applied'
    await save(join(dir, 'journal.json'), journal)
  }
  async rollback(id: string, root: string) {
    const journal = await this.read(id)
    if (!journal || journal.root !== root)
      throw new MeshError(
        'NOT_FOUND',
        'no import journal for this workspace',
        404,
      )
    validateBundle(journal.bundle)
    if (journal.phase === 'rolled-back') return
    const dir = await this.directory(id),
      file = await open(
        join(dir, 'before.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
    let before: Record<
      string,
      { data: string; hash: string; mode: '100644' | '100755' } | null
    >
    try {
      before = JSON.parse(await file.readFile('utf8'))
    } finally {
      await file.close()
    }
    for (const f of journal.bundle.files) {
      const current = await readRegular(root, f.path),
        previous = before[f.path]
      if (
        (previous?.hash ?? null) !== f.baseHash ||
        (previous?.mode ?? null) !== f.baseMode ||
        (previous &&
          sha256(Buffer.from(previous.data, 'base64')) !== previous.hash)
      )
        throw new MeshError(
          'TRANSFER_CORRUPT',
          'recovery backup digest mismatch',
        )
      const hash = current?.hash ?? null,
        mode = current?.mode ?? null
      if (!(
        (hash === f.hash && mode === f.mode) ||
        (hash === f.baseHash && mode === f.baseMode)
      ))
        throw new MeshError(
          'TRANSFER_RECOVERY_REQUIRED',
          'a file has later edits; preserve them and resolve manually before rollback',
        )
    }
    for (const f of [...journal.bundle.files].reverse()) {
      const current = await readRegular(root, f.path),
        previous = before[f.path]
      if (
        (current?.hash ?? null) === f.baseHash &&
        (current?.mode ?? null) === f.baseMode
      )
        continue
      await writeDesired(
        root,
        { ...f, data: previous?.data ?? null, mode: previous?.mode ?? null },
        false,
        [],
      )
    }
    for (const dir of [...journal.created].reverse()) {
      if (!dir.startsWith(root + '/'))
        throw new MeshError(
          'TRANSFER_CORRUPT',
          'journal directory escapes project',
        )
      try {
        await rmdir(dir)
      } catch (e) {
        if (!(
          e &&
          typeof e === 'object' &&
          'code' in e &&
          ['ENOTEMPTY', 'ENOENT'].includes(String(e.code))
        ))
          throw e
      }
    }
    journal.phase = 'rolled-back'
    await save(join(dir, 'journal.json'), journal)
  }
}
