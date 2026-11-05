import {
  resumeServerUpgrade,
  restoreServer,
  backupServer,
  serverMaintenance,
  upgradeServer,
} from '../../../packages/runtime-manager/src/server-upgrade.js'
import {
  upgrade,
  checkUpgrade,
  rollback,
} from '../../../packages/runtime-manager/src/upgrade.js'
import { diagnose } from '../../../packages/runtime-manager/src/doctor.js'
import { tunnelSettings } from '../../../packages/runtime-manager/src/tunnel.js'
import {
  initServer,
  startServer,
} from '../../../packages/runtime-manager/src/server.js'
import { installAutostart } from '../../../packages/runtime-manager/src/autostart.js'
import { resolve, join } from 'node:path'
import {
  installBundle,
  runtimeHome,
  selection,
} from '../../../packages/runtime-manager/src/install.js'
import {
  startRuntime,
  supervise,
  runtimeStatus,
  openRuntime,
  adoptHome,
  stopRuntime,
} from '../../../packages/runtime-manager/src/supervisor.js'
import {
  atomicJson,
  optionalJson,
} from '../../../packages/runtime-manager/src/files.js'
export async function runRuntime(args: string[]) {
  const [command, ...rest] = args,
    home = runtimeHome()
  if (command === '--help' || command === 'help' || !command) {
    console.log(
      'ContextMesh\n  install <unpacked-bundle> [--sha256 <manifest-sha256>]\n  setup\n  dsh [--port <port>]\n  open [--print-url]\n  status\n  stop\n  adopt <DSH_HOME> --confirm-stopped\n  doctor\n  codex import | run | --help\n  server init | start\n  upgrade --check | <bundle>\n  rollback\nCredentials are entered interactively or read from private configuration files.',
    )
    return true
  }
  if (command === 'install') {
    const path = rest[0] ?? process.env.CONTEXTMESH_BUNDLE
    if (!path) throw new Error('Provide the unpacked runtime directory')
    const hash = rest.includes('--sha256')
      ? rest[rest.indexOf('--sha256') + 1]
      : undefined
    console.log(JSON.stringify(await installBundle(resolve(path), home, hash)))
    return true
  }
  if (command === 'runtime-supervise') {
    if (!rest[0]) throw new Error('Managed home required')
    await supervise(rest[0])
    return true
  }
  if (command === 'dsh') {
    const settings = ((await optionalJson(join(home, 'settings.json'))) ?? {
      cwd: process.cwd(),
    }) as Record<string, unknown>
    if (rest.includes('--port')) {
      const port = Number(rest[rest.indexOf('--port') + 1])
      if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('Invalid port')
      settings.port = port
    }
    await atomicJson(join(home, 'settings.json'), settings)
    console.log(JSON.stringify(await startRuntime(home)))
    return true
  }
  if (command === 'status') {
    console.log(JSON.stringify(await runtimeStatus(home), null, 2))
    return true
  }
  if (command === 'open') {
    console.log(await openRuntime(home, rest.includes('--print-url')))
    return true
  }
  if (command === 'stop') {
    await stopRuntime(home)
    console.log('Stopped')
    return true
  }
  if (command === 'adopt') {
    if (!rest[0] || !rest.includes('--confirm-stopped'))
      throw new Error(
        'Stop the old DSH and its tools, then run adopt <DSH_HOME> --confirm-stopped',
      )
    console.log(JSON.stringify(await adoptHome(rest[0], home)))
    return true
  }
  // Existing developer CLI defaults stay intact; installed runtimes use their private persistent DSH home.
  if (await selection(home)) {
    process.env.DSH_HOME ??= join(home, 'data/dsh')
    process.env.CONTEXTMESH_CONFIG ??= join(
      home,
      'data/dsh/contextmesh/connection.json',
    )
  }
  if (command === 'upgrade') {
    const source = rest.find((x) => !x.startsWith('--'))
    if (!source)
      throw new Error(
        'Provide a verified unpacked runtime directory: upgrade <bundle> [--check]',
      )
    const result = rest.includes('--check')
      ? await checkUpgrade(resolve(source), home)
      : await upgrade(resolve(source), home)
    console.log(JSON.stringify(result, null, 2))
    return true
  }
  if (command === 'rollback') {
    console.log(JSON.stringify(await rollback(home), null, 2))
    return true
  }
  if (command === 'doctor') {
    const report = {
      connection: await diagnose(),
      runtime: await runtimeStatus(home),
    }
    console.log(JSON.stringify(report, null, 2))
    if (!report.connection.ready) process.exitCode = 1
    return true
  }
  if (command === 'tunnel' && rest[0] === 'configure') {
    const value = (key: string) => rest[rest.indexOf(key) + 1]
    for (const key of ['--host', '--local-port', '--remote-port'])
      if (!rest.includes(key)) throw new Error('Missing ' + key)
    await atomicJson(
      join(home, 'tunnel.json'),
      tunnelSettings.parse({
        host: value('--host'),
        localPort: Number(value('--local-port')),
        remotePort: Number(value('--remote-port')),
      }),
    )
    console.log(
      'Tunnel saved. Complete the first SSH login in your terminal, then restart the managed DSH. No password is stored.',
    )
    return true
  }
  if (command === 'autostart' && rest[0] === 'install') {
    console.log(JSON.stringify(await installAutostart(home)))
    return true
  }
  if (command === 'server') {
    const value = (key: string) =>
      rest.includes(key) ? rest[rest.indexOf(key) + 1] : undefined
    const directory = value('--directory') ?? join(home, 'server')
    if (rest[0] === 'init') {
      const image = value('--image'),
        endpoint = value('--endpoint')
      if (!image || !endpoint)
        throw new Error(
          'server init requires --image <image@sha256:digest> --endpoint <URL>',
        )
      console.log(JSON.stringify(await initServer(directory, image, endpoint)))
      return true
    }
    if (rest[0] === 'maintenance') {
      if (!['on', 'off'].includes(rest[1] ?? ''))
        throw new Error('Use server maintenance on|off')
      console.log(
        JSON.stringify(await serverMaintenance(directory, rest[1] === 'on')),
      )
      return true
    }
    if (rest[0] === 'resume-upgrade') {
      console.log(JSON.stringify(await resumeServerUpgrade(directory)))
      return true
    }
    if (rest[0] === 'restore') {
      const backup = value('--backup')
      if (
        !backup ||
        !rest.includes('--confirm-stopped') ||
        !rest.includes('--confirm-data-loss')
      )
        throw new Error(
          'Restoring overwrites the database. Stop every client and the API, then provide --backup <directory> --confirm-stopped --confirm-data-loss',
        )
      console.log(JSON.stringify(await restoreServer(directory, backup)))
      return true
    }
    if (rest[0] === 'backup') {
      console.log(JSON.stringify(await backupServer(directory)))
      return true
    }
    if (rest[0] === 'upgrade') {
      const image = value('--image')
      if (!image) throw new Error('Provide --image <image@sha256:digest>')
      console.log(JSON.stringify(await upgradeServer(directory, image)))
      return true
    }
    if (rest[0] === 'start') {
      console.log(JSON.stringify(await startServer(directory)))
      return true
    }
  }
  return false
}
