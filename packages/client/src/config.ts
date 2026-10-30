import { mkdir, readFile, lstat, open, link, unlink } from 'node:fs/promises'
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
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      'Connection config must be a private regular file (mode 600)',
    )
  return deviceConnection.parse(JSON.parse(await readFile(path, 'utf8')))
}
export async function writeConnection(
  value: DeviceConnection,
  path = connectionPath(),
) {
  const config = deviceConnection.parse(value),
    dir = dirname(path)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const info = await lstat(dir)
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
    throw new Error(
      'Connection directory must be private (mode 700), without symlinks',
    )
  const tmp = join(dir, '.connection-' + randomUUID() + '.tmp')
  const file = await open(tmp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(config, null, 2) + '\n')
    await file.sync()
    await file.close()
    // Atomic no-clobber publication; another setup cannot replace an existing credential.
    await link(tmp, path)
    const directory = await open(dir, 'r')
    try {
      await directory.sync()
    } finally {
      await directory.close()
    }
  } finally {
    await file.close().catch(() => {})
    await unlink(tmp).catch(() => {})
  }
}
