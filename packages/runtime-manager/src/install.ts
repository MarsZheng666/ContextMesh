import {
  cp,
  mkdir,
  rename,
  rm,
  lstat,
  writeFile,
  readFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { privateDirectory, atomicJson, optionalJson } from './files.js'
import { verifyBundle, sha256 } from './manifest.js'
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
  const sourceHash = sha256(await readFile(join(source, 'manifest.json')))
  hash = sourceHash
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
  await privateDirectory(join(home, 'bin'))
  await privateDirectory(join(home, 'bootstrap'))
  await cp(
    join(home, 'releases', manifest.version, 'bin/node'),
    join(home, 'bootstrap/node'),
  )
  await writeFile(
    join(home, 'bootstrap/launch.mjs'),
    `import {readFileSync} from 'node:fs';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';import {dirname,resolve,join} from 'node:path';const home=resolve(dirname(fileURLToPath(import.meta.url)),'..');const {version}=JSON.parse(readFileSync(join(home,'current.json'),'utf8'));if(!/^[0-9][a-z0-9.-]*$/.test(version))throw Error('Invalid version');const bundle=join(home,'releases',version);const child=spawn(join(bundle,'bin/node'),[join(bundle,'app/dist/cli.js'),...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,CONTEXTMESH_HOME:home,CONTEXTMESH_BUNDLE:bundle}});for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));child.on('exit',(code)=>{process.exitCode=code??1});child.on('error',()=>{process.exitCode=1});`,
    { mode: 0o600 },
  )
  await writeFile(
    join(home, 'bin/contextmesh'),
    '#!/bin/sh\nCM_HOME=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$CM_HOME/bootstrap/node" "$CM_HOME/bootstrap/launch.mjs" "$@"\n',
    { mode: 0o755 },
  )
  return { version: manifest.version, home }
}
