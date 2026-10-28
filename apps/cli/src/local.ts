import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { callLocal } from '../../../packages/handoff-deepseek/src/local-control.js'

const names = new Set([
  'devices',
  'projects',
  'project-add',
  'map',
  'remote-list',
  'handoff',
  'handoff-status',
  'handoff-cancel',
  'resume',
  'history',
  'models',
  'model-select',
  'model-relay-status',
  'takeover',
])
export async function runLocal(input: string[]): Promise<boolean> {
  const args = [...input],
    index = args.indexOf('--state-dir')
  let stateDir =
    process.env.CONTEXTMESH_STATE_DIR ??
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'contextmesh')
  if (index >= 0) {
    if (!args[index + 1]) throw new Error('--state-dir needs a directory')
    stateDir = args[index + 1]!
    args.splice(index, 2)
  }
  const option = (name: string) => {
    const index = args.indexOf(name)
    if (index < 0) return undefined
    const value = args[index + 1]
    if (!value || value.startsWith('--'))
      throw new Error(name + ' requires a value')
    args.splice(index, 2)
    return value
  }
  const provider = option('--provider'),
    chosen = option('--model'),
    reasoningEffort = option('--reasoning-effort'),
    operationId = option('--operation-id')
  const confirm = args.includes('--confirm')
  if (confirm) args.splice(args.indexOf('--confirm'), 1)
  if ((provider && !chosen) || (!provider && chosen))
    throw new Error('--provider and --model must be supplied together')
  const targetModel =
    provider && chosen
      ? {
          provider,
          model: chosen,
          ...(reasoningEffort ? { reasoningEffort } : {}),
        }
      : undefined
  const [name, id, value, modelId] = args
  if (!name || !names.has(name)) return false
  let command: unknown
  switch (name) {
    case 'models':
      command = { action: 'models' }
      break
    case 'model-relay-status':
      if (!id) throw new Error('Usage: model-relay-status <operation-id>')
      command = { action: 'model-relay-status', operationId: id }
      break
    case 'model-select':
      if (!id || !value || !modelId)
        throw new Error(
          'Usage: model-select <session-id> <provider> <model> [--reasoning-effort value] [--operation-id uuid]',
        )
      command = {
        action: 'select-model',
        sessionId: id,
        provider: value,
        model: modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(operationId ? { operationId } : {}),
      }
      break
    case 'takeover':
      if (!id || !confirm)
        throw new Error(
          'Usage: takeover <session-id> --confirm [--provider provider --model model]',
        )
      command = {
        action: 'takeover',
        sessionId: id,
        confirmed: true,
        ...(targetModel ? { targetModel } : {}),
        ...(operationId ? { operationId } : {}),
      }
      break
    case 'devices':
    case 'projects':
    case 'remote-list':
    case 'handoff-status':
      command = { action: 'status' }
      break
    case 'project-add':
      if (!id) throw new Error('Usage: project-add <name>')
      command = { action: 'project', name: id }
      break
    case 'map':
      if (!id || !value)
        throw new Error('Usage: map <project-id> <local-directory>')
      command = { action: 'mapping', projectId: id, root: value }
      break
    case 'handoff':
      if (!id || !value)
        throw new Error('Usage: handoff <session-id> <target-node-id>')
      command = {
        action: 'handoff',
        sessionId: id,
        targetNodeId: value,
        ...(targetModel ? { targetModel } : {}),
      }
      break
    case 'handoff-cancel':
      if (!id) throw new Error('Usage: handoff-cancel <handoff-id>')
      command = { action: 'cancel', handoffId: id }
      break
    case 'resume':
    case 'history':
      if (!id) throw new Error(`Usage: ${name} <session-id>`)
      command = { action: name, sessionId: id }
      break
  }
  const response = z
    .object({
      ok: z.boolean(),
      value: z.unknown().optional(),
      error: z.object({ code: z.string(), message: z.string() }).optional(),
    })
    .parse(await callLocal(stateDir, command))
  if (!response.ok)
    throw new Error(`${response.error?.code}: ${response.error?.message}`)
  let output = response.value
  if (['devices', 'projects', 'remote-list', 'handoff-status'].includes(name)) {
    const snapshot = z
      .object({
        nodes: z.array(z.unknown()),
        projects: z.array(z.unknown()),
        sessions: z.array(z.unknown()),
        handoffs: z.array(z.object({ id: z.string() }).passthrough()),
      })
      .passthrough()
      .parse(output)
    if (name === 'devices') output = snapshot.nodes
    if (name === 'projects') output = snapshot.projects
    if (name === 'remote-list') output = snapshot.sessions
    if (name === 'handoff-status' && id)
      output = snapshot.handoffs.find((record) => record.id === id) ?? null
  }
  console.log(JSON.stringify(output, null, 2))
  return true
}
