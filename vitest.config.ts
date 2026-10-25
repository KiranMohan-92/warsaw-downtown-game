import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Whole-map Rapier fixtures must not starve the transport tests' real-time input loop.
    // Preserve strict prediction assertions and timeouts by running files sequentially.
    fileParallelism: false,
    maxWorkers: 1,
    projects: [
      {
        test: {
          name: 'shared',
          // Builds full Rapier worlds of the real map: seconds each, more under CPU load.
          testTimeout: 20_000,
          root: 'packages/shared',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'server',
          // Builds full Rapier worlds of the real map: seconds each, more under CPU load.
          testTimeout: 20_000,
          root: 'packages/server',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'client',
          // Procedural texture generation and whole-map mesh builds take seconds under load.
          testTimeout: 20_000,
          root: 'packages/client',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'tools',
          root: 'tools',
          include: ['**/*.test.mjs'],
          exclude: ['**/node_modules/**', 'blender/**', 'assets/raw/**', 'assets/build/**'],
          environment: 'node',
        },
      },
    ],
  },
});
