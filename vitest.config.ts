import { defineConfig } from 'vitest/config'

import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@x-code-cli/core': fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/core/tests/**/*.test.ts', 'packages/cli/tests/*.test.{ts,tsx}'],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'faults',
          include: ['packages/cli/tests/faults/**/*.test.ts'],
          sequence: { groupOrder: 1 },
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'package',
          include: ['packages/cli/tests/package/**/*.test.ts'],
          sequence: { groupOrder: 2 },
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'pty',
          include: ['packages/cli/tests/pty/**/*.test.ts'],
          sequence: { groupOrder: 3 },
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
})
