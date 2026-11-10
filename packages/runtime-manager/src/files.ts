import { mkdir, open, rename, readFile, lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { windowsPrivatePath } from '../../platform/src/windows.js'
import { randomUUID } from 'node:crypto'
// Cache only directories validated in this process; replacement invalidates the identity.
const windowsDirectories = new Map<
  string,
  { identity: string; ready: Promise<void> }
>()
export async function privateDirectory(path: string) {
  const created = await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.platform !== 'win32' && stat.mode & 0o077)
  )
    throw new Error(
      'Use a private directory (mode 700), without symbolic links',
    )
  if (process.platform === 'win32') {
    const identity = [stat.dev, stat.ino, stat.birthtimeMs].join(':')
    let known = windowsDirectories.get(path)
    if (!known || known.identity !== identity) {
      known = {
        identity,
        ready: windowsPrivatePath(path, created !== undefined),
      }
      windowsDirectories.set(path, known)
    }
    try {
      await known.ready
    } catch (error) {
      windowsDirectories.delete(path)
      throw error
    }
  }
}
export async function syncDirectory(path: string) {
  // Windows does not expose directory fsync through Node. File data is flushed before publication.
  if (process.platform === 'win32') return
  const dir = await open(path, 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}
export async function atomicJson(path: string, data: unknown) {
  await privateDirectory(dirname(path))
  const temp = path + '.' + randomUUID() + '.tmp'
  const file = await open(temp, 'wx', 0o600)
  try {
    await file.writeFile(JSON.stringify(data, null, 2) + '\n')
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(temp, path)
  await syncDirectory(dirname(path))
}
export async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
