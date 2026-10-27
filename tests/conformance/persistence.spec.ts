import { fixture } from '../fixture.js'
import { runPersistenceContract } from '../upstream/contract.js'
import { runLiveWritePathContract } from '../upstream/live-write-contract.js'

runPersistenceContract('contextmesh-postgres', async () => {
  const f = await fixture()
  const instance = async () => {
    const ctx = await f.mount()
    return {
      persistence: ctx.sessionPersistence,
      dispose: () => ctx.fiber.dispose(),
    }
  }
  const primary = await instance()
  return { ...primary, reopen: instance }
})
runLiveWritePathContract('contextmesh-postgres', 200, async () => {
  const f = await fixture()
  return { ctx: await f.mount(), remount: f.mount }
})
