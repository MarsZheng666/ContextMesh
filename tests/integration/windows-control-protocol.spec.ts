import { it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as windows from '../../packages/platform/src/windows.js'
import { privateDirectory } from '../../packages/runtime-manager/src/files.js'
import { controlSocketPath } from '../../packages/handoff-deepseek/src/local-control.js'
import {
  callWindowsLocal,
  listenWindowsLocal,
} from '../../packages/platform/src/windows-control.js'

it('protects the Windows control protocol against unauthorized commands and a forged server', async () => {
  // Exercise the real wire protocol on Unix too. Only the unavailable NTFS ACL
  // check is substituted there; Windows CI runs the real ACL implementation.
  const acl =
    process.platform === 'win32'
      ? undefined
      : vi.spyOn(windows, 'windowsPrivatePath').mockResolvedValue()
  const root = await mkdtemp(join(tmpdir(), 'cm-auth-'))
  const dir = join(root, 'control')
  await privateDirectory(dir)
  const path = await controlSocketPath(dir)
  let calls = 0
  const listener = await listenWindowsLocal(dir, path, async (command) => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 150))
    return command
  })
  try {
    expect(await callWindowsLocal(dir, path, { title: '中文' }, 5000)).toEqual({
      ok: true,
      value: { title: '中文' },
    })
    await new Promise<void>((accept, reject) => {
      const socket = createConnection(path)
      socket.once('error', reject)
      socket.once('data', () =>
        socket.end(
          JSON.stringify({
            payload: '{"delete":true}',
            proof: '0'.repeat(64),
          }) + '\n',
        ),
      )
      socket.once('close', () => accept())
    })
    expect(calls).toBe(1)
  } finally {
    await listener.close()
  }
  const fake = createServer((socket) => {
    socket.on('error', () => {})
    socket.end(
      JSON.stringify({
        nonce: randomBytes(32).toString('hex'),
        proof: '0'.repeat(64),
      }) + '\n',
    )
  })
  try {
    await new Promise<void>((accept, reject) => {
      fake.once('error', reject)
      fake.listen(path, accept)
    })
    await expect(
      callWindowsLocal(dir, path, { secret: 'must not be sent' }, 5000),
    ).rejects.toThrow('authentication failed')
  } finally {
    await new Promise<void>((accept) => fake.close(() => accept()))
    acl?.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
