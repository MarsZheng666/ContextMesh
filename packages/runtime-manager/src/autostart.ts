import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
const xml = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
export function autostartTemplate(home: string, platform = process.platform) {
  const command = join(home, 'bin/contextmesh')
  if (platform === 'darwin')
    return {
      name: 'com.contextmesh.dsh.plist',
      content: `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.contextmesh.dsh</string><key>ProgramArguments</key><array><string>${xml(command)}</string><string>runtime-supervise</string><string>${xml(home)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>30</integer><key>StandardErrorPath</key><string>${xml(join(home, 'run/autostart.log'))}</string></dict></plist>`,
    }
  if (platform === 'linux') {
    if (/[\n\r%]/.test(home)) throw new Error('Unsupported service path')
    return {
      name: 'contextmesh-dsh.service',
      content: `[Unit]\nDescription=ContextMesh DSH\nAfter=network-online.target\n[Service]\nType=simple\nExecStart=${JSON.stringify(command)} runtime-supervise ${JSON.stringify(home)}\nRestart=on-failure\nRestartSec=30\nKillMode=process\nTimeoutStopSec=120\n[Install]\nWantedBy=default.target\n`,
    }
  }
  throw new Error('Autostart supports macOS and Linux')
}
export async function installAutostart(home: string) {
  const t = autostartTemplate(home),
    dir =
      process.platform === 'darwin'
        ? join(homedir(), 'Library/LaunchAgents')
        : join(homedir(), '.config/systemd/user')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, t.name), t.content, { flag: 'wx', mode: 0o600 })
  return {
    path: join(dir, t.name),
    next:
      process.platform === 'darwin'
        ? 'Load this agent with launchctl bootstrap after stopping the manually started instance.'
        : 'Run systemctl --user daemon-reload, then systemctl --user enable --now contextmesh-dsh.service after stopping the manual instance.',
  }
}
