import { cp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { atomicJson, optionalJson, privateDirectory } from './files.js'
import { stageBundle, selection, runtimeHome } from './install.js'
import { verifyBundle, releaseManifest, sha256 } from './manifest.js'
import {
  runtimeStatus,
  startRuntime,
  stopRuntime,
  managedPaths,
} from './supervisor.js'
import {
  listenLocal,
  callLocal,
} from '../../handoff-deepseek/src/local-control.js'
import { resolveConnection } from '../../client/src/config.js'
import { MeshClient } from '../../client/src/index.js'
const journalSchema = z.object({
  id: z.uuid(),
  from: z.string(),
  to: z.string(),
  phase: z.enum([
    'prepared',
    'stopped',
    'backed-up',
    'switched',
    'verified',
    'rolled-back',
    'attention',
  ]),
  wasRunning: z.boolean(),
  backup: z.string(),
  error: z.string().optional(),
})
export interface UpgradeHooks {
  running(): Promise<boolean>
  stop(): Promise<void>
  start(): Promise<unknown>
  health(): Promise<void>
}
export function hooksFor(home: string): UpgradeHooks {
  return {
    running: async () => !!(await runtimeStatus(home)).running,
    stop: () => stopRuntime(home),
    start: () => startRuntime(home),
    async health() {
      const r = z
        .object({
          ok: z.literal(true),
          value: z.object({ connectivity: z.object({ state: z.string() }) }),
        })
        .parse(
          await callLocal(
            managedPaths(home).state,
            { action: 'status' },
            15000,
          ),
        )
      if (!['ready', 'unconfigured'].includes(r.value.connectivity.state))
        throw new Error('The upgraded plugin could not connect')
    },
  }
}
export async function checkUpgrade(
  source: string,
  home = runtimeHome(),
  hash?: string,
  allowSame = false,
) {
  const current = await selection(home)
  if (!current) throw new Error('Install a runtime first')
  const target = await verifyBundle(source, hash)
  const previous = releaseManifest.parse(
    JSON.parse(
      await readFile(
        join(home, 'releases', current.version, 'manifest.json'),
        'utf8',
      ),
    ),
  )
  if (target.version === current.version && !allowSame)
    throw new Error('This version is already selected')
  const c = await resolveConnection({
    configPath: join(managedPaths(home).state, 'connection.json'),
  })
  let schema = previous.schema
  if (c.token && c.endpoint) {
    const health = (await new MeshClient({
      endpoint: c.endpoint,
      token: c.token,
      retries: 0,
    }).request('/health/ready')) as { schemaVersion: number }
    schema = health.schemaVersion
  }
  if (schema < target.minSchema || schema > target.maxSchema)
    throw new Error(
      'Database schema is incompatible. Upgrade the server with maintenance and a verified database backup first.',
    )
  return {
    from: current.version,
    to: target.version,
    schema,
    compatibleRollback:
      schema >= previous.minSchema && schema <= previous.maxSchema,
  }
}
export async function upgrade(
  source: string,
  home = runtimeHome(),
  hash?: string,
  hooks = hooksFor(home),
) {
  await privateDirectory(join(home, 'upgrade-lock'))
  const lock = await listenLocal(join(home, 'upgrade-lock'), async () => ({
    busy: true,
  }))
  try {
    const journalPath = join(home, 'upgrade.json')
    const prior = await optionalJson(journalPath)
    let journal = prior ? journalSchema.parse(prior) : undefined
    const check = await checkUpgrade(
      source,
      home,
      hash,
      !!journal && !['verified', 'rolled-back'].includes(journal.phase),
    )
    if (journal && !['verified', 'rolled-back'].includes(journal.phase)) {
      const old = releaseManifest.parse(
        JSON.parse(
          await readFile(
            join(home, 'releases', journal.from, 'manifest.json'),
            'utf8',
          ),
        ),
      )
      check.compatibleRollback =
        check.schema >= old.minSchema && check.schema <= old.maxSchema
    }
    if (
      journal &&
      !['verified', 'rolled-back'].includes(journal.phase) &&
      journal.to !== check.to
    )
      throw new Error(
        'Finish or roll back the recorded upgrade before starting another',
      )
    await stageBundle(source, home, hash)
    if (!journal || ['verified', 'rolled-back'].includes(journal.phase)) {
      const id = randomUUID()
      journal = {
        id,
        from: check.from,
        to: check.to,
        phase: 'prepared',
        wasRunning: await hooks.running(),
        backup: join(home, 'backups', id),
      }
      await atomicJson(journalPath, journal)
    }
    const save = async (phase: typeof journal.phase) => {
      journal!.phase = phase
      await atomicJson(journalPath, journal)
    }
    try {
      if (journal.phase === 'prepared') {
        if (await hooks.running()) await hooks.stop()
        await save('stopped')
      }
      if (journal.phase === 'stopped') {
        await privateDirectory(journal.backup)
        // The backup lives outside data. Credentials, node identity and import journals stay private.
        await cp(managedPaths(home).data, join(journal.backup, 'data'), {
          recursive: true,
          verbatimSymlinks: true,
        })
        await atomicJson(join(journal.backup, 'selection.json'), {
          version: journal.from,
        })
        await save('backed-up')
      }
      if (journal.phase === 'backed-up') {
        await atomicJson(join(home, 'current.json'), {
          version: journal.to,
          previous: journal.from,
        })
        await save('switched')
      }
      if (journal.phase === 'switched') {
        if (journal.wasRunning) {
          await hooks.start()
          await hooks.health()
        }
        const oldNode = (await optionalJson(
          join(journal.backup, 'data/dsh/contextmesh/node.json'),
        )) as { nodeId?: string } | undefined
        const newNode = (await optionalJson(
          join(managedPaths(home).state, 'node.json'),
        )) as { nodeId?: string } | undefined
        if (oldNode?.nodeId && oldNode.nodeId !== newNode?.nodeId)
          throw new Error('Device identity changed during upgrade')
        await save('verified')
      }
      if (journal.phase === 'attention')
        throw new Error(
          'Upgrade needs attention; inspect the journal and use rollback after resolving active work',
        )
      return {
        from: journal.from,
        to: journal.to,
        phase: journal.phase,
        backup: journal.backup,
      }
    } catch (error) {
      if (journal.phase === 'switched' && check.compatibleRollback) {
        try {
          if (await hooks.running()) await hooks.stop()
          await atomicJson(join(home, 'current.json'), {
            version: journal.from,
            previous: journal.to,
          })
          if (journal.wasRunning) {
            await hooks.start()
            await hooks.health()
          }
          await save('rolled-back')
        } catch {
          await save('attention')
        }
      }
      journal.error = error instanceof Error ? error.name : 'UPGRADE_FAILED'
      await atomicJson(journalPath, journal)
      throw error
    }
  } finally {
    await lock.close()
  }
}
export async function rollback(home = runtimeHome(), hooks = hooksFor(home)) {
  await privateDirectory(join(home, 'upgrade-lock'))
  const lock = await listenLocal(join(home, 'upgrade-lock'), async () => ({
    busy: true,
  }))
  try {
    const current = await selection(home)
    if (!current?.previous) throw new Error('No previous version recorded')
    const target = join(home, 'releases', current.previous)
    await checkUpgrade(target, home)
    const running = await hooks.running()
    if (running) await hooks.stop()
    await atomicJson(join(home, 'current.json'), {
      version: current.previous,
      previous: current.version,
    })
    if (running) {
      await hooks.start()
      await hooks.health()
    }
    const journal = await optionalJson(join(home, 'upgrade.json'))
    if (journal)
      await atomicJson(join(home, 'upgrade.json'), {
        ...journalSchema.parse(journal),
        phase: 'rolled-back',
      })
    return { version: current.previous, dataRestored: false }
  } finally {
    await lock.close()
  }
}
