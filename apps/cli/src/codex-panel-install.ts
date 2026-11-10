import { findDesktopCodex } from './codex-executable.js'
import { powershellCommand } from '../../../packages/platform/src/windows.js'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  atomicJson,
  optionalJson,
} from '../../../packages/runtime-manager/src/files.js'
import { runtimeHome } from '../../../packages/runtime-manager/src/install.js'
import { runtimeSettings } from '../../../packages/runtime-manager/src/supervisor.js'

const execute = promisify(execFile)
export async function installCodexPanel(explicitBin?: string) {
  if (!['darwin', 'win32'].includes(process.platform))
    throw new Error(
      'The ContextMesh desktop panel is available on macOS and Windows',
    )
  const windows = process.platform === 'win32'
  const bin = await findDesktopCodex(explicitBin)
  const home = resolve(runtimeHome())
  const launcher = windows
    ? join(home, 'bootstrap/node.exe')
    : join(home, 'bin/contextmesh')
  const launchArgs = windows ? [join(home, 'bootstrap/launch.mjs')] : []
  await access(launcher, constants.X_OK).catch(() => {
    throw new Error(
      'Install the ContextMesh runtime before enabling the Codex panel',
    )
  })
  const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), '.codex'))
  const settings = runtimeSettings.parse(
    (await optionalJson(join(home, 'settings.json'))) ?? { cwd: process.cwd() },
  )
  const market = join(home, 'data', 'codex-panel')
  const plugin = join(market, 'plugins', 'contextmesh')
  const pluginId = 'contextmesh@contextmesh-local'
  await atomicJson(join(plugin, '.codex-plugin/plugin.json'), {
    name: 'contextmesh',
    version: '1.0.0',
    description:
      'Transfer tasks between Codex and other devices with ContextMesh.',
    mcpServers: './.mcp.json',
    interface: { displayName: 'ContextMesh' },
  })
  await atomicJson(join(plugin, '.mcp.json'), {
    mcpServers: {
      contextmesh: {
        command: launcher,
        args: [...launchArgs, 'codex', 'panel-mcp'],
        env: {
          CODEX_HOME: codexHome,
          CONTEXTMESH_CODEX_BIN: bin,
          ...(process.env.CONTEXTMESH_CONFIG
            ? { CONTEXTMESH_CONFIG: resolve(process.env.CONTEXTMESH_CONFIG) }
            : {}),
          ...(settings.caFile ? { NODE_EXTRA_CA_CERTS: settings.caFile } : {}),
        },
      },
    },
  })
  const psQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'"
  const windowsHook = powershellCommand(
    [
      ...Object.entries({
        CONTEXTMESH_HOME: home,
        CODEX_HOME: codexHome,
        CONTEXTMESH_CODEX_BIN: bin,
        ...(process.env.CONTEXTMESH_CONFIG
          ? { CONTEXTMESH_CONFIG: resolve(process.env.CONTEXTMESH_CONFIG) }
          : {}),
        ...(settings.caFile ? { NODE_EXTRA_CA_CERTS: settings.caFile } : {}),
      }).map(([key, value]) => '$env:' + key + '=' + psQuote(value)),
      '$reader = [System.IO.StreamReader]::new([Console]::OpenStandardInput(), [System.Text.UTF8Encoding]::new($false))',
      '$payload = $reader.ReadToEnd()',
      '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
      '$payload | & ' +
        [launcher, ...launchArgs, 'codex', 'sync-hook'].map(psQuote).join(' '),
      'exit $LASTEXITCODE',
    ].join('\n'),
  )
  // Encoded content contains paths as PowerShell literals, not shell fragments.
  const windowsHookCommand =
    '"' + windowsHook.executable + '" ' + windowsHook.args.join(' ')
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const hookCommand = [
    'env',
    'CONTEXTMESH_HOME=' + quote(home),
    'CODEX_HOME=' + quote(codexHome),
    'CONTEXTMESH_CODEX_BIN=' + quote(bin),
    ...(process.env.CONTEXTMESH_CONFIG
      ? ['CONTEXTMESH_CONFIG=' + quote(resolve(process.env.CONTEXTMESH_CONFIG))]
      : []),
    ...(settings.caFile
      ? ['NODE_EXTRA_CA_CERTS=' + quote(settings.caFile)]
      : []),
    quote(launcher),
    'codex',
    'sync-hook',
  ].join(' ')
  await atomicJson(join(plugin, 'hooks/hooks.json'), {
    description:
      'Keep conversations explicitly shared with ContextMesh up to date.',
    hooks: Object.fromEntries(
      [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PostToolUse',
        'Stop',
        'Interrupt',
      ].map((event) => [
        event,
        [
          {
            hooks: [
              {
                type: 'command',
                command: windows ? windowsHookCommand : hookCommand,
                ...(windows ? { commandWindows: windowsHookCommand } : {}),
                timeout: event === 'Interrupt' ? 3 : 10,
              },
            ],
          },
        ],
      ]),
    ),
  })
  await atomicJson(join(market, '.agents/plugins/marketplace.json'), {
    name: 'contextmesh-local',
    interface: { displayName: 'ContextMesh' },
    plugins: [
      {
        name: 'contextmesh',
        source: { source: 'local', path: './plugins/contextmesh' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      },
    ],
  })
  const run = async (args: string[]) =>
    execute(bin, ['plugin', ...args, '--json'], {
      env: { ...process.env, CODEX_HOME: codexHome },
      timeout: 30000,
      windowsHide: true,
    }).catch(() => {
      throw new Error(
        'Codex could not register the ContextMesh panel. Check that the desktop app is up to date and local plugins are allowed.',
      )
    })
  await run(['marketplace', 'add', market])
  await run(['add', pluginId])
}
