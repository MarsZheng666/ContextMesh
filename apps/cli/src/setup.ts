import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { mkdir, readFile, open, unlink, lstat } from 'node:fs/promises'
import {
  connectionPath,
  readConnection,
  writeConnection,
} from '../../../packages/client/src/config.js'
import { DeviceClient } from '../../../packages/client/src/devices.js'
import { z } from 'zod'
export async function connectDevice(
  endpoint: string,
  code: string,
  path = connectionPath(),
) {
  if (await readConnection(path))
    throw new Error(
      'A connection already exists. Keep its backup before configuring another device.',
    )
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const directory = await lstat(dirname(path))
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error('Connection directory must be private without symlinks')
  const attempt = join(dirname(path), '.pairing-attempt.json')
  let claimId: string
  try {
    const info = await lstat(attempt)
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0)
      throw new Error('Pairing retry file must be private')
    const saved = z
      .object({ endpoint: z.string(), code: z.string(), claimId: z.uuid() })
      .parse(JSON.parse(await readFile(attempt, 'utf8')))
    if (saved.endpoint !== endpoint || saved.code !== code)
      throw new Error(
        'An interrupted pairing exists. Retry the same invitation or explicitly remove the private retry file first.',
      )
    claimId = saved.claimId
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    claimId = randomUUID()
    const file = await open(attempt, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ endpoint, code, claimId }))
      await file.sync()
    } finally {
      await file.close()
    }
  }
  const config = await DeviceClient.claim(endpoint, code, claimId)
  await writeConnection(config, path)
  await unlink(attempt)
  return { nodeId: config.nodeId, name: config.name, path }
}
export async function setup(input: string[]) {
  if (input[0] !== 'setup') return false
  if (input.length !== 1 || !stdin.isTTY)
    throw new Error(
      'Run setup in an interactive terminal; pairing secrets are prompted, not command arguments.',
    )
  const prompt = createInterface({ input: stdin, output: stdout })
  try {
    const endpoint = (await prompt.question('ContextMesh service URL: ')).trim()
    const code = (await prompt.question('One-time pairing code: ')).trim()
    const result = await connectDevice(endpoint, code)
    stdout.write(
      `Connected as ${result.name}. Restart DSH to use this connection.\n`,
    )
  } finally {
    prompt.close()
  }
  return true
}
