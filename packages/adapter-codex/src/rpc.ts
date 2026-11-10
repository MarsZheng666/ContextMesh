import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { z } from 'zod'

export interface CodexOptions {
  executable?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}
export class CodexRpc extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams
  private counter = 0
  private buffer = ''
  private dead = false
  private readonly pending = new Map<
    number,
    {
      resolve(v: unknown): void
      reject(e: Error): void
      timer: NodeJS.Timeout
      method: string
    }
  >()
  constructor(readonly options: CodexOptions = {}) {
    super()
    this.child = spawn(
      options.executable ??
        (process.platform === 'win32' ? 'codex.exe' : 'codex'),
      [...(options.args ?? []), 'app-server'],
      { windowsHide: true, env: options.env ?? process.env, stdio: 'pipe' },
    )
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.resume()
    this.child.on('error', () =>
      this.fail(
        new Error(
          'Unable to start Codex CLI; install the supported CLI and check its executable path',
        ),
      ),
    )
    this.child.on('exit', () =>
      this.fail(
        new Error(
          'Codex connection closed; an interrupted operation may need review',
        ),
      ),
    )
    this.child.stdin.on('error', () =>
      this.fail(new Error('Codex input connection closed')),
    )
    this.child.stdout.on('data', (part: string) => {
      this.buffer += part
      if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024)
        return this.fail(new Error('Codex response exceeds the protocol limit'))
      let at: number
      while ((at = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + 1)
        if (!line.trim()) continue
        try {
          this.receive(JSON.parse(line))
        } catch {
          this.fail(new Error('Codex returned an invalid protocol message'))
        }
      }
    })
  }
  private receive(value: unknown) {
    const v = z
      .object({
        id: z.union([z.number(), z.string()]).optional(),
        method: z.string().optional(),
        params: z.unknown().optional(),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      })
      .parse(value)
    if (v.method) {
      if (v.id !== undefined) {
        // This CLI has no interactive approval surface. Never approve on the user's behalf.
        if (
          v.method === 'item/commandExecution/requestApproval' ||
          v.method === 'item/fileChange/requestApproval'
        )
          this.write({ id: v.id, result: { decision: 'decline' } })
        else
          this.write({
            id: v.id,
            error: { code: -32601, message: 'Unsupported interactive request' },
          })
      } else this.emit('notification', v.method, v.params)
      return
    }
    if (typeof v.id !== 'number') return
    const pending = this.pending.get(v.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(v.id)
    if (v.error !== undefined)
      pending.reject(
        new Error(
          `Codex ${pending.method} was rejected; check its local configuration and supported CLI version`,
        ),
      )
    else pending.resolve(v.result)
  }
  private write(value: unknown) {
    if (this.dead) throw new Error('Codex connection is closed')
    this.child.stdin.write(JSON.stringify(value) + '\n')
  }
  private fail(error: Error) {
    if (this.dead) return
    this.dead = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(error)
    }
    this.pending.clear()
    this.emit('disconnected', error)
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (this.dead)
      return Promise.reject(new Error('Codex connection is closed'))
    const id = ++this.counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(
          new Error(
            `Codex ${method} timed out; do not retry an uncertain mutation`,
          ),
        )
      }, this.options.timeoutMs ?? 30000)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.write({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'contextmesh', version: '0.8.0-dev.16' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    })
    this.write({ method: 'initialized' })
  }
  async close() {
    this.fail(new Error('Codex connection closed'))
    if (this.child.exitCode !== null) return
    this.child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.child.kill('SIGTERM'), 500)
      const last = setTimeout(() => {
        this.child.kill('SIGKILL')
        resolve()
      }, 5000)
      this.child.once('exit', () => {
        clearTimeout(timer)
        clearTimeout(last)
        resolve()
      })
    })
  }
}
