import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import type { BridgeOptions } from '../../packages/adapter-codex/src/bridge.js'

export function codexPanel(options: BridgeOptions, runtimeHome: string) {
  const child = spawn(
    process.execPath,
    [resolve('dist/cli.js'), 'codex', 'panel-mcp'],
    {
      env: {
        ...options.native?.env,
        CONTEXTMESH_HOME: runtimeHome,
        CONTEXTMESH_ENDPOINT: options.connection.endpoint,
        CONTEXTMESH_TOKEN: options.connection.token,
        CONTEXTMESH_CODEX_BIN: options.native?.executable,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  )
  const lines = createInterface({ input: child.stdout })
  const replies = lines[Symbol.asyncIterator]()
  let id = 0
  async function request(method: string, params?: unknown) {
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n',
    )
    const next = await replies.next()
    if (next.done) throw new Error('The panel MCP process closed unexpectedly')
    return z
      .object({
        id: z.literal(id),
        result: z.unknown(),
        error: z.unknown().optional(),
      })
      .parse(JSON.parse(next.value)).result
  }
  return {
    request,
    async tool(name: string, args = {}) {
      const response = z
        .object({
          isError: z.boolean().optional(),
          content: z.array(z.object({ text: z.string() })).min(1),
        })
        .parse(
          await request('tools/call', {
            name: 'contextmesh_' + name,
            arguments: args,
          }),
        )
      const text = response.content[0]!.text
      if (response.isError) throw new Error(text)
      return JSON.parse(text)
    },
    close() {
      lines.close()
      child.stdin.end()
    },
  }
}
