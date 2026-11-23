import { join } from 'node:path'
import {
  atomicJson,
  optionalJson,
} from '../../../packages/runtime-manager/src/files.js'
import { SharedClient } from '../../../packages/client/src/shared.js'
import { AntigravityLive, dataRoot, hostSchema } from './live.js'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { resolveConnection } from '../../../packages/client/src/config.js'
import { MeshClient } from '../../../packages/client/src/index.js'
import { archiveIdSchema } from '../../../packages/protocol/src/archives.js'
import { AntigravityArchives } from './actions.js'

const uri = 'ui://contextmesh/antigravity.html'
const resource = {
  uri,
  name: 'ContextMesh',
  mimeType: 'text/html;profile=mcp-app',
}
const localSelection = z
  .object({
    host: hostSchema,
    thread: z.uuid(),
    title: z.string().trim().min(1).max(160),
  })
  .strict()
const schemas = {
  snapshot_thread: localSelection,
  shared_content: z
    .object({
      id: z.uuid(),
      seq: z.int().nonnegative(),
      offset: z.int().nonnegative(),
    })
    .strict(),
  live_status: z.object({ id: z.uuid().optional() }).strict(),
  local_threads: z.object({}).strict(),
  share_thread: localSelection,
  follow: z.object({ id: z.uuid() }).strict(),
  takeover: z.object({ id: z.uuid() }).strict(),
  open_panel: z.object({}).strict(),
  list_archives: z.object({ after: archiveIdSchema.optional() }).strict(),
  preview_archive: z
    .object({ id: archiveIdSchema, query: z.string().max(2000) })
    .strict(),
  publish_note: z
    .object({
      id: z.uuid(),
      title: z.string().trim().min(1).max(160),
      note: z
        .string()
        .min(1)
        .refine((s) => !!s.trim()),
    })
    .strict(),
}
const descriptions = {
  shared_content: 'Read a portion of the selected shared record.',
  snapshot_thread:
    'Publish the saved conversation and recorded tool activity as a single archive.',
  live_status: 'Show shared conversations and recent followed records.',
  local_threads: 'List native conversations on this device.',
  share_thread: 'Start sharing the selected conversation and tool history.',
  follow: 'Follow changes on this device.',
  takeover: 'Prepare a confirmed transfer to a new native conversation.',
  open_panel: 'Open the ContextMesh task transfer panel.',
  list_archives: 'List the next page of shared task archives.',
  preview_archive: 'Read selected context from a shared task archive.',
  publish_note: 'Save the handoff note reviewed in this panel.',
}
let live: AntigravityLive | undefined
let interval: ReturnType<typeof setInterval> | undefined
async function coordinator() {
  if (live) return live
  const conn = await resolveConnection()
  if (!conn.endpoint || !conn.token)
    throw Error('Configure this device’s connection file.')
  const service = new AntigravityLive(
    new SharedClient(
      new MeshClient({
        endpoint: conn.endpoint,
        token: conn.token,
        adapter: 'antigravity',
      }),
    ),
  )
  await atomicJson(join(dataRoot(), 'connection-path.json'), {
    path: conn.path,
  })
  let ticking = false
  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      await service.tick()
    } catch {
    } finally {
      ticking = false
    }
  }
  interval = setInterval(() => void tick(), 1500)
  interval.unref()
  live = service
  void tick()
  return service
}
async function handle(method: string, params: unknown) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: z.object({ protocolVersion: z.string() }).parse(params)
          .protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'contextmesh', version: '0.1.0' },
      }
    case 'ping':
      return {}
    case 'resources/list':
      return { resources: [resource] }
    case 'resources/templates/list':
      return { resourceTemplates: [] }
    case 'resources/read':
      z.object({ uri: z.literal(uri) }).parse(params)
      return {
        contents: [
          {
            ...resource,
            text: await readFile(
              new URL('./panel.html', import.meta.url),
              'utf8',
            ),
          },
        ],
      }
    case 'tools/list':
      return {
        tools: Object.entries(schemas).map(([key, schema]) => ({
          name: key,
          description: descriptions[key as keyof typeof schemas],
          inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }),
          annotations: {
            readOnlyHint: [
              'open_panel',
              'list_archives',
              'preview_archive',
              'live_status',
              'shared_content',
              'local_threads',
            ].includes(key),
          },
          _meta: {
            ui: {
              resourceUri: uri,
              visibility: key === 'open_panel' ? ['model', 'app'] : ['app'],
            },
            ...(key === 'open_panel'
              ? {
                  'com.google.antigravity/ui': {
                    entrypoints: [
                      { type: 'aux_pane', title: 'ContextMesh' },
                      { type: 'global', title: 'ContextMesh' },
                    ],
                  },
                }
              : {}),
          },
        })),
      }
    case 'tools/call': {
      const call = z
        .object({
          name: z.enum(
            Object.keys(schemas) as [
              keyof typeof schemas,
              ...(keyof typeof schemas)[],
            ],
          ),
          arguments: z.unknown().optional(),
        })
        .parse(params)
      try {
        const args = call.arguments ?? {}
        if (call.name === 'open_panel')
          return {
            content: [
              {
                type: 'text',
                text: 'Open ContextMesh to receive or publish a task.',
              },
            ],
          }
        const sync = await coordinator()
        const conn = await resolveConnection()
        if (!conn.endpoint || !conn.token)
          throw new Error(
            'Configure the path to your paired ContextMesh connection file.',
          )
        const service = new AntigravityArchives(
          new MeshClient({
            endpoint: conn.endpoint,
            token: conn.token,
            adapter: 'antigravity',
          }),
        )
        let value
        if (call.name === 'live_status') {
          const { id } = schemas.live_status.parse(args)
          const following = await sync.followers.list()
          const followed = following.find((f) => f.share.id === id)
          const shares = await sync.client.list()
          const selected = shares.find((s) => s.id === id)
          const issue =
            selected?.transfer && selected.transfer.phase !== 'claimed'
              ? z
                  .object({ message: z.string() })
                  .optional()
                  .parse(
                    await optionalJson(
                      join(
                        dataRoot(),
                        'issues',
                        selected.transfer.id + '.json',
                      ),
                    ),
                  )
              : undefined
          value = {
            shares,
            following: following.map((f) => f.share.id),
            records: followed?.records.slice(-40),
            error:
              issue?.message ||
              (selected && sync.sourceErrors.get(selected.source.id)) ||
              followed?.error,
          }
        } else if (call.name === 'shared_content') {
          const a = schemas.shared_content.parse(args)
          value = await sync.client.text(a.id, a.seq, a.offset, 16384)
        } else if (call.name === 'local_threads') value = await sync.local()
        else if (call.name === 'snapshot_thread') {
          const a = localSelection.parse(args)
          value = await sync.snapshot(a.host, a.thread, a.title)
        } else if (call.name === 'share_thread') {
          const a = schemas.share_thread.parse(args)
          value = await sync.share(a.host, a.thread, a.title)
        } else if (call.name === 'follow') {
          const f = await sync.followers.follow(schemas.follow.parse(args).id)
          value = { id: f.share.id }
        } else if (call.name === 'takeover')
          value = await sync.ticket(schemas.takeover.parse(args).id)
        else if (call.name === 'list_archives')
          value = await service.list(schemas.list_archives.parse(args).after)
        else if (call.name === 'preview_archive') {
          const { id, query } = schemas.preview_archive.parse(args)
          value = await service.preview(id, query)
        } else {
          const { id, title, note } = schemas.publish_note.parse(args)
          value = await service.publish(id, title, note)
        }
        return { content: [{ type: 'text', text: JSON.stringify(value) }] }
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text:
                error instanceof z.ZodError
                  ? 'Invalid task details.'
                  : error instanceof Error
                    ? error.message
                    : 'Request failed.',
            },
          ],
        }
      }
    }
    default:
      throw new Error('Unsupported MCP method')
  }
}
await coordinator().catch(() => {})
for await (const line of createInterface({ input: process.stdin })) {
  let id: number | string | null = null
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
    console.log(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: await handle(msg.method, msg.params),
      }),
    )
  } catch {
    console.log(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid MCP request' },
      }),
    )
  }
}

if (interval) clearInterval(interval)
