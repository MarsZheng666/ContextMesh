import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
const plugin = await import(
  pathToFileURL(resolve('packages/adapter-deepseek/dist/index.js')).href
)
const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(plugin, {
  endpoint: process.env.CONTEXTMESH_ENDPOINT,
  token: process.env.CONTEXTMESH_TOKEN,
})
const id = SessionId(process.env.TEST_SESSION_ID!)
try {
  if (process.argv[2] === 'write') {
    const session = ctx.sessions.create(id, { meta: { cwd: process.cwd() } })
    const handle = await ctx.sessionPersistence.create(session.header)
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    await handle.close()
    console.log(JSON.stringify({ written: 2 }))
  } else {
    const handle = await ctx.sessionPersistence.open(id, 'write')
    const seed = await handle.read()
    const session = Session.fromRestore(
      id,
      seed.events,
      handle.header,
      handle.inheritedEventCount,
      seed.eventState,
    )
    // Match agent-loop: constructor-produced resume records precede live publication.
    await handle.append(
      session.snapshotEvents(SessionLogOffset(seed.events.length)),
    )
    const leave = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    session.append('turn/start', { turn: 2 })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    const events = (await handle.read()).events
    await handle.close()
    leave()
    console.log(
      JSON.stringify({
        restored: seed.events.length,
        total: events.length,
        seqs: events.map((e) => e.seq),
      }),
    )
  }
} finally {
  await ctx.fiber.dispose()
}
