import { setup } from './setup.js'
import { readConnection } from '../../../packages/client/src/config.js'
import { randomUUID } from 'node:crypto'
import { MeshClient } from '../../../packages/client/src/index.js'
import { MeshError } from '../../../packages/protocol/src/index.js'
import { runLocal } from './local.js'
const input = process.argv.slice(2)
const handled = await (async () =>
  (await setup(input)) || (await runLocal(input)))().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
  return true
})
if (!handled) {
  const saved = process.env.CONTEXTMESH_TOKEN
    ? undefined
    : await readConnection()
  const token = process.env.CONTEXTMESH_TOKEN ?? saved?.token
  if (!token) throw new Error('CONTEXTMESH_TOKEN is required')
  const client = new MeshClient({
    endpoint:
      process.env.CONTEXTMESH_ENDPOINT ??
      saved?.endpoint ??
      'http://127.0.0.1:8787',
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
          await client.request(
            `/v1/sessions/${encodeURIComponent(id)}/recover`,
            {
              operationId: randomUUID(),
              confirmStopped: true,
            },
          ),
        ),
      )
    } else if (
      command === 'handoff-recover' &&
      id &&
      confirmation === '--confirm-stopped'
    ) {
      const record = await client.request(
        `/v1/handoffs/${encodeURIComponent(id)}`,
      )
      if (
        !record ||
        typeof record !== 'object' ||
        !('revision' in record) ||
        typeof record.revision !== 'number'
      )
        throw new Error('invalid handoff state')
      console.log(
        JSON.stringify(
          await client.request(
            `/v1/handoffs/${encodeURIComponent(id)}/recover`,
            {
              operationId: randomUUID(),
              revision: record.revision,
              confirmStopped: true,
            },
          ),
          null,
          2,
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
        'Usage: contextmesh devices | projects | project-add <name> | map <project-id> <root> | remote-list | handoff <session-id> <target-node-id> | handoff-status [id] | handoff-cancel <id> | resume <session-id> | history <session-id> [--state-dir <dir>]\nRemote: list | stat <id> | export <id> | operation <operationId> | recover <id> --confirm-stopped\nRecover only after confirming the previous process and its tools have stopped.',
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
}
