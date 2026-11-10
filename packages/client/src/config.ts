import {
  privateDirectory,
  syncDirectory,
} from '../../runtime-manager/src/files.js'
import { windowsPrivatePath } from '../../platform/src/windows.js'
import { readFile, lstat, open, link, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  deviceConnection,
  type DeviceConnection,
} from '../../protocol/src/devices.js'
export const connectionPath = () =>
  process.env.CONTEXTMESH_CONFIG ??
  join(
    process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    'contextmesh',
    'connection.json',
  )
export async function readConnection(
  path = connectionPath(),
): Promise<DeviceConnection | undefined> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
  )
    throw new Error(
      'Connection config must be a private regular file (mode 600)',
    )
  if (process.platform === 'win32') await windowsPrivatePath(path)
  return deviceConnection.parse(JSON.parse(await readFile(path, 'utf8')))
}
export async function writeConnection(
  value: DeviceConnection,
  path = connectionPath(),
) {
  const config = deviceConnection.parse(value),
    dir = dirname(path)
  await privateDirectory(dir)
  const tmp = join(dir, '.connection-' + randomUUID() + '.tmp')
  const file = await open(tmp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(config, null, 2) + '\n')
    await file.sync()
    await file.close()
    // Atomic no-clobber publication; another setup cannot replace an existing credential.
    await link(tmp, path)
    await syncDirectory(dir)
  } finally {
    await file.close().catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}

export interface ConnectionOptions {
  endpoint?: string
  token?: string
  tokenEnv?: string
  configPath?: string
}
/** Resolve each field once; callers expose sources, never credentials. */
export async function resolveConnection(
  options: ConnectionOptions = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const path = options.configPath ?? connectionPath()
  const explicitToken =
    (options.token ?? env[options.tokenEnv ?? 'CONTEXTMESH_TOKEN']) || undefined
  const saved =
    explicitToken && (options.endpoint ?? env.CONTEXTMESH_ENDPOINT)
      ? undefined
      : await readConnection(path)
  const endpoint =
    options.endpoint ?? env.CONTEXTMESH_ENDPOINT ?? saved?.endpoint
  const token = explicitToken ?? saved?.token
  const source = {
    endpoint: options.endpoint
      ? 'plugin'
      : env.CONTEXTMESH_ENDPOINT
        ? 'environment'
        : saved
          ? path
          : 'missing',
    token: options.token
      ? 'plugin'
      : explicitToken
        ? 'environment'
        : saved
          ? path
          : 'missing',
  }
  return {
    endpoint,
    token,
    name: explicitToken ? undefined : saved?.name,
    nodeId: explicitToken ? undefined : saved?.nodeId,
    source,
    path,
    warnings: explicitToken
      ? ['Environment or plugin credentials override the saved connection.']
      : [],
  }
}

export function safeEndpoint(value?: string) {
  try {
    const u = new URL(value ?? '')
    return u.origin + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return undefined
  }
}
