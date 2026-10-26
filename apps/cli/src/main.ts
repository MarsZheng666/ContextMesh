import { randomUUID } from 'node:crypto'
import { MeshClient } from '../../../packages/client/src/index.js'
import { MeshError } from '../../../packages/protocol/src/index.js'
const token = process.env.CONTEXTMESH_TOKEN
if (!token) throw new Error('CONTEXTMESH_TOKEN is required')
const client = new MeshClient({
  endpoint: process.env.CONTEXTMESH_ENDPOINT ?? 'http://127.0.0.1:8787',
  token,
})
const [command, id, confirmation] = process.argv.slice(2)
try {
  if (command === 'list')
    console.log(JSON.stringify(await client.list(), null, 2))
  else if (command === 'stat' && id)
    console.log(JSON.stringify(await client.stat(id), null, 2))
  else if (command === 'export' && id) {
    const handle = await client.open(id, 'read')
    try {
      console.log(
        JSON.stringify(
          {
            header: handle.session.header,
            inheritedEventCount: handle.session.inheritedEventCount,
            events: (await client.read(handle, 0, Number.MAX_SAFE_INTEGER))
              .events,
          },
          null,
          2,
        ),
      )
    } finally {
      await client.close(handle, randomUUID())
    }
  } else if (
    command === 'recover' &&
    id &&
    confirmation === '--confirm-stopped'
  ) {
    console.log(
      JSON.stringify(
        await client.request(`/v1/sessions/${encodeURIComponent(id)}/recover`, {
          operationId: randomUUID(),
          confirmStopped: true,
        }),
      ),
    )
  } else if (command === 'operation' && id) {
    console.log(
      JSON.stringify(
        await client.request(`/v1/operations/${encodeURIComponent(id)}`),
        null,
        2,
      ),
    )
  } else {
    console.error(
      'Usage: contextmesh list | stat <id> | export <id> | operation <operationId> | recover <id> --confirm-stopped\nRecover only after confirming the previous process and its tools have stopped.',
    )
    process.exitCode = 1
  }
} catch (error) {
  console.error(
    error instanceof MeshError
      ? JSON.stringify({
          code: error.code,
          message: error.message,
          operationId: error.operationId,
        })
      : String(error),
  )
  process.exitCode = 1
}
