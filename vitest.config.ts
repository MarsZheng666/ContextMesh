import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    fileParallelism: false,
    // Keep network I/O scheduling live while contracts advance batching timers.
    fakeTimers: {
      toFake: [
        'setTimeout',
        'clearTimeout',
        'setInterval',
        'clearInterval',
        'Date',
      ],
    },
    testTimeout: 20000,
    hookTimeout: 60000,
    globalSetup: ['tests/global-setup.ts'],
  },
})
