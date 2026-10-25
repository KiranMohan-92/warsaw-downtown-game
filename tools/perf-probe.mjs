// Real-GPU frame-time probe: `pnpm dev` in one terminal, then `pnpm perf`.
// Launches Chromium on the machine's GPU (ANGLE/D3D11 on Windows), loads the Market at 1600×900 by
// default, and reports average / p95 frame time, draw calls, programs, scale, and target outcomes.
// WD_MAP=defilad (default) or range. WD_SIZE=market|full|north|south. WD_VIEW=alley|forecourt|palace|all.
// WD_WIDTH / WD_HEIGHT override the viewport. WD_WEATHER=sunny|rain|overcast. WD_ISOLATE=1 adds the working foliage hide cut.
import { chromium } from '@playwright/test';

const URL = process.env.WD_URL ?? 'http://localhost:5173';
const MAP = process.env.WD_MAP ?? 'defilad';
const SIZE = process.env.WD_SIZE ?? 'market';
const WIDTH = Number(process.env.WD_WIDTH ?? 1600);
const HEIGHT = Number(process.env.WD_HEIGHT ?? 900);
const VIEW = process.env.WD_VIEW ?? 'all';
const WEATHER = process.env.WD_WEATHER ?? 'sunny';
const VIEWS =
  MAP === 'range'
    ? { range: [-3, 0.02, 38, -0.35, 0.02] }
    : {
        alley: [118, 0.05, 20, 0, 0.03],
        forecourt: [60, 0.05, 2, -Math.PI / 2 + 0.2, 0.05],
        palace: [100, 0.05, 0, Math.PI / 2, -0.06],
      };
const configs = [
  { label: 'Low100', quality: 'low', weather: WEATHER, dynamicResolution: false },
  { label: 'Auto60+', quality: 'auto', weather: WEATHER, dynamicResolution: true },
];
const selectedViews = VIEW === 'all' ? Object.entries(VIEWS) : [[VIEW, VIEWS[VIEW]]];
const cuts = process.env.WD_ISOLATE
  ? [{ label: 'base' }, { label: 'no-foliage', hide: ['trees', 'foliage'] }]
  : [{ label: 'base' }];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
for (const cfg of configs) {
  for (const [view, pose] of selectedViews) {
    if (!pose) throw new Error(`unknown WD_VIEW ${VIEW}`);
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
    const page = await ctx.newPage();
    await page.addInitScript((c) => localStorage.setItem('wd.settings.v1', JSON.stringify(c)), {
      ...cfg,
      map: MAP,
      mapSize: SIZE,
    });
    await page.goto(`${URL}/?autotest&governor&online=0`);
    await page.waitForFunction('window.__wd?.ready === true', undefined, { timeout: 60_000 });
    const programsAtReady = await page.evaluate(() => window.__wd.state().shaderPrograms);
    await page.evaluate((v) => window.__wd.teleport(...v), pose);
    await page.waitForTimeout(cfg.dynamicResolution ? 12_000 : 3_000);
    for (const cut of cuts) {
      await page.evaluate(() => {
        for (const prefix of ['trees', 'foliage']) window.__wd.hide(prefix, false);
      });
      if (cut.hide) {
        await page.evaluate((prefixes) => {
          for (const prefix of prefixes) window.__wd.hide(prefix, true);
        }, cut.hide);
        await page.waitForTimeout(500);
      }
      const r = await page.evaluate(async () => {
        const before = window.__wd.state();
        let minScale = before.resolutionScale;
        const times = [];
        let last = performance.now();
        await new Promise((done) => {
          const f = (t) => {
            times.push(t - last);
            last = t;
            if (times.length % 30 === 0)
              minScale = Math.min(minScale, window.__wd.state().resolutionScale);
            if (times.length < 300) requestAnimationFrame(f);
            else done();
          };
          requestAnimationFrame(f);
        });
        times.shift();
        times.sort((a, b) => a - b);
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const after = window.__wd.state();
        const gl = document.createElement('canvas').getContext('webgl2');
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          fps: +(1000 / avg).toFixed(1),
          avgMs: +avg.toFixed(2),
          p95Ms: +times[Math.floor(times.length * 0.95)].toFixed(2),
          drawCalls: after.drawCalls,
          shadowDrawCalls: after.shadowDrawCalls,
          programsBefore: before.shaderPrograms,
          programsAfter: after.shaderPrograms,
          programDelta: after.shaderPrograms - before.shaderPrograms,
          quality: after.quality,
          scale: +after.resolutionScale.toFixed(2),
          minScale: +minScale.toFixed(2),
          gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown',
        };
      });
      const targetFps = cfg.dynamicResolution ? 58 : 45;
      const targetScale = cfg.dynamicResolution ? 0.6 : 1;
      console.log(
        JSON.stringify({
          map: MAP,
          size: SIZE,
          viewport: `${WIDTH}x${HEIGHT}`,
          weather: WEATHER,
          view,
          config: cfg.label,
          cut: cut.label,
          targetFps,
          targetScale,
          passesTarget: r.fps >= targetFps && r.minScale >= targetScale,
          programsAtReady,
          programGrowthSinceReady: r.programsAfter - programsAtReady,
          ...r,
        }),
      );
    }
    await ctx.close();
  }
}
await browser.close();
