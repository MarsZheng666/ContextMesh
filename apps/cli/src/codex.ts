import { codexArchives } from '../../../packages/client/src/codex-context.js'
import { MeshClient } from '../../../packages/client/src/index.js'
import {
  archiveResumeOptions,
  isArchiveId,
} from '../../../packages/protocol/src/archives.js'
import { resolve, join } from 'node:path'
import { z } from 'zod'
import { resolveConnection } from '../../../packages/client/src/config.js'
import { runtimeHome } from '../../../packages/runtime-manager/src/install.js'
import { ConfirmedCodexTakeover } from '../../../packages/adapter-codex/src/takeover.js'
import { installCodexPanel } from './codex-panel-install.js'
import { CodexPanelJobs } from './codex-panel-jobs.js'
import { serveCodexPanel } from './codex-panel-mcp.js'
import { CodexBridge } from '../../../packages/adapter-codex/src/bridge.js'

export async function runCodex(args: string[]) {
  if (args[0] !== 'codex') return false
  const [_, command, id, ...flags] = args
  if (command === 'install-panel') {
    if (
      (id && (id !== '--codex-bin' || flags.length !== 1)) ||
      (!id && flags.length)
    )
      throw new Error(
        'Use contextmesh codex install-panel [--codex-bin <desktop executable>]',
      )
    await installCodexPanel(flags[0])
    console.log(
      'ContextMesh installed. Open Codex and select ContextMesh in the sidebar. Restart the app if the entry does not appear.',
    )
    return true
  }
  if (command === 'archives') {
    if (id || flags.length) throw new Error('Use contextmesh codex archives')
    const { endpoint, token } = await resolveConnection()
    if (!endpoint || !token)
      throw new Error('Connect ContextMesh first with contextmesh setup')
    console.log(
      JSON.stringify(
        await codexArchives(
          new MeshClient({ endpoint, token, adapter: 'codex' }),
        ),
        null,
        2,
      ),
    )
    return true
  }
  if (command === 'panel-mcp' || command === 'panel-worker') {
    if (flags.length || (command === 'panel-mcp' ? id !== undefined : !id))
      throw new Error('Invalid ContextMesh panel command')
    const connection = await resolveConnection()
    const jobs = new CodexPanelJobs({
      connection: {
        endpoint: connection.endpoint ?? 'https://unconfigured.invalid',
        token: connection.token ?? '',
      },
      deviceId: connection.nodeId,
      stateDir: join(runtimeHome(), 'data/codex-bridge'),
      native: {
        executable: process.env.CONTEXTMESH_CODEX_BIN,
        env: { ...process.env, CONTEXTMESH_TOKEN: undefined },
      },
    })
    if (command === 'panel-mcp') await serveCodexPanel(jobs)
    else await jobs.run(id!)
    return true
  }
  if (!command || command === '--help' || command === 'help') {
    console.log(
      'ContextMesh Codex\n  codex install-panel [--codex-bin <desktop executable>]\n  codex takeover <DSH-session-id> --cwd <directory> --model <local-model> --confirm [--workspace-write] [--operation <uuid>]\n  codex takeover-status <handoff-id>\n  codex takeover-recover <handoff-id> --confirm-stopped\n  codex import <source-session-id> --cwd <directory> --model <local-model> [--from deepseek|codex] [--history-query <text>] [--context-window <tokens>] [--workspace-write] [--operation <uuid>]\n  codex run <codex-session-id> --message <new-instruction> [--timeout-seconds <10..3600>]\n  codex status <import-operation-id|codex-session-id>\n  codex reconcile <codex-session-id> --confirm-stopped\nOptions: --state-dir <private-directory>, --codex-home <Codex-directory>, --codex-bin <executable>\nTakeover preflights Codex, then safely stops DSH and continues unfinished work once. --confirm authorizes sending context to the selected provider. Keep this command running until it finishes.\nImport creates a separate Codex conversation from a completed snapshot. It does not stop or take over the source.',
    )
    return true
  }
  if (
    !id ||
    ![
      'import',
      'run',
      'status',
      'reconcile',
      'takeover',
      'takeover-status',
      'takeover-recover',
    ].includes(command)
  )
    throw new Error('Use contextmesh codex --help')
  const values = new Map<string, string>()
  let write = false
  let confirmStopped = false
  let confirm = false
  for (let i = 0; i < flags.length; i++) {
    const name = flags[i]!
    if (name === '--confirm') {
      if (confirm) throw new Error('Repeated option')
      confirm = true
      continue
    }
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
        '--history-query',
        '--context-window',
      ].includes(name) ||
      values.has(name)
    )
      throw new Error('Unknown or repeated Codex option')
    const value = flags[++i]
    if (!value || value.startsWith('--'))
      throw new Error(`${name} requires a value`)
    values.set(name, value)
  }
  if (
    command !== 'import' &&
    (values.has('--history-query') || values.has('--context-window'))
  )
    throw new Error('--history-query and --context-window are only for import')
  const connection = await resolveConnection()
  if (command !== 'status' && (!connection.endpoint || !connection.token))
    throw new Error('Connect ContextMesh first with contextmesh setup')
  const env = { ...process.env }
  if (values.has('--codex-home'))
    env.CODEX_HOME = resolve(values.get('--codex-home')!)
  const options = {
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
  }
  const bridge = new CodexBridge(options)
  if (command !== 'takeover' && confirm)
    throw new Error('--confirm is only for takeover')
  if (
    command !== 'reconcile' &&
    command !== 'takeover-recover' &&
    confirmStopped
  )
    throw new Error('--confirm-stopped is only for reconcile')
  if (command.startsWith('takeover')) {
    const worker = new ConfirmedCodexTakeover({
      ...options,
      deviceId: connection.nodeId,
      progress: (message) => console.error(message),
    })
    if (command === 'takeover') {
      if (!confirm)
        throw new Error(
          'Review the receiver model, provider and directory, then authorize takeover with --confirm',
        )
      if (!values.get('--cwd') || !values.get('--model'))
        throw new Error('Choose the receiving --cwd and --model')
      if (
        confirmStopped ||
        ['--from', '--message', '--timeout-seconds'].some((key) =>
          values.has(key),
        )
      )
        throw new Error('Unsupported takeover option')
      const result = await worker.takeover({
        sourceId: id,
        confirmed: true,
        operationId: values.get('--operation'),
        target: {
          cwd: resolve(values.get('--cwd')!),
          model: values.get('--model')!,
          sandbox: write ? 'workspace-write' : 'read-only',
        },
      })
      console.log(JSON.stringify(result, null, 2))
      if (result.handoff.executionState === 'failed') process.exitCode = 1
    } else {
      if (
        write ||
        [
          '--cwd',
          '--model',
          '--from',
          '--message',
          '--operation',
          '--timeout-seconds',
          '--history-query',
          '--context-window',
        ].some((key) => values.has(key))
      )
        throw new Error('Status and recovery use the saved receiver binding')
      if (command === 'takeover-recover' && !confirmStopped)
        throw new Error(
          'Verify the previous Codex process and tools stopped, then pass --confirm-stopped',
        )
      console.log(
        JSON.stringify(
          command === 'takeover-status'
            ? await worker.status(id)
            : await worker.recover(id, true),
          null,
          2,
        ),
      )
    }
  } else if (command === 'status' || command === 'reconcile') {
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
          '--history-query',
          '--context-window',
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
        .parse(
          values.get('--from') ?? (isArchiveId(id) ? 'codex' : 'deepseek'),
        ),
      operationId: values.get('--operation'),
      ...(values.has('--history-query') || values.has('--context-window')
        ? {
            resume: archiveResumeOptions.parse({
              query: values.get('--history-query'),
              contextWindow: values.has('--context-window')
                ? Number(values.get('--context-window'))
                : undefined,
            }),
          }
        : {}),
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
