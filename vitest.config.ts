import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 60000,
    globalSetup: ['tests/global-setup.ts'],
  },
})
