import { createServer, createConnection, type Socket } from 'node:net'
import { chmod, unlink, mkdir, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/** AF_UNIX paths are limited to roughly 100 bytes on supported hosts. */
export async function controlSocketPath(stateDir: string) {
  const root = await realpath(stateDir),
    direct = join(root, 'control.sock')
  if (Buffer.byteLength(direct) < 100) return direct
  const directory = join(
    process.platform === 'darwin' ? '/private/tmp' : '/tmp',
    `contextmesh-sockets-${process.getuid!()}`,
  )
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  const info = await lstat(directory)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error(
      'ContextMesh control directory must be private and owned by the current user',
    )
  return join(
    directory,
    createHash('sha256').update(root).digest('hex').slice(0, 24) + '.sock',
  )
}

export async function callLocal(
  stateDir: string,
  command: unknown,
  timeoutMs = 45000,
): Promise<unknown> {
  const path = await controlSocketPath(stateDir)
  return new Promise((accept, reject) => {
    const socket = createConnection(path)
    let body = ''
    socket.setTimeout(timeoutMs, () =>
      socket.destroy(new Error('ContextMesh local control timed out')),
    )
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      body += String(chunk)
      if (body.length > 8 * 1024 * 1024)
        socket.destroy(new Error('ContextMesh response too large'))
    })
    socket.once('connect', () => socket.end(JSON.stringify(command) + '\n'))
    socket.once('end', () => {
      try {
        accept(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function listenLocal(
  stateDir: string,
  handle: (command: unknown) => Promise<unknown>,
) {
  const sockets = new Set<Socket>(),
    path = await controlSocketPath(stateDir)
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {
      /* Each connection reports its own failure to its caller. */
    })
    let body = '',
      started = false
    socket.setTimeout(45000, () => socket.destroy())
    socket.on('data', (chunk) => {
      body += String(chunk)
      if (body.length > 1024 * 1024) {
        socket.destroy()
        return
      }
      if (!body.includes('\n') || started) return
      started = true
      void (async () => {
        try {
          socket.end(
            JSON.stringify({
              ok: true,
              value: await handle(JSON.parse(body)),
            }) + '\n',
          )
        } catch (error) {
          socket.end(
            JSON.stringify({
              ok: false,
              error: {
                code:
                  error && typeof error === 'object' && 'code' in error
                    ? error.code
                    : 'FAILED',
                message: error instanceof Error ? error.message : String(error),
              },
            }) + '\n',
          )
        }
      })()
    })
  })
  const listen = () =>
    new Promise<void>((accept, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.removeListener('error', reject)
        accept()
      })
    })
  try {
    await listen()
  } catch (error) {
    if (!(
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'EADDRINUSE'
    ))
      throw error
    const live = await new Promise<boolean>((accept, reject) => {
      const socket = createConnection(path)
      socket.setTimeout(1000, () =>
        socket.destroy(new Error('Cannot verify existing control socket')),
      )
      socket.once('connect', () => {
        socket.end()
        accept(true)
      })
      socket.once('error', (error) => {
        if ('code' in error && error.code === 'ECONNREFUSED') accept(false)
        else reject(error)
      })
    })
    if (live)
      throw new Error(
        'Another ContextMesh controller owns this state directory',
      )
    await unlink(path)
    await listen()
  }
  await chmod(path, 0o600)
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      )
    },
  }
}
