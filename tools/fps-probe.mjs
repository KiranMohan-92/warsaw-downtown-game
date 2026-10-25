// Real-GPU fps probe for the Market (the fps gate: realistic AND 50–60 fps).
//   pnpm dev                                  (client on :5173)
//   node tools/fps-probe.mjs                  Intel iGPU (Chrome's default GPU), Low / Medium / High / Auto
//   node tools/fps-probe.mjs --dgpu           the discrete GPU (--force_high_performance_gpu)
// flags: --quality=low,medium,high,auto  --hide=prefix,prefix (mesh name prefixes, see __wd.hide)
//        --w=1600 --h=900  --frames=300  --scale=0.75 (fixed render scale, dynamic resolution off)
//        --eval="js run in the page after ready" (bisection: e.g. "__wdGame.renderer.shadowMap.enabled=false")
//        --weather=sunny|golden|… (the preset to measure; default sunny)
//        --json=file
// Prints per tier and view: fps (mean), p95 / p99 frame ms, draw calls, triangles, internal scale.
// Run it on a quiet machine: other lanes' gates and a second Chrome game tab skew the numbers.
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const has = (k) => process.argv.includes(`--${k}`);
const URL = process.env.WD_URL ?? 'http://localhost:5173';
const QUALITIES = arg('quality', 'low,medium,high,auto').split(',');
const HIDE = arg('hide', '').split(',').filter(Boolean);
const W = Number(arg('w', 1600));
const H = Number(arg('h', 900));
const FRAMES = Number(arg('frames', 300));
const SCALE = arg('scale', '');
const EVAL = arg('eval', '');
const WEATHER = arg('weather', 'sunny');
const DGPU = has('dgpu') || !!process.env.WD_DGPU;

// Market views: the container alley, the stalls toward the Palace (the heaviest), the forecourt.
const VIEWS = {
  alley: [118, 0.05, 20, 0, -0.02],
  stalls: [60, 0.05, 40, -2.356, -0.03],
  forecourt: [100, 0.05, 0, 3.14, -0.03],
};

const browser = await chromium.launch({
  headless: true,
  args: [
    ...(DGPU ? ['--force_high_performance_gpu'] : []),
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
  ],
});
const out = { gpu: '', viewport: [W, H], hide: HIDE, eval: EVAL, tiers: {} };
for (const quality of QUALITIES) {
  const auto = quality === 'auto';
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.addInitScript(
    (s) => {
      localStorage.setItem('wd.settings.v2', JSON.stringify(s));
      localStorage.removeItem('wd.perf.v1'); // Auto starts from scratch, not from a remembered tier
    },
    {
      map: 'defilad',
      mapSize: 'market',
      quality,
      weather: WEATHER,
      dynamicResolution: auto,
      ...(SCALE && !auto ? { renderScale: Number(SCALE) } : {}),
      sparring: false,
      online: false,
    },
  );
  await page.goto(`${URL}/?autotest&online=0${auto ? '&governor' : ''}`);
  await page.waitForFunction('window.__wd?.ready === true', undefined, { timeout: 240_000 });
  out.gpu ||= await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  // Hide by layer mask, not `visible` (what __wd.hide sets): the per-frame foliage/set-dressing
  // LOD updaters rewrite `visible` every frame, never a layer mask. Each matching object and its
  // whole subtree (three tests layers per object, not per parent), for the main and shadow pass.
  if (HIDE.length) {
    await page.waitForFunction('!!window.__wdGame', undefined, { timeout: 60_000 });
    const n = await page.evaluate((prefixes) => {
      const roots = [];
      window.__wdGame.scene.traverse((o) => {
        if (prefixes.some((p) => o.name.startsWith(p))) roots.push(o);
      });
      for (const r of roots) r.traverse((o) => o.layers.disableAll());
      return roots.length;
    }, HIDE);
    if (quality === QUALITIES[0]) console.log(`hidden ${n} objects (${HIDE.join(',')})`);
  }
  if (EVAL) await page.evaluate(EVAL);
  const rows = {};
  for (const [view, pose] of Object.entries(VIEWS)) {
    await page.evaluate((v) => window.__wd.teleport(...v), pose);
    await page.waitForTimeout(auto ? 14_000 : 2_500);
    const r = await page.evaluate(
      (n) =>
        new Promise((resolve) => {
          const ts = [];
          let last = performance.now();
          const f = (now) => {
            ts.push(now - last);
            last = now;
            if (ts.length < n) requestAnimationFrame(f);
            else {
              ts.sort((a, b) => a - b);
              const mean = ts.reduce((a, b) => a + b, 0) / ts.length;
              const s = window.__wd.state();
              const st = window.__wd.sceneStats?.() ?? {};
              const g = window.__wdGame;
              resolve({
                fps: 1000 / mean,
                p95: ts[Math.floor(n * 0.95)],
                p99: ts[Math.floor(n * 0.99)],
                calls: g?.renderer.info.render.calls ?? st.drawCalls ?? null,
                tris: g?.renderer.info.render.triangles ?? st.triangles ?? null,
                scale: g ? g.renderer.getPixelRatio() / window.devicePixelRatio : null,
                tier: g?.post?.quality ?? s.quality ?? null,
              });
            }
          };
          requestAnimationFrame(f);
        }),
      FRAMES,
    );
    rows[view] = r;
  }
  out.tiers[quality] = rows;
  const f1 = (x) => (x == null ? '—' : x.toFixed(1));
  console.log(
    `${quality.padEnd(6)} ` +
      Object.entries(rows)
        .map(
          ([v, r]) =>
            `${v} ${f1(r.fps)} fps (p95 ${f1(r.p95)} ms, ${r.calls ?? '—'} calls, ${r.tris != null ? Math.round(r.tris / 1000) + 'k tris' : '—'}, scale ${r.scale != null ? r.scale.toFixed(2) : '—'}${auto ? `, ${r.tier}` : ''})`,
        )
        .join(' | '),
  );
  await page.close();
}
console.log(
  `GPU: ${out.gpu} · ${W}×${H}${HIDE.length ? ` · hidden: ${HIDE.join(',')}` : ''}${EVAL ? ` · eval: ${EVAL}` : ''}`,
);
const json = arg('json', '');
if (json) writeFileSync(json, JSON.stringify(out, null, 1));
await browser.close();
