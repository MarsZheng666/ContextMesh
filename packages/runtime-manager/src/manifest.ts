import { createHash } from 'node:crypto'
import { readFile, readdir, lstat, readlink, realpath } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { z } from 'zod'
export const releaseManifest = z.object({
  format: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/),
  platform: z.enum(['darwin-arm64', 'linux-x64']),
  minimumGlibc: z
    .string()
    .regex(/^\d+\.\d+$/)
    .optional(),
  node: z.string(),
  dsh: z.literal('0.2.1-rc.3'),
  protocol: z.literal(1),
  schema: z.number().int().positive(),
  minSchema: z.number().int().positive(),
  maxSchema: z.number().int().positive(),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  lockHash: z.string().length(64),
  patchHash: z.string().length(64),
  files: z.record(
    z.string(),
    z.object({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      mode: z.number().int(),
      link: z.string().optional(),
    }),
  ),
})
export type ReleaseManifest = z.infer<typeof releaseManifest>
export const sha256 = (data: string | Uint8Array) =>
  createHash('sha256').update(data).digest('hex')
export function inside(root: string, path: string) {
  const r = relative(resolve(root), resolve(path))
  return r !== '..' && !r.startsWith('../') && !isAbsolute(r)
}
export async function inventory(root: string) {
  root = await realpath(root)
  const entries: ReleaseManifest['files'] = Object.create(null)
  async function visit(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name),
        rel = relative(root, path),
        info = await lstat(path)
      if (rel === 'manifest.json') continue
      if (!info.isSymbolicLink() && info.mode & 0o7000)
        throw new Error('Special permission bits are not allowed: ' + rel)
      if (info.isSymbolicLink()) {
        const link = await readlink(path)
        if (isAbsolute(link) || !inside(root, await realpath(path)))
          throw new Error('Bundle link escapes its root: ' + rel)
        entries[rel] = { sha256: sha256(link), mode: info.mode & 0o777, link }
      } else if (info.isDirectory()) await visit(path)
      else if (info.isFile())
        entries[rel] = {
          sha256: sha256(await readFile(path)),
          mode: info.mode & 0o777,
        }
      else throw new Error('Unsupported bundle entry: ' + rel)
    }
  }
  await visit(root)
  return entries
}
export async function verifyBundle(
  root: string,
  expectedHash?: string,
  platform = `${process.platform}-${process.arch}`,
) {
  const manifestInfo = await lstat(join(root, 'manifest.json'))
  if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink())
    throw new Error('Manifest must be a regular file')
  const bytes = await readFile(join(root, 'manifest.json'))
  if (expectedHash && sha256(bytes) !== expectedHash)
    throw new Error('Release manifest checksum does not match')
  const m = releaseManifest.parse(JSON.parse(bytes.toString()))
  if (m.platform !== platform)
    throw new Error('This release is for ' + m.platform + ', not ' + platform)
  if (m.platform === 'linux-x64' && m.minimumGlibc) {
    const report = process.report.getReport() as {
      header: { glibcVersionRuntime?: string }
    }
    const actual = report.header.glibcVersionRuntime?.split('.').map(Number)
    const required = m.minimumGlibc.split('.').map(Number)
    if (
      !actual ||
      actual[0]! < required[0]! ||
      (actual[0] === required[0] && actual[1]! < required[1]!)
    )
      throw new Error(
        'This runtime requires glibc ' + m.minimumGlibc + ' or newer',
      )
  }
  if (m.minSchema > m.schema || m.maxSchema < m.schema)
    throw new Error('Invalid database compatibility range')
  const actual = await inventory(root)
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(m.files).sort())
  )
    throw new Error('Release files failed integrity verification')
  for (const required of ['bin/node', 'bin/contextmesh', 'app/dist/cli.js'])
    if (!m.files[required]) throw new Error('Incomplete runtime: ' + required)
  return m
}
