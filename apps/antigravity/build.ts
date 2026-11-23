import { build } from 'tsup'
import { cp } from 'node:fs/promises'

const outDir = 'dist/antigravity'
await build({
  config: false,
  entry: {
    server: 'apps/antigravity/src/server.ts',
    hook: 'apps/antigravity/src/hook.ts',
  },
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  noExternal: [/^zod/],
  splitting: false,
  clean: true,
})
await cp('apps/antigravity/plugin', outDir, { recursive: true })
