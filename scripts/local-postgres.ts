import EmbeddedPostgres from 'embedded-postgres'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
const db = new EmbeddedPostgres({
  databaseDir: resolve('.contextmesh/postgres'),
  port: 55432,
  user: 'contextmesh',
  password: 'contextmesh-local',
  persistent: true,
  createPostgresUser: false,
  postgresFlags: ['-h', '127.0.0.1'],
})
try {
  await access(resolve('.contextmesh/postgres/PG_VERSION'))
} catch {
  await db.initialise()
}
await db.start()
const client = db.getPgClient()
await client.connect()
try {
  if (
    !(
      await client.query(
        "SELECT 1 FROM pg_database WHERE datname='contextmesh'",
      )
    ).rowCount
  )
    await client.query('CREATE DATABASE contextmesh')
} finally {
  await client.end()
}
console.log(
  'Local development PostgreSQL ready on 127.0.0.1:55432; press Ctrl-C to stop.',
)
let stopping = false
const stop = async () => {
  if (stopping) return
  stopping = true
  await db.stop()
}
process.on('SIGINT', () => {
  void stop()
})
process.on('SIGTERM', () => {
  void stop()
})
