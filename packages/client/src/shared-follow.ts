import { withSharedLock } from './shared-lock.js'
import { join } from 'node:path'
import { readdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { atomicJson, optionalJson } from '../../runtime-manager/src/files.js'
import { sharedEvent, sharedInfo } from '../../protocol/src/shared.js'
import { SharedClient } from './shared.js'

const followed = z.object({
  endpoint: z.string(),
  share: sharedInfo,
  cursor: z.number().int().nonnegative(),
  records: z.array(sharedEvent),
  updatedAt: z.number(),
})
export class SharedFollowers {
  private working?: Promise<void>
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  readonly errors = new Map<string, string>()
  constructor(
    readonly client: SharedClient,
    readonly directory: string,
  ) {}
  private path(id: string) {
    return join(this.directory, z.uuid().parse(id) + '.json')
  }
  async list() {
    const files = await readdir(this.directory).catch((error) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const results = []
    for (const file of files.filter((value) => value.endsWith('.json'))) {
      const value = followed.parse(
        await optionalJson(join(this.directory, file)),
      )
      if (value.endpoint === this.client.mesh.endpoint)
        results.push({ ...value, error: this.errors.get(value.share.id) ?? '' })
    }
    return results
  }
  async follow(id: string) {
    const created = await withSharedLock(
      join(this.directory, 'lock'),
      async () => {
        const path = this.path(id)
        const old = await optionalJson(path)
        if (old) {
          const saved = followed.parse(old)
          if (saved.endpoint !== this.client.mesh.endpoint)
            throw new Error('This following belongs to another Server')
          return saved
        }
        const { share } = await this.client.pull(id, 0)
        const value = {
          endpoint: this.client.mesh.endpoint,
          share,
          cursor: 0,
          records: [],
          updatedAt: 0,
        }
        await atomicJson(path, value)
        return value
      },
    )
    await this.tick()
    return followed.parse(await optionalJson(this.path(id))) ?? created
  }
  async unfollow(id: string) {
    await this.working
    await withSharedLock(join(this.directory, 'lock'), () =>
      rm(this.path(id), { force: true }),
    )
  }
  async tick() {
    if (this.working) return this.working
    this.working = withSharedLock(join(this.directory, 'lock'), async () => {
      for (const value of await this.list()) {
        try {
          // Keep each page and its cursor in one durable replacement.
          for (let page = 0; page < 16; page++) {
            const result = await this.client.pull(value.share.id, value.cursor)
            if (
              result.next !== value.cursor + result.events.length ||
              result.events.some(
                (event, index) => event.seq !== value.cursor + index,
              )
            )
              throw new Error('Shared history has a gap')
            if (
              !result.events.length &&
              JSON.stringify(value.share) === JSON.stringify(result.share) &&
              !result.more
            )
              break
            const records = new Map(
              value.records.map((item) => [item.key, item]),
            )
            for (const item of result.events) records.set(item.key, item)
            Object.assign(value, {
              share: result.share,
              cursor: result.next,
              records: [...records.values()],
              updatedAt: Date.now(),
            })
            await atomicJson(this.path(value.share.id), value)
            if (!result.more) break
          }
          this.errors.delete(value.share.id)
        } catch (error) {
          this.errors.set(
            value.share.id,
            error instanceof Error ? error.message : 'Connection interrupted',
          )
        }
      }
    })
    try {
      await this.working
    } finally {
      this.working = undefined
    }
  }
  start() {
    const next = async () => {
      if (this.stopped) return
      await this.tick().catch(() => {})
      if (!this.stopped) this.timer = setTimeout(() => void next(), 750)
    }
    void next()
  }
  async close() {
    this.stopped = true
    clearTimeout(this.timer)
    await this.working
  }
}
