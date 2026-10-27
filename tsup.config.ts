import { defineConfig } from 'tsup'
export default defineConfig({
  entry: { server: 'apps/server/src/main.ts', cli: 'apps/cli/src/main.ts' },
  format: ['esm'],
  target: 'node24',
  sourcemap: true,
  clean: true,
  splitting: false,
})
