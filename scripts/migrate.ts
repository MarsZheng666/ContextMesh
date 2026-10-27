import { PostgresStore } from '../packages/storage-postgres/src/index.js'
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const store = new PostgresStore({ connectionString: process.env.DATABASE_URL })
try {
  await store.init()
  console.log('ContextMesh schema is ready')
} finally {
  await store.stop()
}
