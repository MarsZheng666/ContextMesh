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
const desktopCodex =
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'

export async function installCodexPanel(explicitBin?: string) {
  if (process.platform !== 'darwin')
    throw new Error('The ContextMesh desktop panel is available on macOS')
  const bin = resolve(explicitBin ?? desktopCodex)
  await access(bin, constants.X_OK).catch(() => {
    throw new Error(
      'Install the Codex desktop app or use --codex-bin with its bundled Codex executable',
    )
  })
  const home = resolve(runtimeHome())
  const launcher = join(home, 'bin/contextmesh')
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
        args: ['codex', 'panel-mcp'],
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
    }).catch(() => {
      throw new Error(
        'Codex could not register the ContextMesh panel. Check that the desktop app is up to date and local plugins are allowed.',
      )
    })
  await run(['marketplace', 'add', market])
  await run(['add', pluginId])
}
