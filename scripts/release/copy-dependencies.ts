import {
  cp,
  mkdir,
  readFile,
  realpath,
  symlink,
  access,
} from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
export async function copyDependencies(
  repo: string,
  destination: string,
  roots: string[],
) {
  // The Windows Codex client only needs zod at runtime. Materialize it without
  // junctions/symlinks so ZIP extraction needs neither admin nor Developer Mode.
  if (process.platform === 'win32') {
    if (roots.length !== 1 || roots[0] !== 'zod')
      throw new Error('Unsupported Windows dependency set')
    const source = await realpath(join(repo, 'node_modules/zod'))
    await mkdir(destination, { recursive: true })
    await cp(source, join(destination, 'zod'), {
      recursive: true,
      dereference: true,
    })
    const p = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    return [{ name: p.name, version: p.version, license: p.license }]
  }
  const visited = new Map<string, string>()
  const shared = new Map<string, Set<string>>()
  const licenses: Array<{ name: string; version: string; license: unknown }> =
    []
  async function locate(name: string, from: string) {
    if (name === 'dsh-contextmesh-handoff')
      return join(repo, 'packages/handoff-deepseek')
    if (name === 'dsh-contextmesh')
      return join(repo, 'packages/adapter-deepseek')
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', name)
      try {
        await access(join(candidate, 'package.json'))
        return realpath(candidate)
      } catch {}
      if (dirname(dir) === dir) break
    }
    throw new Error('Missing runtime dependency ' + name)
  }
  async function copy(name: string, from: string): Promise<string> {
    const source = await realpath(await locate(name, from))
    const known = visited.get(source)
    if (known) return known
    const p = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    const id =
      p.name.replaceAll('/', '+') +
      '-' +
      p.version +
      '-' +
      createHash('sha256')
        .update(relative(repo, source))
        .digest('hex')
        .slice(0, 10)
    const target = join(destination, '.store', id)
    visited.set(source, target)
    if (!shared.has(p.name)) shared.set(p.name, new Set())
    shared.get(p.name)!.add(target)
    await mkdir(target, { recursive: true })
    await cp(source, target, {
      recursive: true,
      dereference: false,
      filter: (path) =>
        !['node_modules', '.git', 'tests', 'test'].includes(
          relative(source, path).split(sep)[0] ?? '',
        ),
    })
    licenses.push({
      name: p.name,
      version: p.version,
      license: p.license ?? 'See package license',
    })
    for (const dep of new Set([
      ...Object.keys(p.dependencies ?? {}),
      ...Object.keys(p.optionalDependencies ?? {}),
      ...Object.keys(p.peerDependencies ?? {}),
    ])) {
      let found: string
      try {
        found = await locate(dep, source)
      } catch (error) {
        if (
          p.optionalDependencies?.[dep] ||
          p.peerDependenciesMeta?.[dep]?.optional
        )
          continue
        throw error
      }
      const child = await copy(dep, dirname(dirname(found)))
      const link = join(target, 'node_modules', dep)
      await mkdir(dirname(link), { recursive: true })
      await symlink(relative(dirname(link), child), link)
    }
    return target
  }
  for (const name of roots) {
    const target = await copy(name, repo),
      link = join(destination, name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), target), link)
  }
  // Native loaders resolve platform packages from their own scope. Preserve
  // the common ancestor lookup used by pnpm, but never guess between versions.
  for (const [name, targets] of shared) {
    if (targets.size !== 1) continue
    const link = join(destination, '.store/node_modules', name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(relative(dirname(link), [...targets][0]!), link)
  }
  return licenses.sort((a, b) => a.name.localeCompare(b.name))
}
