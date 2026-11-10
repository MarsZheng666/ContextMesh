import { it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexSharedSync } from '../../packages/adapter-codex/src/shared-sync.js'
import { stopCodexSync } from '../../packages/runtime-manager/src/upgrade.js'

it('drains an in-flight synchronization before releasing the worker for upgrade', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cm-sync-drain-'))
  const sync = new CodexSharedSync({
    stateDir: join(home, 'data/codex-bridge'),
    connection: { endpoint: 'https://fixture.invalid', token: 'fixture' },
  })
  let finish!: () => void,
    entered = false
  const work = new Promise<void>((accept) => {
    finish = accept
  })
  // Hold the actual work inside tick's serialization and process-owned lock.
  vi.spyOn(sync as any, 'sync').mockImplementation(async () => {
    entered = true
    await work
  })
  const abort = new AbortController()
  const running = sync.run(abort.signal)
  try {
    await expect.poll(() => entered).toBe(true)
    let stopped = false
    const stopping = stopCodexSync(home).then(() => {
      stopped = true
    })
    await new Promise((accept) => setTimeout(accept, 100))
    expect(stopped).toBe(false)
    finish()
    await stopping
    await running
    expect(stopped).toBe(true)
    // Already stopped is idempotent, including Windows pipe removal on exit.
    await stopCodexSync(home)
  } finally {
    finish()
    abort.abort()
    await running
    await rm(home, { recursive: true, force: true })
  }
}, 60000)
