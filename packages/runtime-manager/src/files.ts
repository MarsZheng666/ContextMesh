import { mkdir, open, rename, readFile, lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error(
      'Use a private directory (mode 700), without symbolic links',
    )
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
  const dir = await open(dirname(path), 'r')
  try {
    await dir.sync()
  } finally {
    await dir.close()
  }
}
export async function optionalJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
