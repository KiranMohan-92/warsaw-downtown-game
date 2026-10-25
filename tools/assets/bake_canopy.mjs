/**
 * Bake the foliage canopy tile from the CC0 shrub scan (Poly Haven `shrub_02`).
 *
 *   python tools/assets/build_shrubs.py        # once: scan → tools/assets/build/shrubs/
 *   pnpm dev                                   # the bake page is served by the client dev server
 *   node tools/assets/bake_canopy.mjs          # → packages/client/public/tex/canopy_albedo.webp
 *
 * Renders packages/client/bake/canopy.html on the GPU (headless Chromium) and writes the graded,
 * seamless 512 px tile (rendered lossless, shipped as WebP via tools/assets/webp.py) that `loadCanopyScan` writes into the foliage atlas. Deterministic scene
 * (seeded); logged in ASSETS.md.
 */
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const input = `/@fs/${path.join(root, 'tools/assets/build/shrubs').split(path.sep).join('/')}`;
const out = path.join(root, 'packages/client/public/tex/canopy_albedo.webp');
const png = out.replace(/\.webp$/, '.png');
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('bake page:', e.message));
await page.goto(`http://localhost:5173/bake/canopy.html?in=${encodeURIComponent(input)}`);
const b64 = await (
  await page.waitForFunction('window.__bake', undefined, { timeout: 60000 })
).jsonValue();
writeFileSync(png, Buffer.from(b64, 'base64'));
execFileSync('python', [path.join(root, 'tools/assets/webp.py'), 'color', png], {
  stdio: 'inherit',
});
rmSync(png);
await browser.close();
