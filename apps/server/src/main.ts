import { buildServer } from './app.js'
import { PostgresStore } from '../../../packages/storage-postgres/src/index.js'

const connectionString = process.env.DATABASE_URL
const token = process.env.CONTEXTMESH_TOKEN
if (!connectionString || !token)
  throw new Error('DATABASE_URL and CONTEXTMESH_TOKEN are required')
const store = new PostgresStore({ connectionString })
await store.init()
const app = buildServer({
  store,
  token,
  namespace: process.env.CONTEXTMESH_NAMESPACE,
  logger: true,
})
app.addHook('onClose', async () => store.stop())
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    void app.close().catch(() => {
      process.exitCode = 1
    })
  })
try {
  await app.listen({
    host: process.env.CONTEXTMESH_HOST ?? '127.0.0.1',
    port: Number(process.env.CONTEXTMESH_PORT ?? 8787),
  })
} catch (error) {
  await app.close()
  throw error
}
