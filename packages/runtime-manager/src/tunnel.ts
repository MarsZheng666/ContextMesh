import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
export const tunnelSettings = z.object({
  host: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,250}$/),
  localPort: z.number().int().min(1024).max(65535),
  remotePort: z.number().int().min(1).max(65535),
})
export type TunnelSettings = z.infer<typeof tunnelSettings>
export function tunnelArgs(input: TunnelSettings) {
  const c = tunnelSettings.parse(input)
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=20',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-L',
    `127.0.0.1:${c.localPort}:127.0.0.1:${c.remotePort}`,
    c.host,
  ]
}
export function tunnelFailure(text: string) {
  if (/Permission denied|Authentication failed/i.test(text))
    return 'SSH_AUTH_REQUIRED'
  if (/host key|REMOTE HOST IDENTIFICATION/i.test(text)) return 'SSH_HOST_KEY'
  if (/Address already in use|cannot listen|forwarding failed/i.test(text))
    return 'PORT_IN_USE'
  return 'SSH_DISCONNECTED'
}
export class Tunnel {
  private child?: ChildProcess
  private controller = new AbortController()
  private loop?: Promise<void>
  state: { status: string; attempt: number; code?: string } = {
    status: 'stopped',
    attempt: 0,
  }
  constructor(
    private readonly config: TunnelSettings,
    private readonly launch: typeof spawn = spawn,
  ) {}
  start() {
    if (this.loop) return
    this.loop = this.run()
  }
  private async run() {
    for (
      let attempt = 0;
      attempt < 8 && !this.controller.signal.aborted;
      attempt++
    ) {
      this.state = { status: 'connecting', attempt: attempt + 1 }
      let stderr = ''
      this.child = this.launch('ssh', tunnelArgs(this.config), {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      this.child.stderr?.on('data', (b) => {
        stderr = (stderr + b.toString()).slice(-4096)
      })
      this.child.once('spawn', () => {
        this.state = { status: 'running', attempt: attempt + 1 }
      })
      this.child.once('error', () => {
        stderr += ' SSH executable unavailable'
      })
      await new Promise<void>((resolve) =>
        this.child!.once('close', () => resolve()),
      )
      if (this.controller.signal.aborted) break
      const code = tunnelFailure(stderr)
      this.state = { status: 'disconnected', attempt: attempt + 1, code }
      if (['SSH_AUTH_REQUIRED', 'SSH_HOST_KEY', 'PORT_IN_USE'].includes(code))
        break
      await delay(
        Math.min(30000, 500 * 2 ** attempt) + Math.floor(Math.random() * 200),
        undefined,
        { signal: this.controller.signal },
      ).catch(() => {})
    }
    if (this.controller.signal.aborted)
      this.state = { status: 'stopped', attempt: 0 }
    else this.state = { ...this.state, status: 'attention' }
  }
  async stop() {
    this.controller.abort()
    this.child?.kill('SIGTERM')
    await this.loop
  }
}
