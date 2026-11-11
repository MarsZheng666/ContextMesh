import {
  cp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  chmod,
} from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  inventory,
  sha256,
} from '../../packages/runtime-manager/src/manifest.js'
import { STORAGE_SCHEMA_VERSION } from '../../packages/protocol/src/index.js'
import { copyDependencies } from './copy-dependencies.js'
const repo = process.cwd(),
  out = resolve(process.argv[2] ?? 'artifacts/runtime'),
  serverOnly = process.argv.includes('--server-only'),
  windows = process.platform === 'win32'
if (windows && (process.arch !== 'x64' || serverOnly))
  throw new Error('The Windows bundle supports native Codex on x64')
await mkdir(out, { recursive: false })
const app = serverOnly ? out : join(out, 'app')
await mkdir(app, { recursive: true })
await cp('dist', join(app, 'dist'), { recursive: true })
await writeFile(
  join(app, 'package.json'),
  JSON.stringify({ type: 'module', private: true }),
)
const roots = windows
  ? ['zod']
  : serverOnly
    ? ['fastify', 'pg', 'zod']
    : ['fastify', 'pg', 'zod', '@deepseek-ai/dsh', 'dsh-contextmesh-handoff']
const licenses = await copyDependencies(repo, join(app, 'node_modules'), roots)
await writeFile(
  join(out, 'THIRD-PARTY.json'),
  JSON.stringify(licenses, null, 2),
)
await writeFile(
  join(out, 'NOTICE'),
  'ContextMesh: https://github.com/MarsZheng666/ContextMesh\nThird-party license files are retained alongside each bundled package.\n',
)
if (serverOnly)
  await writeFile(
    join(out, 'server-release.json'),
    JSON.stringify({
      version: JSON.parse(
        await readFile('packages/handoff-deepseek/package.json', 'utf8'),
      ).version,
      protocol: 1,
      schema: STORAGE_SCHEMA_VERSION,
      postgresMajor: 18,
    }),
  )
if (!serverOnly) {
  await cp(
    process.env.NODE_LICENSE_PATH ??
      join(dirname(process.execPath), '../LICENSE'),
    join(out, 'NODE-LICENSE'),
  )
  await mkdir(join(out, 'bin'))
  const nodeName = windows ? 'node.exe' : 'node'
  await cp(process.execPath, join(out, 'bin', nodeName))
  if (!windows) await chmod(join(out, 'bin/node'), 0o755)
  if (windows)
    await writeFile(
      join(out, 'bin/contextmesh.cmd'),
      '@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "CONTEXTMESH_BUNDLE=%~dp0.."\r\n"%~dp0node.exe" "%~dp0..\\app\\dist\\cli.js" %*\r\nexit /b %errorlevel%\r\n',
    )
  else
    await writeFile(
      join(out, 'bin/contextmesh'),
      '#!/bin/sh\nCM_BUNDLE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport CONTEXTMESH_BUNDLE="$CM_BUNDLE"\nexec "$CM_BUNDLE/bin/node" "$CM_BUNDLE/app/dist/cli.js" "$@"\n',
      { mode: 0o755 },
    )
  const p = JSON.parse(
    await readFile('packages/handoff-deepseek/package.json', 'utf8'),
  )
  const patches = (await readdir('patches')).sort()
  let patchText = ''
  for (const name of patches)
    patchText += name + (await readFile(join('patches', name), 'utf8'))
  const manifest = {
    format: 1,
    version: p.version,
    platform: process.platform + '-' + process.arch,
    components: windows ? ['codex'] : ['codex', 'dsh'],
    ...(process.platform === 'linux'
      ? {
          minimumGlibc: (
            process.report.getReport() as {
              header: { glibcVersionRuntime: string }
            }
          ).header.glibcVersionRuntime,
        }
      : {}),
    node: process.version,
    dsh: '0.2.1-rc.3',
    protocol: 1,
    schema: STORAGE_SCHEMA_VERSION,
    minSchema: 8,
    maxSchema: STORAGE_SCHEMA_VERSION,
    sourceCommit:
      process.env.SOURCE_COMMIT ??
      execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
    lockHash: sha256(await readFile('pnpm-lock.yaml')),
    patchHash: sha256(patchText),
    files: await inventory(out),
  }
  await writeFile(
    join(out, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      output: out,
      version: p.version,
      platform: manifest.platform,
      packages: licenses.length,
      manifestHash: sha256(await readFile(join(out, 'manifest.json'))),
    }),
  )
}
