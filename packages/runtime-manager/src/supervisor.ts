import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  mkdir,
  readFile,
  writeFile,
  symlink,
  unlink,
  realpath,
  open,
  cp,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  listenLocal,
  callLocal,
} from '../../handoff-deepseek/src/local-control.js'
import { atomicJson, optionalJson, privateDirectory } from './files.js'
import { runtimeHome, selection } from './install.js'
const execute = promisify(execFile)
export const runtimeSettings = z.object({
  port: z.number().int().min(0).max(65535).default(3080),
  cwd: z.string(),
  caFile: z.string().optional(),
})
export const managedPaths = (home: string) => ({
  data: join(home, 'data'),
  dsh: join(home, 'data', 'dsh'),
  state: join(home, 'data', 'dsh', 'contextmesh'),
  run: join(home, 'run'),
})
export async function runtimeStatus(
  home = runtimeHome(),
): Promise<Record<string, unknown>> {
  try {
    const reply = z
      .object({ ok: z.literal(true), value: z.record(z.string(), z.unknown()) })
      .parse(
        await callLocal(managedPaths(home).run, { action: 'status' }, 1500),
      )
    return reply.value
  } catch {
    return { running: false, version: (await selection(home))?.version }
  }
}
export async function prepareProfile(home: string, bundle: string) {
  const p = managedPaths(home),
    profile = join(p.dsh, 'profiles/web'),
    plugin = await realpath(
      join(bundle, 'app/node_modules/dsh-contextmesh-handoff'),
    )
  await privateDirectory(p.dsh)
  await privateDirectory(p.state)
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  const file = join(profile, 'package.json'),
    previous = ((await optionalJson(file)) ?? {}) as Record<string, unknown>
  const dependencies: Record<string, string> = {
    ...(previous.dependencies as Record<string, string>),
    'dsh-contextmesh-handoff': `link:${plugin}`,
  }
  delete dependencies['dsh-contextmesh']
  const bundles = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'dsh-contextmesh-handoff',
  ]
  await atomicJson(file, {
    ...previous,
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  })
  const link = join(profile, 'node_modules/dsh-contextmesh-handoff')
  await unlink(link).catch((e) => {
    if (e.code !== 'ENOENT') throw e
  })
  await symlink(plugin, link)
}
export async function startRuntime(home = runtimeHome()) {
  const current = await selection(home)
  if (!current)
    throw new Error('Install a runtime first: contextmesh install <bundle>')
  const existing = await runtimeStatus(home)
  if (existing.running) return existing
  const paths = managedPaths(home)
  await privateDirectory(paths.run)
  const bundle = join(home, 'releases', current.version)
  const output = await open(join(paths.run, 'supervisor.log'), 'a', 0o600)
  const child = spawn(
    join(bundle, 'bin/node'),
    [join(bundle, 'app/dist/cli.js'), 'runtime-supervise', resolve(home)],
    {
      detached: true,
      stdio: ['ignore', output.fd, output.fd],
      env: { ...process.env, CONTEXTMESH_HOME: resolve(home) },
    },
  )
  await new Promise<void>((ok, fail) => {
    child.once('spawn', ok)
    child.once('error', fail)
  })
  child.unref()
  await output.close()
  for (let attempt = 0; attempt < 100; attempt++) {
    await delay(300)
    const s = await runtimeStatus(home)
    if (s.ready) return s
    if (s.error) throw new Error(String(s.error))
  }
  throw new Error(
    'DSH has not become ready. Run contextmesh doctor; see the private supervisor log.',
  )
}
export async function supervise(home: string) {
  const current = await selection(home)
  if (!current) throw new Error('No selected runtime')
  const p = managedPaths(home),
    bundle = join(home, 'releases', current.version)
  const settings = runtimeSettings.parse(
    (await optionalJson(join(home, 'settings.json'))) ?? { cwd: process.cwd() },
  )
  await privateDirectory(p.run)
  await prepareProfile(home, bundle)
  let child: ReturnType<typeof spawn> | undefined,
    url = '',
    failure = '',
    stopping = false
  const control = await listenLocal(p.run, async (input) => {
    const action = z
      .object({ action: z.enum(['status', 'open', 'stop']) })
      .parse(input).action
    if (action === 'open') {
      if (!url) throw new Error('DSH is not ready')
      return { url }
    }
    if (action === 'stop') {
      if (!child || stopping) return { stopping: true }
      // A live controller must explicitly fence and flush before stopping.
      const r = z
        .object({
          ok: z.boolean(),
          value: z.object({ ready: z.boolean() }).optional(),
          error: z.unknown().optional(),
        })
        .parse(await callLocal(p.state, { action: 'prepare-upgrade' }, 15000))
      if (!r.ok || !r.value?.ready)
        throw new Error(
          'DSH is busy or cannot verify its writers. Resolve active work before stopping.',
        )
      stopping = true
      child.kill('SIGTERM')
      return { stopping: true }
    }
    return {
      running: !!child && child.exitCode === null,
      ready: !!url,
      version: current.version,
      url: url ? new URL(url).origin : undefined,
      error: failure || undefined,
    }
  })
  const env = {
    ...process.env,
    DSH_HOME: p.dsh,
    CONTEXTMESH_CONFIG: join(p.state, 'connection.json'),
    ...(settings.caFile ? { NODE_EXTRA_CA_CERTS: settings.caFile } : {}),
  }
  child = spawn(
    join(bundle, 'bin/node'),
    [
      join(bundle, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
      '--profile',
      'web',
      '--host',
      '127.0.0.1',
      '--port',
      String(settings.port),
      '--no-open',
    ],
    { cwd: settings.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const log = await open(join(p.run, 'dsh.log'), 'a', 0o600)
  let output = ''
  const consume = (b: Buffer) => {
    void log.write(b)
    output = (output + b.toString()).slice(-12000)
    const match = [
      ...output.matchAll(
        /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/g,
      ),
    ].at(-1)
    if (match?.[1]) url = match[1]
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  child.on('error', (e) => {
    failure = (e as NodeJS.ErrnoException).code ?? 'DSH_START_FAILED'
  })
  const stop = () => {
    stopping = true
    child?.kill('SIGTERM')
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  await new Promise<void>((resolve) => child!.once('close', () => resolve()))
  await log.close()
  await control.close()
  process.off('SIGTERM', stop)
  process.off('SIGINT', stop)
}
export async function stopRuntime(home = runtimeHome()) {
  const r = z
    .object({
      ok: z.boolean(),
      error: z.object({ message: z.string() }).optional(),
    })
    .parse(await callLocal(managedPaths(home).run, { action: 'stop' }, 20000))
  if (!r.ok) throw new Error(r.error?.message ?? 'Could not stop DSH')
  for (let i = 0; i < 100; i++) {
    if (!(await runtimeStatus(home)).running) return
    await delay(200)
  }
  throw new Error('DSH is still draining. No process was forcibly terminated.')
}
export async function openRuntime(home = runtimeHome(), print = false) {
  const r = z
    .object({ ok: z.literal(true), value: z.object({ url: z.string().url() }) })
    .parse(await callLocal(managedPaths(home).run, { action: 'open' }, 3000))
  if (print) return r.value.url
  await execute(process.platform === 'darwin' ? 'open' : 'xdg-open', [
    r.value.url,
  ])
  return 'Opened the authenticated DSH page.'
}
export async function adoptHome(source: string, home = runtimeHome()) {
  const p = managedPaths(home)
  await privateDirectory(p.data)
  if (await optionalJson(join(p.dsh, 'profiles/web/package.json')))
    throw new Error(
      'Managed DSH already exists; adoption will not overwrite it',
    )
  const original = await realpath(source)
  // Copy configuration only. Live sockets, caches and dependency links do not belong in a backup.
  await cp(original, p.dsh, {
    recursive: true,
    dereference: false,
    filter: (path) =>
      !['node_modules', '.cache', 'logs'].some((x) =>
        path.slice(original.length).split('/').includes(x),
      ) && !path.endsWith('.sock'),
  })
  await cp(p.dsh, join(p.data, 'adopted-backup-' + Date.now()), {
    recursive: true,
    dereference: false,
  })
  return { adopted: true }
}
