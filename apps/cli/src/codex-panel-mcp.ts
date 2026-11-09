import { createInterface } from 'node:readline'
import { z } from 'zod'
import { confirmedAction, type CodexPanelJobs } from './codex-panel-jobs.js'
import { codexPanelHtml } from './codex-panel-view.js'
import { folderPickerAction, panelFolderPicker } from './codex-panel-folder.js'

const uri = 'ui://contextmesh/panel.html'
const resource = {
  uri,
  name: 'ContextMesh',
  mimeType: 'text/html;profile=mcp-app',
}
const empty = z.object({}).strict()
const id = z.object({ id: z.uuid() }).strict()
const openTool = {
  name: 'contextmesh_panel',
  title: 'ContextMesh',
  description: 'Open the ContextMesh sidebar.',
  inputSchema: z.toJSONSchema(empty),
  annotations: { readOnlyHint: true },
  _meta: {
    ui: { resourceUri: uri },
    'openai/ui': { entrypoints: [{ type: 'global' }] },
  },
}

export function codexPanelRequest(jobs: CodexPanelJobs, signal?: AbortSignal) {
  const folderPicker = panelFolderPicker(undefined, signal)
  const actions = {
    folder_picker: {
      schema: folderPickerAction,
      run: folderPicker,
      readOnly: true,
    },
    catalog: { schema: empty, run: () => jobs.catalog(), readOnly: true },
    choices: { schema: empty, run: () => jobs.localChoices(), readOnly: true },
    jobs: { schema: empty, run: () => jobs.list(), readOnly: true },
    start: {
      schema: confirmedAction,
      run: (input: unknown) => jobs.enqueue(confirmedAction.parse(input)),
      readOnly: false,
    },
    open: {
      schema: id,
      run: (input: unknown) => jobs.open(id.parse(input).id),
      readOnly: false,
    },
  }
  const tools = [
    openTool,
    ...Object.entries(actions).map(([name, action]) => ({
      name: 'contextmesh_' + name,
      description: 'ContextMesh sidebar ' + name,
      inputSchema: {
        ...z.toJSONSchema(action.schema, { target: 'draft-7' }),
        type: 'object',
      },
      annotations: {
        readOnlyHint: action.readOnly,
        destructiveHint: name === 'start',
      },
      _meta: { ui: { resourceUri: uri, visibility: ['app'] } },
    })),
  ]
  return async (method: string, raw: unknown) => {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: z.object({ protocolVersion: z.string() }).parse(raw)
            .protocolVersion,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'contextmesh', version: '1.0.0' },
        }
      case 'ping':
        return {}
      case 'tools/list':
        return { tools }
      case 'resources/list':
        return { resources: [resource] }
      case 'resources/templates/list':
        return { resourceTemplates: [] }
      case 'resources/read':
        z.object({ uri: z.literal(uri) }).parse(raw)
        return { contents: [{ ...resource, text: codexPanelHtml }] }
      case 'tools/call': {
        const { name, arguments: args } = z
          .object({ name: z.string(), arguments: z.unknown().optional() })
          .parse(raw)
        if (name === openTool.name)
          return {
            content: [
              {
                type: 'text',
                text: 'Open the ContextMesh sidebar to transfer tasks.',
              },
            ],
          }
        const entry = Object.entries(actions).find(
          ([key]) => name === 'contextmesh_' + key,
        )?.[1]
        if (!entry) throw new Error('Unknown panel tool')
        try {
          const value = await entry.run(entry.schema.parse(args ?? {}))
          return { content: [{ type: 'text', text: JSON.stringify(value) }] }
        } catch (error) {
          const message =
            error instanceof z.ZodError
              ? 'Check the selected task, workspace, model, and confirmation.'
              : error instanceof Error
                ? error.message.slice(0, 500)
                : 'The panel action failed.'
          return { isError: true, content: [{ type: 'text', text: message }] }
        }
      }
      default:
        throw new Error('Unsupported MCP method')
    }
  }
}

export async function serveCodexPanel(jobs: CodexPanelJobs) {
  const lifecycle = new AbortController()
  const request = codexPanelRequest(jobs, lifecycle.signal)
  const lines = createInterface({ input: process.stdin })
  lines.once('close', () => lifecycle.abort())
  for await (const line of lines) {
    let id: string | number | null = null
    try {
      const msg = z
        .object({
          jsonrpc: z.literal('2.0'),
          id: z.union([z.string(), z.number()]).optional(),
          method: z.string(),
          params: z.unknown().optional(),
        })
        .parse(JSON.parse(line))
      if (msg.id === undefined) continue
      id = msg.id
      const result = await request(msg.method, msg.params)
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result }))
    } catch {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32602,
            message: 'Unsupported or invalid panel request',
          },
        }),
      )
    }
  }
}
