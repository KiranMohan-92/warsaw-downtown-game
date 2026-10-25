import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // shared is consumed as TS source, so it must be bundled into the server build.
  noExternal: ['@wd/shared'],
});
