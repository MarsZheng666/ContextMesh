import { cp, mkdir, rename, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { privateDirectory, atomicJson, optionalJson } from './files.js'
import { verifyBundle } from './manifest.js'
export const runtimeHome = () =>
  process.env.CONTEXTMESH_HOME ?? join(homedir(), '.contextmesh')
export const selectionSchema = z.object({
  version: z.string().regex(/^[0-9][a-z0-9.-]*$/),
  previous: z
    .string()
    .regex(/^[0-9][a-z0-9.-]*$/)
    .optional(),
})
export async function selection(home = runtimeHome()) {
  const raw = await optionalJson(join(home, 'current.json'))
  return raw === undefined ? undefined : selectionSchema.parse(raw)
}
export async function stageBundle(
  source: string,
  home = runtimeHome(),
  hash?: string,
) {
  const manifest = await verifyBundle(source, hash)
  await privateDirectory(home)
  await privateDirectory(join(home, 'releases'))
  const destination = join(home, 'releases', manifest.version)
  try {
    await lstat(destination)
    await verifyBundle(destination, hash)
    return { manifest, destination }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const stage = join(home, 'releases', '.stage-' + randomUUID())
  await mkdir(stage, { mode: 0o700 })
  try {
    await cp(source, stage, { recursive: true, verbatimSymlinks: true })
    await verifyBundle(stage, hash)
    await rename(stage, destination)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
  return { manifest, destination }
}
export async function installBundle(
  source: string,
  home = runtimeHome(),
  hash?: string,
) {
  if (await selection(home))
    throw new Error(
      'Already installed. Use upgrade to preserve the active instance.',
    )
  const { manifest } = await stageBundle(source, home, hash)
  await atomicJson(join(home, 'current.json'), { version: manifest.version })
  await privateDirectory(join(home, 'data'))
  return { version: manifest.version, home }
}
