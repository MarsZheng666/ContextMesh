import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const exec = promisify(execFile),
  bundle = resolve(process.argv[2]),
  root = await mkdtemp(join(tmpdir(), 'cm-release-smoke-')),
  home = join(root, 'home')
const base = {
  HOME: root,
  PATH: '/usr/bin:/bin',
  TMPDIR: tmpdir(),
  CONTEXTMESH_HOME: home,
}
let success = false
const cli = join(bundle, 'bin/contextmesh')
const run = async (args) =>
  exec(cli, args, { env: base, timeout: 300000, maxBuffer: 1024 * 1024 })
try {
  await run(['--help'])
  assert.match(
    (await run(['codex', '--help'])).stdout,
    /codex takeover .*--confirm/,
  )
  await run(['install', bundle])
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({ cwd: root, port: 0 }),
    { mode: 0o600 },
  )
  await run(['dsh'])
  const status = JSON.parse((await run(['status'])).stdout)
  assert.equal(status.running, true)
  assert.equal(status.ready, true)
  const url = (await run(['open', '--print-url'])).stdout.trim()
  const login = await fetch(url, { redirect: 'manual' }),
    cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ')
  assert(cookie)
  const reply = await fetch(new URL('/api/contextmesh', url), {
    headers: { cookie },
  })
  const r = await reply.json()
  assert.equal(r.ok, true)
  assert.equal(r.value.connectivity.state, 'unconfigured')
  assert.deepEqual(r.value.sessions, [])
  const profile = JSON.parse(
    await readFile(join(home, 'data/dsh/profiles/web/package.json'), 'utf8'),
  )
  assert.deepEqual(Object.keys(profile.dependencies), [
    'dsh-contextmesh-handoff',
  ])
  await run(['stop'])
  assert.equal(JSON.parse((await run(['status'])).stdout).running, false)
  success = true
  console.log(
    JSON.stringify({
      platform: process.platform + '-' + process.arch,
      installed: true,
      offlineUi: true,
      singlePlugin: true,
      codexTakeoverCommand: true,
      noGlobalNodeOrPackageManager: true,
      stopped: true,
    }),
  )
} finally {
  try {
    await run(['stop'])
  } catch {}
  const state = await run(['status'])
    .then((r) => JSON.parse(r.stdout))
    .catch(() => undefined)
  if (success && state?.running === false)
    await rm(root, { recursive: true, force: true })
  else console.error('Preserved test home for safe cleanup: ' + root)
}
