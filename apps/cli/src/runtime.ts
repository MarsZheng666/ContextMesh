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
      'ContextMesh\n  install <unpacked-bundle> [--sha256 <manifest-sha256>]\n  setup\n  dsh [--port <port>]\n  open [--print-url]\n  status\n  stop\n  adopt <DSH_HOME> --confirm-stopped\n  doctor\n  server init | start\n  upgrade --check | <bundle>\n  rollback\nCredentials are entered interactively or read from private configuration files.',
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
  return false
}
