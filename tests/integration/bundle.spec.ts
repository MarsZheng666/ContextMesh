import { it, expect } from 'vitest'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import {
  applyEntryPatches,
  entryListSchema,
} from '@deepseek-ai/cordis-plugin-include'

it('composes the shipped bundle with the official base profile and retains checkpoint policy', async () => {
  const require = createRequire(
    await realpath(resolve('node_modules/@deepseek-ai/dsh/lib/bin.js')),
  )
  const { load } = require('js-yaml') as {
    load: (text: string, options: { schema: unknown }) => unknown
  }
  const basePath = join(
    dirname(require.resolve('@deepseek-ai/dsh-base/package.json')),
    'cordis.patch.yml',
  )
  const basePatches = load(await readFile(basePath, 'utf8'), {
    schema: entryListSchema,
  }) as Parameters<typeof applyEntryPatches>[1]
  const base = applyEntryPatches([], basePatches, () => {})
  const patches = load(
    await readFile('packages/adapter-deepseek/cordis.patch.yml', 'utf8'),
    { schema: entryListSchema },
  ) as Parameters<typeof applyEntryPatches>[1]
  const warnings: string[] = []
  const entries = applyEntryPatches(base, patches, (message) =>
    warnings.push(message),
  )
  expect(warnings).toEqual([])
  expect(
    entries.find((e) => e.id === 'session-persistence-jsonl')?.disabled,
  ).toBe(true)
  expect(entries.find((e) => e.id === 'agent-loop')?.inject).toEqual([
    'sessionPersistence',
  ])
  expect(
    entries.find((e) => e.id === 'session-checkpoint-policy')?.disabled,
  ).not.toBe(true)
  expect(entries.filter((e) => e.name === 'dsh-contextmesh')).toHaveLength(1)
})
