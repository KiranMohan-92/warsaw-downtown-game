// Where does the frame go? One page, vsync off: frame time with each group of meshes hidden in turn.
//   pnpm dev, then: node tools/fps-bisect.mjs [--quality=low] [--view=stalls] [--dgpu] [--w=1600 --h=900]
// Groups are the first segment of the mesh names (map, props, heroes, dressing, foliage, facade,
// trees, …) plus a few switches (shadows, post chain, viewmodel, half resolution). Prints the
// uncapped frame time and what each cut saves, largest first. Quiet machine only.
import { chromium } from '@playwright/test';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const URL = process.env.WD_URL ?? 'http://localhost:5173';
const QUALITY = arg('quality', 'low');
const VIEW = arg('view', 'stalls');
const W = Number(arg('w', 1600));
const H = Number(arg('h', 900));
const DEPTH = Number(arg('depth', 1));
const VIEWS = {
  alley: [118, 0.05, 20, 0, -0.02],
  stalls: [60, 0.05, 40, -2.356, -0.03],
  forecourt: [100, 0.05, 0, 3.14, -0.03],
};
const browser = await chromium.launch({
  headless: true,
  args: [
    ...(process.argv.includes('--dgpu') ? ['--force_high_performance_gpu'] : []),
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--disable-gpu-vsync',
    '--disable-frame-rate-limit',
  ],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.addInitScript(
  (s) => {
    localStorage.setItem('wd.settings.v2', JSON.stringify(s));
    localStorage.removeItem('wd.perf.v1');
  },
  {
    map: 'defilad',
    mapSize: 'market',
    quality: QUALITY,
    weather: 'sunny',
    dynamicResolution: false,
    sparring: false,
    online: false,
  },
);
await page.goto(`${URL}/?autotest&online=0`);
await page.waitForFunction('window.__wd?.ready === true && !!window.__wdGame', undefined, {
  timeout: 240_000,
});
await page.evaluate((v) => window.__wd.teleport(...v), VIEWS[VIEW]);
await page.waitForTimeout(3000);
const result = await page.evaluate(
  async ([depth, onlyGroups]) => {
    const g = window.__wdGame;
    const r = g.renderer;
    const raf = () => new Promise((res) => requestAnimationFrame(res));
    const measure = async (frames = 120) => {
      for (let i = 0; i < 12; i++) await raf();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) await raf();
      return {
        ms: (performance.now() - t0) / frames,
        calls: r.info.render.calls,
        tris: r.info.render.triangles,
      };
    };
    // Groups by name prefix (first `depth` segments), only objects that are visible now.
    const groups = new Map();
    g.scene.traverse((o) => {
      if (!(o.isMesh || o.isPoints || o.isLine || o.isSprite)) return;
      let vis = true;
      for (let q = o; q; q = q.parent) if (!q.visible) vis = false;
      if (!vis) return;
      const name = o.name || o.parent?.name || o.parent?.parent?.name || '(unnamed)';
      const key = name
        .split(':')
        .slice(0, depth)
        .join(':')
        .replace(/[|\d,-]+$/, '');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    });
    const base = await measure(200);
    const rows = [];
    const only = new Set(onlyGroups);
    for (const [key, objs] of groups) {
      if (only.size && !only.has(key)) continue;
      const ref = await measure(90);
      // Layers, not `visible`: the per-frame foliage LOD and set-dressing updaters rewrite
      // `visible` every frame, but never a mesh's layer mask (the camera and the shadow camera
      // both render layer 0 only).
      const masks = objs.map((o) => o.layers.mask);
      for (const o of objs) o.layers.disableAll();
      const m = await measure(90);
      objs.forEach((o, i) => (o.layers.mask = masks[i]));
      rows.push({ cut: `hide ${key} (${objs.length})`, ref, ...m });
    }
    // Switches.
    const sw = async (label, on, off) => {
      const ref = await measure(90);
      on();
      const m = await measure(90);
      off();
      rows.push({ cut: label, ref, ...m });
    };
    const lights = [];
    g.scene.traverse((o) => o.isLight && o.castShadow && lights.push(o));
    await sw(
      'no shadows',
      () => {
        r.shadowMap.enabled = false;
        lights.forEach((l) => (l.castShadow = false));
      },
      () => {
        r.shadowMap.enabled = true;
        lights.forEach((l) => (l.castShadow = true));
      },
    );
    await sw(
      'shadow map frozen (no shadow pass, still sampled)',
      () => (r.shadowMap.autoUpdate = false),
      () => (r.shadowMap.autoUpdate = true),
    );
    // Empty shadow pass, persistent: the per-frame foliage/hero LOD updaters write `castShadow`
    // every frame (near trees back to true), so toggling it once lasts one frame. three (0.186)
    // tests the shadow pass against the *main* camera's layers (WebGLShadowMap.renderObject gets
    // the render camera), so a shadow-camera layer mask is ignored and a mesh layer cut would hide
    // the main pass too. Instead every non-light object's `castShadow` becomes an accessor that
    // reads false and records writes; restoring puts back the last value written.
    const casters = [];
    const patched = [];
    g.scene.traverse((o) => {
      if (o.isLight) return;
      if (o.castShadow) casters.push(o);
      patched.push(o);
    });
    await sw(
      `no shadow casters (${casters.length}; pass runs empty, still sampled)`,
      () =>
        patched.forEach((o) => {
          let wanted = o.castShadow;
          Object.defineProperty(o, 'castShadow', {
            configurable: true,
            get: () => false,
            set: (v) => {
              wanted = v;
            },
          });
          o.__wantedShadow = () => wanted;
        }),
      () =>
        patched.forEach((o) => {
          const wanted = o.__wantedShadow();
          delete o.__wantedShadow;
          delete o.castShadow;
          o.castShadow = wanted;
        }),
    );
    const setType = (t) => {
      r.shadowMap.type = t;
      lights.forEach((l) => {
        l.shadow.map?.dispose();
        l.shadow.map = null;
      });
      g.scene.traverse((o) => {
        const m = o.material;
        if (m) (Array.isArray(m) ? m : [m]).forEach((x) => (x.needsUpdate = true));
      });
      r.shadowMap.needsUpdate = true;
    };
    const type0 = r.shadowMap.type;
    await sw(
      'shadow filter: basic, 1 unfiltered tap (recompiles)',
      () => setType(0),
      () => setType(type0),
    );
    const vm = g.viewmodel?.group ?? g.viewmodel?.root;
    if (vm)
      await sw(
        'no viewmodel',
        () => (vm.visible = false),
        () => (vm.visible = true),
      );
    const pr = r.getPixelRatio();
    await sw(
      'pixel ratio × 0.5',
      () => {
        r.setPixelRatio(pr * 0.5);
        g.post?.setSize?.();
      },
      () => {
        r.setPixelRatio(pr);
        g.post?.setSize?.();
      },
    );
    await sw(
      'pixel ratio × 0.75',
      () => {
        r.setPixelRatio(pr * 0.75);
        g.post?.setSize?.();
      },
      () => {
        r.setPixelRatio(pr);
        g.post?.setSize?.();
      },
    );
    const again = await measure(200);
    return {
      base,
      again,
      rows,
      programs: r.info.programs.length,
      pr,
      size: [r.domElement.width, r.domElement.height],
    };
  },
  [DEPTH, arg('only', '').split(',').filter(Boolean)],
);
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const e = gl?.getExtension('WEBGL_debug_renderer_info');
  return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?';
});
const b = result.base;
console.log(`${QUALITY} · ${VIEW} · ${W}×${H} · ${gpu}`);
console.log(
  `base ${b.ms.toFixed(2)} ms (${(1000 / b.ms).toFixed(1)} fps uncapped), ${b.calls} calls, ${Math.round(b.tris / 1000)}k tris; re-measured ${result.again.ms.toFixed(2)} ms`,
);
for (const x of result.rows.sort((p, q) => q.ref.ms - q.ms - (p.ref.ms - p.ms)))
  console.log(
    `${x.cut.padEnd(58)} ${x.ref.ms.toFixed(2).padStart(6)} → ${x.ms.toFixed(2).padStart(6)} ms  saves ${(x.ref.ms - x.ms).toFixed(2).padStart(6)} ms  (${String(x.ref.calls - x.calls).padStart(4)} calls, ${String(Math.round((x.ref.tris - x.tris) / 1000)).padStart(5)}k tris)`,
  );
await browser.close();
