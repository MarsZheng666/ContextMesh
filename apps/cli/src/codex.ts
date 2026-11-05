import { resolve, join } from 'node:path'
import { z } from 'zod'
import { resolveConnection } from '../../../packages/client/src/config.js'
import { runtimeHome } from '../../../packages/runtime-manager/src/install.js'
import { CodexBridge } from '../../../packages/adapter-codex/src/bridge.js'

export async function runCodex(args: string[]) {
  if (args[0] !== 'codex') return false
  const [_, command, id, ...flags] = args
  if (!command || command === '--help' || command === 'help') {
    console.log(
      'ContextMesh Codex\n  codex import <source-session-id> --cwd <directory> --model <local-model> [--from deepseek|codex] [--workspace-write] [--operation <uuid>]\n  codex run <codex-session-id> --message <new-instruction> [--timeout-seconds <10..3600>]\n  codex status <import-operation-id|codex-session-id>\n  codex reconcile <codex-session-id> --confirm-stopped\nOptions: --state-dir <private-directory>, --codex-home <Codex-directory>, --codex-bin <executable>\nImport creates a separate Codex conversation from a completed snapshot. It does not stop or take over the source.',
    )
    return true
  }
  if (!id || !['import', 'run', 'status', 'reconcile'].includes(command))
    throw new Error('Use contextmesh codex --help')
  const values = new Map<string, string>()
  let write = false
  let confirmStopped = false
  for (let i = 0; i < flags.length; i++) {
    const name = flags[i]!
    if (name === '--confirm-stopped') {
      if (confirmStopped) throw new Error('Repeated option')
      confirmStopped = true
      continue
    }
    if (name === '--workspace-write') {
      if (write) throw new Error('Repeated option')
      write = true
      continue
    }
    if (
      ![
        '--cwd',
        '--model',
        '--from',
        '--operation',
        '--message',
        '--state-dir',
        '--codex-home',
        '--codex-bin',
        '--timeout-seconds',
      ].includes(name) ||
      values.has(name)
    )
      throw new Error('Unknown or repeated Codex option')
    const value = flags[++i]
    if (!value || value.startsWith('--'))
      throw new Error(`${name} requires a value`)
    values.set(name, value)
  }
  const connection = await resolveConnection()
  if (command !== 'status' && (!connection.endpoint || !connection.token))
    throw new Error('Connect ContextMesh first with contextmesh setup')
  const env = { ...process.env }
  if (values.has('--codex-home'))
    env.CODEX_HOME = resolve(values.get('--codex-home')!)
  const bridge = new CodexBridge({
    connection: {
      endpoint: connection.endpoint ?? 'https://unconfigured.invalid',
      token: connection.token ?? '',
    },
    stateDir: resolve(
      values.get('--state-dir') ?? join(runtimeHome(), 'data/codex-bridge'),
    ),
    native: {
      executable:
        values.get('--codex-bin') ?? process.env.CONTEXTMESH_CODEX_BIN,
      env,
    },
  })
  if (command !== 'reconcile' && confirmStopped)
    throw new Error('--confirm-stopped is only for reconcile')
  if (command === 'status' || command === 'reconcile') {
    if (
      write ||
      [...values.keys()].some((k) =>
        [
          '--cwd',
          '--model',
          '--from',
          '--operation',
          '--message',
          '--timeout-seconds',
        ].includes(k),
      )
    )
      throw new Error('Status and recovery use the saved local binding')
    if (command === 'reconcile' && !confirmStopped)
      throw new Error(
        'Confirm the previous Codex process and its tools stopped with --confirm-stopped',
      )
    console.log(
      JSON.stringify(
        command === 'status'
          ? await bridge.status(id)
          : await bridge.reconcile(id, true),
        null,
        2,
      ),
    )
  } else if (command === 'import') {
    if (values.has('--timeout-seconds'))
      throw new Error('--timeout-seconds is only for run')
    if (values.has('--message'))
      throw new Error('Import starts no turn; use codex run afterwards')
    if (!values.get('--cwd') || !values.get('--model'))
      throw new Error('Choose the local --cwd and --model before importing')
    const result = await bridge.import({
      sourceId: id,
      sourceAdapter: z
        .enum(['deepseek', 'codex'])
        .parse(values.get('--from') ?? 'deepseek'),
      operationId: values.get('--operation'),
      target: {
        cwd: resolve(values.get('--cwd')!),
        model: values.get('--model')!,
        sandbox: write ? 'workspace-write' : 'read-only',
      },
    })
    console.log(JSON.stringify(result, null, 2))
  } else {
    if (
      write ||
      [...values.keys()].some((k) =>
        ['--cwd', '--model', '--from', '--operation'].includes(k),
      )
    )
      throw new Error(
        'Run uses the local model, directory and permissions selected during import',
      )
    const timeout = z.coerce
      .number()
      .int()
      .min(10)
      .max(3600)
      .parse(values.get('--timeout-seconds') ?? 1800)
    const result = await bridge.run(
      id,
      values.get('--message') ?? '',
      timeout * 1000,
    )
    console.log(JSON.stringify(result, null, 2))
    if (result.status !== 'completed') process.exitCode = 1
  }
  return true
}
