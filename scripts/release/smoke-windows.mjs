import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

if (process.platform !== 'win32')
  throw new Error('Run this smoke test on Windows')
const bundle = resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'cm-packaged-'))
const home = join(root, '中文 runtime & space')
const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  ),
  PATH: [join(systemRoot, 'System32'), systemRoot].join(';'),
  CONTEXTMESH_HOME: home,
}
const run = (exe, args) =>
  execFileSync(exe, args, {
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  })
const batch = (path, args) =>
  execFileSync(
    process.env.COMSPEC ?? join(systemRoot, 'System32/cmd.exe'),
    ['/d', '/s', '/c', '""' + path + '" ' + args + '"'],
    {
      env,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true,
      timeout: 60000,
    },
  )
try {
  assert.match(
    batch(join(bundle, 'bin/contextmesh.cmd'), '--help'),
    /ContextMesh/,
  )
  const node = join(bundle, 'bin/node.exe'),
    cli = join(bundle, 'app/dist/cli.js')
  assert.match(run(node, [cli, '--help']), /ContextMesh/)
  run(node, [cli, 'install', bundle])
  assert.match(
    run(join(home, 'bootstrap/node.exe'), [
      join(home, 'bootstrap/launch.mjs'),
      'codex',
      '--help',
    ]),
    /ContextMesh Codex/,
  )
  assert.match(
    batch(join(home, 'bin/contextmesh.cmd'), 'codex --help'),
    /ContextMesh Codex/,
  )
  const manifest = JSON.parse(
    await readFile(join(bundle, 'manifest.json'), 'utf8'),
  )
  assert.equal(manifest.platform, 'win32-x64')
  assert.deepEqual(manifest.components, ['codex'])
  assert.ok(Object.keys(manifest.files).every((path) => !path.includes('\\')))
  assert.ok(Object.values(manifest.files).every((file) => !file.link))
  console.log(
    'Windows package installs and starts without a global Node, shell scripts or filesystem links.',
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
