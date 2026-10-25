import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', sourcemap: true },
  // The practice match worker (net/practiceRoom.ts) is an ES module: it shares chunks.
  worker: { format: 'es' },
});
