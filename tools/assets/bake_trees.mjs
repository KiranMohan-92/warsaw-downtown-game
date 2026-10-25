/**
 * Bake the game's trees with EZ-Tree (MIT, dev dependency; only the outputs ship).
 *
 *   pnpm dev                          # the bake page is served by the client dev server
 *   node tools/assets/bake_trees.mjs  # → packages/client/public/models/trees/
 *
 * Per species (budget-tuned presets): <id>.glb (branches + leaves, trunk base at the origin,
 * height 1; materials are placeholders), <id>_impostor.webp (8 azimuth views, unlit colour +
 * alpha) and <id>_impostor_n.webp (world normals, lossless) for the far LOD, and trees.json
 * (crown radius, frame layout, triangle counts, bark/leaf textures and tints). The shared
 * bark/leaf textures are copied (resized) from EZ-Tree's assets. Every texture is WebP via
 * tools/assets/webp.py (alpha kept bit-exact). Deterministic (seeded presets).
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(root, 'packages/client/public/models/trees');
const assets = path.join(root, 'tools/assets');
const shippedFrame = 128;
/** Encode a lossless page render as the shipped WebP next to it (tools/assets/webp.py). */
const webp = (kind, file) => execFileSync('python', [path.join(assets, 'webp.py'), kind, file]);
const shrinkNormalImpostor = (file, color) =>
  execFileSync('python', [
    path.join(assets, 'shrink_tree_impostor.py'),
    file,
    String(shippedFrame),
    '--color',
    color,
  ]);
mkdirSync(out, { recursive: true });

/** Game species → EZ-Tree preset + budget tuning (fewer rings/sections, fewer larger leaves). */
const SPECIES = {
  ash: {
    preset: 'Ash Medium',
    tune: {
      branch: { sections: { 0: 8, 1: 5, 2: 3, 3: 2 }, segments: { 0: 8, 1: 5, 2: 3, 3: 3 } },
      leaves: { count: 9, size: 3.4 },
    },
  },
  oak: {
    preset: 'Oak Medium',
    tune: {
      branch: { sections: { 0: 8, 1: 5, 2: 3, 3: 1 }, segments: { 0: 7, 1: 4, 2: 3, 3: 3 } },
      leaves: { count: 10, size: 3.2 },
    },
  },
  pine: {
    preset: 'Pine Medium',
    tune: {
      branch: { sections: { 0: 10, 1: 5, 2: 4, 3: 3 }, segments: { 0: 7, 1: 4, 2: 3, 3: 3 } },
      leaves: { count: 16, size: 1.9 },
    },
  },
};

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const manifest = { species: {} };
for (const [id, s] of Object.entries(SPECIES)) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`${id}:`, e.message));
  const url = `http://localhost:5173/bake/treesExport.html?preset=${encodeURIComponent(s.preset)}&tune=${encodeURIComponent(JSON.stringify(s.tune))}`;
  await page.goto(url);
  const res = await (
    await page.waitForFunction('window.__out', undefined, { timeout: 180000 })
  ).jsonValue();
  writeFileSync(path.join(out, `${id}.glb`), Buffer.from(res.glb, 'base64'));
  // The page renders lossless PNGs; ship full colour and a smaller lossless normal/AO atlas.
  const colorPng = path.join(out, `${id}_impostor.png`);
  const normalPng = path.join(out, `${id}_impostor_n.png`);
  writeFileSync(colorPng, Buffer.from(res.color, 'base64'));
  writeFileSync(normalPng, Buffer.from(res.normals, 'base64'));
  shrinkNormalImpostor(normalPng, colorPng);
  webp('color', colorPng);
  webp('lossless', normalPng);
  rmSync(colorPng);
  rmSync(normalPng);
  manifest.species[id] = res.info;
  console.log(id, JSON.stringify(res.info));
  await page.close();
}
await browser.close();

// Shared textures (bark colour + normal, leaf colour/alpha), resized for the web.
const ez = path.join(root, 'packages/client/node_modules/@dgreenheck/ez-tree/src/lib/assets');
const barks = new Set(Object.values(manifest.species).map((s) => s.bark));
const leaves = new Set(Object.values(manifest.species).map((s) => s.leaf));
const py = `
import sys
sys.path.insert(0, sys.argv[4])
from PIL import Image
from webp import save_webp
src, dst, size = sys.argv[1], sys.argv[2], int(sys.argv[3])
im = Image.open(src)
im = im.convert('RGBA' if im.mode in ('RGBA', 'LA', 'P') else 'RGB').resize((size, size), Image.LANCZOS)
save_webp(im, dst, 'data' if 'normal' in dst else 'color')
`;
const resize = (src, dst, size) =>
  execFileSync('python', ['-c', py, src, dst, String(size), assets]);
for (const b of barks) {
  resize(path.join(ez, `bark/${b}_color_1k.jpg`), path.join(out, `bark_${b}_color.webp`), 512);
  resize(path.join(ez, `bark/${b}_normal_1k.jpg`), path.join(out, `bark_${b}_normal.webp`), 512);
}
for (const l of leaves)
  resize(path.join(ez, `leaves/${l}_color.png`), path.join(out, `leaf_${l}.webp`), 512);
writeFileSync(path.join(out, 'trees.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote', out);
