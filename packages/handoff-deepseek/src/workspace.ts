import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpath, stat, lstat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep, dirname, join } from 'node:path'
import { MeshError } from '../../protocol/src/index.js'
import type { ProjectMapping } from '../../client/src/handoff.js'
import { snapshotGit } from './workspace-files.js'

const execute = promisify(execFile)
export async function git(root: string, args: string[], signal?: AbortSignal) {
  return (
    await execute('git', ['-C', root, ...args], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      signal,
      timeout: 15000,
    })
  ).stdout.trim()
}
export function relativeInside(root: string, path: string): string {
  const value = relative(root, path)
  if (isAbsolute(value) || value === '..' || value.startsWith(`..${sep}`))
    throw new MeshError(
      'WORKSPACE_MISMATCH',
      'directory escapes the mapped project',
    )
  return value.split(sep).join('/')
}
export async function mappedDirectory(
  mapping: ProjectMapping,
  subdirectory: string,
) {
  const root = await realpath(mapping.root),
    cwd = await realpath(resolve(root, subdirectory))
  relativeInside(root, cwd)
  if (!(await stat(cwd)).isDirectory())
    throw new MeshError('WORKSPACE_MISMATCH', 'mapped path is not a directory')
  return { root, cwd }
}
/** Retain a valid local cwd, while recognizing an absolute path from another device. */
export async function localDirectory(mapping: ProjectMapping, cwd: string) {
  const { root } = await mappedDirectory(mapping, '')
  let subdirectory: string
  try {
    subdirectory = relativeInside(root, cwd)
  } catch (error) {
    if (!(error instanceof MeshError && error.code === 'WORKSPACE_MISMATCH'))
      throw error
    // Accept the configured root's spelling too (for example /var vs /private/var).
    try {
      subdirectory = relativeInside(mapping.root, cwd)
    } catch (aliasError) {
      if (
        aliasError instanceof MeshError &&
        aliasError.code === 'WORKSPACE_MISMATCH'
      )
        return undefined
      throw aliasError
    }
  }
  // Validate existing local paths too: do not reinterpret missing folders or escaping symlinks.
  return (await mappedDirectory(mapping, subdirectory)).cwd
}
/** Detect Git metadata before invoking Git, so plain directories need no Git executable. */
export async function hasGitContext(path: string) {
  let directory = await realpath(path)
  for (;;) {
    try {
      await lstat(join(directory, '.git'))
      return true
    } catch (error) {
      if (!(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error
    }
    const parent = dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}
export async function sourceWorkspaceRoot(
  cwd: string,
  policyRoot: string,
  signal?: AbortSignal,
) {
  if (await hasGitContext(cwd))
    return realpath(await git(cwd, ['rev-parse', '--show-toplevel'], signal))
  const root = await realpath(policyRoot)
  relativeInside(root, await realpath(cwd))
  return root
}
export async function inspectWorkspace(
  mapping: ProjectMapping,
  relativeCwd: string,
  signal?: AbortSignal,
  expectedKind?: 'git' | 'directory',
  expectedContentHash?: string,
) {
  const { root, cwd } = await mappedDirectory(mapping, relativeCwd)
  const kind =
    expectedKind ?? ((await hasGitContext(cwd)) ? 'git' : 'directory')
  if (kind === 'directory')
    return {
      root,
      cwd,
      proof: {
        contentHash: undefined as string | undefined,
        kind: 'directory' as const,
        projectId: mapping.projectId,
        commit: null,
        relativeCwd,
        mappingRevision: mapping.revision,
      },
    }

  if (expectedKind === 'git' && !(await hasGitContext(root)))
    throw new MeshError(
      'WORKSPACE_MISMATCH',
      'the source uses Git; prepare the matching Git repository on the target',
    )
  const gitRoot = await realpath(
    await git(root, ['rev-parse', '--show-toplevel'], signal),
  )
  if (root !== gitRoot)
    throw new MeshError(
      'WORKSPACE_MISMATCH',
      'mapping must name the Git repository root',
    )
  if (/^160000 /m.test(await git(root, ['ls-files', '--stage'], signal)))
    throw new MeshError(
      'UNSUPPORTED_RESOURCE',
      'submodules are not supported by M1',
    )
  if (expectedContentHash) {
    const current = await snapshotGit(root)
    if (current.treeHash !== expectedContentHash)
      throw new MeshError(
        'TRANSFER_CHANGED',
        'workspace changed after file transfer approval',
      )
  } else if (
    await git(
      root,
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--ignore-submodules=none',
      ],
      signal,
    )
  )
    throw new MeshError(
      'WORKSPACE_DIRTY',
      'commit changes or inspect and confirm a workspace file transfer before handoff',
    )
  return {
    root,
    cwd,
    proof: {
      kind: 'git' as const,
      projectId: mapping.projectId,
      commit: await git(root, ['rev-parse', 'HEAD'], signal),
      relativeCwd,
      mappingRevision: mapping.revision,
      ...(expectedContentHash ? { contentHash: expectedContentHash } : {}),
    },
  }
}
