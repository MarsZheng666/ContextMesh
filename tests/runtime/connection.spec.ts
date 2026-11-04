import { test, expect, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, {
  SessionId,
  SESSION_FORMAT_VERSION,
} from '@deepseek-ai/dsh-session'
import * as Plugin from '../../packages/adapter-deepseek/src/index.js'
import { ConnectionBootstrap } from '../../packages/handoff-deepseek/src/bootstrap.js'
import {
  writeConnection,
  resolveConnection,
} from '../../packages/client/src/config.js'
import { MeshError } from '../../packages/protocol/src/index.js'
import { fixture, TOKEN } from '../fixture.js'
test('unconfigured persistence mounts offline and refuses remote writes without local fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-unconfigured-')),
    ctx = new Context()
  vi.stubEnv('CONTEXTMESH_CONFIG', join(root, 'missing.json'))
  vi.stubEnv('CONTEXTMESH_TOKEN', '')
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(Plugin, { timeoutMs: 100 })
    expect(ctx.contextmesh).toBeTruthy()
    expect(await ctx.contextmesh.list()).toEqual([])
    await expect(
      ctx.contextmesh.create({
        id: SessionId(randomUUID()),
        version: SESSION_FORMAT_VERSION,
        createdAt: Date.now(),
        isSeeded: false,
      }),
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    expect(ctx.contextmesh.writers.size).toBe(0)
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
test('configuration resolves per field and reports overrides without exposing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cm-config-')),
    path = join(root, 'connection.json')
  try {
    await writeConnection(
      {
        version: 1,
        endpoint: 'https://example.invalid',
        token: TOKEN,
        nodeId: randomUUID(),
        name: 'test',
      },
      path,
    )
    const result = await resolveConnection(
      { configPath: path },
      { CONTEXTMESH_ENDPOINT: 'https://other.invalid' },
    )
    expect(result.source.endpoint).toBe('environment')
    expect(result.source.token).toBe(path)
    expect(JSON.stringify(result.source)).not.toContain(TOKEN)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
test('offline controller keeps cached metadata, blocks mutations and reconnects without replay', async () => {
  let fail = false,
    calls = 0
  const control = new ConnectionBootstrap(async () => ({
    async command(input) {
      if (fail) throw new MeshError('UNAVAILABLE', 'network down', 503)
      calls++
      return { sessions: [{ id: 'only-test' }], nodes: [], command: input }
    },
    async close() {},
  }))
  await control.retry()
  const first = (await control.command({ action: 'status' })) as any
  expect(first.sessions[0].id).toBe('only-test')
  fail = true
  const offline = (await control.command({ action: 'status' })) as any
  expect(offline.sessions).toEqual(first.sessions)
  expect(offline.connectivity.lastSync).toBeTruthy()
  await expect(control.command({ action: 'handoff' })).rejects.toMatchObject({
    code: 'UNAVAILABLE',
  })
  expect(calls).toBe(1)
  fail = false
  await control.command({ action: 'status' })
  expect(calls).toBe(2)
  await control.close()
})
test('saved device credentials can connect after provider installation', async () => {
  const f = await fixture(),
    root = await mkdtemp(join(tmpdir(), 'cm-late-config-')),
    ctx = new Context()
  vi.stubEnv('CONTEXTMESH_CONFIG', join(root, 'connection.json'))
  vi.stubEnv('CONTEXTMESH_TOKEN', '')
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(Plugin, { timeoutMs: 1000 })
    await expect(ctx.contextmesh.client.capabilities()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    })
    await writeConnection(
      {
        version: 1,
        endpoint: f.endpoint,
        token: TOKEN,
        nodeId: randomUUID(),
        name: 'owner',
      },
      join(root, 'connection.json'),
    )
    expect((await ctx.contextmesh.client.capabilities()).protocolVersion).toBe(
      1,
    )
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})
