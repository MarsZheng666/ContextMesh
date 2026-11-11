import { createConnection, createServer, type Socket } from 'node:net'
import {
  randomBytes,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { readFile, writeFile, link, unlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { privateDirectory } from '../../runtime-manager/src/files.js'
import { windowsPrivatePath } from './windows.js'

const keys = new Map<string, { identity: string; key: string }>()
async function capability(directory: string) {
  await privateDirectory(directory)
  const path = join(directory, 'control-key')
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const temp = path + '.' + randomUUID()
    try {
      await writeFile(temp, randomBytes(32).toString('hex'), {
        flag: 'wx',
        mode: 0o600,
      })
      await link(temp, path).catch((error) => {
        if (error.code !== 'EEXIST') throw error
      })
    } finally {
      await unlink(temp).catch(() => {})
    }
  }
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error('Invalid local control key')
  const identity = [
    info.dev,
    info.ino,
    info.birthtimeMs,
    info.mtimeMs,
    info.size,
  ].join(':')
  const known = keys.get(path)
  if (known?.identity === identity) return known.key
  await windowsPrivatePath(path)
  const key = await readFile(path, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local control key')
  keys.set(path, { identity, key })
  return key
}
const mac = (key: string, text: string) =>
  createHmac('sha256', key).update(text).digest('hex')
function matches(actual: unknown, expected: string) {
  return (
    typeof actual === 'string' &&
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  )
}

/** Windows pipe defaults are not a user-only ACL. Authenticate both ends and
 * every command without ever sending the on-disk capability over the pipe. */
export async function callWindowsLocal(
  directory: string,
  path: string,
  command: unknown,
  timeout: number,
) {
  const key = await capability(directory)
  return new Promise<unknown>((accept, reject) => {
    const socket = createConnection(path)
    socket.setEncoding('utf8')
    let body = '',
      authenticated = false
    socket.setTimeout(timeout, () =>
      socket.destroy(new Error('ContextMesh local control timed out')),
    )
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      body += chunk
      if (body.length > 8 * 1024 * 1024)
        return socket.destroy(new Error('ContextMesh response too large'))
      if (authenticated || !body.includes('\n')) return
      try {
        const at = body.indexOf('\n'),
          challenge = JSON.parse(body.slice(0, at))
        body = body.slice(at + 1)
        if (
          typeof challenge.nonce !== 'string' ||
          !/^[a-f0-9]{64}$/.test(challenge.nonce) ||
          !matches(challenge.proof, mac(key, 'server:' + challenge.nonce))
        )
          throw new Error('Local controller authentication failed')
        const payload = JSON.stringify(command)
        authenticated = true
        // Named pipes cannot reliably half-close while an asynchronous
        // handler is still working. The newline frames the request.
        socket.write(
          JSON.stringify({
            payload,
            proof: mac(key, 'client:' + challenge.nonce + ':' + payload),
          }) + '\n',
        )
      } catch (error) {
        socket.destroy(error as Error)
      }
    })
    socket.once('end', () => {
      try {
        if (!authenticated)
          throw new Error('Local controller did not authenticate')
        accept(JSON.parse(body))
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function listenWindowsLocal(
  directory: string,
  path: string,
  handle: (command: unknown) => Promise<unknown>,
) {
  const key = await capability(directory),
    sockets = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    const nonce = randomBytes(32).toString('hex')
    socket.write(
      JSON.stringify({ nonce, proof: mac(key, 'server:' + nonce) }) + '\n',
    )
    let body = '',
      started = false
    socket.setTimeout(45000, () => socket.destroy())
    socket.on('data', (chunk: string) => {
      if (started) return
      body += chunk
      if (body.length > 1024 * 1024) {
        socket.destroy()
        return
      }
      if (!body.includes('\n')) return
      started = true
      void (async () => {
        try {
          const request = JSON.parse(body)
          if (
            typeof request.payload !== 'string' ||
            !matches(
              request.proof,
              mac(key, 'client:' + nonce + ':' + request.payload),
            )
          ) {
            socket.destroy()
            return
          }
          socket.end(
            JSON.stringify({
              ok: true,
              value: await handle(JSON.parse(request.payload)),
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
    socket.once('end', () => {
      if (!started) socket.destroy()
    })
  })
  await new Promise<void>((accept, reject) => {
    server.once('error', reject)
    server.listen(path, () => {
      server.off('error', reject)
      accept()
    })
  }).catch((error) => {
    if (['EADDRINUSE', 'EACCES'].includes(error.code))
      throw new Error(
        'Another ContextMesh controller owns this state directory',
      )
    throw error
  })
  return {
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      )
    },
  }
}
