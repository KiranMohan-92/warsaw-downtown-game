// Motion smoothness probe (real GPU): sprint + turn through the Market and report frame-time
// distribution and hitches. `pnpm dev` must be running.  node tools/motion-probe.mjs
import { chromium } from '@playwright/test';

const URL = process.env.WD_URL ?? 'http://localhost:5173';
const SIZE = process.env.WD_SIZE ?? 'market';
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await ctx.newPage();
await page.addInitScript((s) => localStorage.setItem('wd.settings.v1', JSON.stringify(s)), {
  map: 'defilad',
  mapSize: SIZE,
  quality: 'auto',
  dynamicResolution: true,
  weather: 'sunny',
});
// WD_MEM=medium:0.6 simulates a returning player (Auto remembers where it settled).
if (process.env.WD_MEM) {
  const [quality, scale] = process.env.WD_MEM.split(':');
  await page.addInitScript((m) => localStorage.setItem('wd.perf.v1', JSON.stringify(m)), {
    quality,
    scale: Number(scale),
  });
}
await page.goto(`${URL}/?autotest&governor&online=0`);
await page.waitForFunction('window.__wd?.ready === true', undefined, { timeout: 120_000 });
await page.evaluate(() => window.__wd.teleport(60, 0.05, 2, -Math.PI / 2, 0));
await page.waitForTimeout(8000); // governor settles
const r = await page.evaluate(async () => {
  const times = [];
  let last = performance.now();
  let yaw = -Math.PI / 2;
  window.__wd.hold(2, 0, 1); // sprint forward
  await new Promise((done) => {
    const f = (t) => {
      times.push(t - last);
      last = t;
      const st = window.__wd.state();
      const tag = `${st.quality}@${st.resolutionScale.toFixed(2)}`;
      if (tag !== window.__lastTag) {
        (window.__changes ??= []).push(`${times.length}:${tag}`);
        window.__lastTag = tag;
      }
      yaw += 0.012; // steady turn, like sweeping the mouse
      window.__wd.look(yaw, 0);
      if (times.length % 150 === 0) window.__wd.tap(1 << 9); // switch to pistol…
      if (times.length % 150 === 75) window.__wd.tap(1 << 8); // …and back
      if (times.length < 900) requestAnimationFrame(f);
      else done();
    };
    requestAnimationFrame(f);
  });
  window.__wd.hold(0);
  times.shift();
  const s = [...times].sort((a, b) => a - b);
  const q = (p) => +s[Math.floor(s.length * p)].toFixed(1);
  return {
    frames: times.length,
    avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(2),
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: +s[s.length - 1].toFixed(1),
    hitches25: times.filter((t) => t > 25).length,
    hitches50: times.filter((t) => t > 50).length,
    // Frame index of each hitch (switches happen at multiples of 75).
    hitchAt: times.map((t, i) => (t > 40 ? `${i}:${Math.round(t)}` : '')).filter(Boolean),
    changes: window.__changes,
    quality: window.__wd.state().quality,
    scale: window.__wd.state().resolutionScale,
  };
});
console.log(JSON.stringify(r));
await browser.close();
