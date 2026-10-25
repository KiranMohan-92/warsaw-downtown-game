// Feature sweep (real GPU): plays every feature through the autotest hooks and asserts the outcome
// from game state (screenshots are evidence only). Each check prints PASS/FAIL with a reason; the
// run continues after failures, ends with a summary table and exits non-zero if anything failed.
//
// Needs the dev client (and, for the online part, a game server) running:
//   pnpm --filter @wd/client exec vite --port 5195 --strictPort
//   GAME_PORT=2625 pnpm --filter @wd/server dev
//   node tools/feature-sweep.mjs              NVIDIA (--force_high_performance_gpu), offline + online
//   node tools/feature-sweep.mjs --igpu       default (Intel) GPU, boot + basics only
//   flags: --offline (skip online), --online-only, --basic (boot + basics), --only=<substring>
//   env:   WD_URL (http://localhost:5195), WD_SERVER (127.0.0.1:2625), WD_OUT (screenshot dir)
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { Button as B } from '../packages/shared/src/sim/input.ts';
import {
  ARC,
  DUMMY,
  GRENADE,
  JAMMER,
  KNIFE,
  KNIFE_DEFENSE,
  MATCH,
  MEDKIT,
  MOVEMENT,
  PLAYER,
  PLAYER_COLLISION,
  PRIMARIES,
  PRIMARY_IDS,
  PRONE,
  SIDEARM,
  SKATEBOARD,
  SLIDE,
  SMOKE,
  SPAWN_PROTECTION,
} from '../packages/shared/src/config/tunables.ts';

const argv = process.argv.slice(2);
const IGPU = argv.includes('--igpu');
const BASIC = IGPU || argv.includes('--basic');
const OFFLINE = !argv.includes('--online-only');
const ONLINE = !argv.includes('--offline') && !BASIC;
const ONLY = argv.find((a) => a.startsWith('--only='))?.slice(7) ?? null;
const URL = process.env.WD_URL ?? 'http://localhost:5195';
const SERVER = process.env.WD_SERVER ?? '127.0.0.1:2625';
const OUT = process.env.WD_OUT ?? join(tmpdir(), 'wd-feature-sweep');
const GPU = IGPU ? 'intel' : 'nvidia';
mkdirSync(OUT, { recursive: true });
// Keep disk use small: only this run's screenshots for this GPU stay.
for (const f of readdirSync(OUT))
  if (f.startsWith(`${GPU}-`) && f.endsWith('.jpg')) rmSync(join(OUT, f));

const SETTINGS = {
  map: 'defilad',
  mapSize: 'market',
  quality: 'medium',
  weather: 'sunny',
  dynamicResolution: false,
  sparring: false,
  primary: 'ar7',
  online: false,
};
/** Which third-person weapon each practice dummy shows (render/dummyView.ts DUMMY_WEAPONS). */
// Mirrors render/dummyView.ts DUMMY_WEAPONS (the knife third, so the range's six show it).
const DUMMY_WEAPONS = ['rifle', 'shotgun', 'knife', 'marksman', 'pistol', 'coil', 'iskra', 'arc'];
/** Viewmodel scan id per primary (render/viewGunScans.ts PRIMARY_SCANS). */
const SCAN_OF = {
  ar7: 'rifle',
  coil: 'coil',
  iskra: 'iskra',
  shotgun: 'shotgun',
  marksman: 'marksman',
  arc: 'arc',
};

// ---------------------------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------------------------

const results = [];
let page = null;
let pageErrors = [];
/** Checks the --only filter actually selected (setup steps run anyway and don't count). */
let onlyMatched = 0;
/** True while the offline section runs: the dev client's optional server pings may fail there. */
let offlinePhase = false;

/** A step's result that is not a failure but worth a look (frame timing: the GPU is shared). */
class Warn {
  constructor(text) {
    this.text = text;
  }
}

class Checks {
  constructor() {
    this.fails = [];
    this.warns = [];
    this.notes = [];
  }
  ok(cond, msg) {
    if (!cond) this.fails.push(msg);
    return !!cond;
  }
  /** Timing-only expectation: reported as WARN (never fails the run). */
  soft(cond, msg) {
    if (!cond) this.warns.push(msg);
    return !!cond;
  }
  note(msg) {
    this.notes.push(msg);
  }
  done() {
    if (this.fails.length) throw new Error(`${this.fails.join('; ')} [${this.notes.join(', ')}]`);
    if (this.warns.length) return new Warn(`${this.warns.join('; ')} [${this.notes.join(', ')}]`);
    return this.notes.join(', ');
  }
}

/** The leading integer of a HUD readout ("29 / 90" → 29). */
const leadNum = (t) => Number(/^\s*(\d+)/.exec(t ?? '')?.[1] ?? NaN);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : String(n));

async function shot(name) {
  if (!page) return null;
  const path = join(OUT, `${GPU}-${slug(name)}.jpg`);
  await page.screenshot({ path, type: 'jpeg', quality: 70 });
  return path;
}

function withTimeout(p, ms, name) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`timed out after ${ms} ms (${name})`)), ms);
    }),
  ]);
}

const programs = () =>
  page ? page.evaluate(() => window.__wdGame?.renderer.info.programs?.length ?? -1) : -1;

/** Live shader program ids + names, and frame hitches (> HITCH_MS) since the page loaded. */
const HITCH_MS = 150;
const pageProbe = () =>
  page
    ? page
        .evaluate(() => ({
          names: window.__fs?.programNames?.() ?? [],
          now: performance.now(),
          hitches: window.__fsHitches ?? [],
        }))
        .catch(() => ({ names: [], now: 0, hitches: [] }))
    : { names: [], now: 0, hitches: [] };

async function step(section, name, fn, { timeout = 90_000, skip = null, always = false } = {}) {
  const full = `${section} › ${name}`;
  const selected = !ONLY || full.toLowerCase().includes(ONLY.toLowerCase());
  if (!selected && !always) return;
  if (ONLY && selected) onlyMatched++;
  if (skip) {
    results.push({ section, name, status: 'SKIP', reason: skip, ms: 0, programs: -1 });
    console.log(`SKIP ${full} — ${skip}`);
    return;
  }
  const t0 = Date.now();
  const before = pageErrors.length;
  const probe0 = await pageProbe();
  let status = 'PASS';
  let reason;
  try {
    reason = (await withTimeout(Promise.resolve().then(fn), timeout, full)) ?? '';
    if (reason instanceof Warn) {
      status = 'WARN';
      reason = reason.text;
    }
  } catch (e) {
    status = 'FAIL';
    reason = e instanceof Error ? e.message : String(e);
  }
  const fresh = pageErrors.slice(before);
  if (fresh.length) {
    status = 'FAIL';
    reason += ` | page/console errors: ${fresh.slice(0, 3).join(' / ')}`;
  }
  let shotPath = '';
  if (status === 'FAIL') shotPath = (await shot(`fail-${full}`).catch(() => null)) ?? '';
  const progs = await programs().catch(() => -1);
  const probe1 = await pageProbe();
  // Programs linked during this step (a first-sight compile mid-game is a hitch).
  const compiled = probe0.names.length ? probe1.names.filter((n) => !probe0.names.includes(n)) : [];
  const hitches = probe1.hitches.filter((h) => h.t >= probe0.now);
  const info = [];
  if (compiled.length) info.push(`compiled ${compiled.length}: ${compiled.join(' ')}`);
  if (hitches.length) info.push(`hitches ${hitches.map((h) => `${Math.round(h.ms)}ms`).join(',')}`);
  // Leave every step with released controls.
  await page?.evaluate(() => window.__wd?.hold(0)).catch(() => {});
  const ms = Date.now() - t0;
  results.push({
    section,
    name,
    status,
    reason,
    ms,
    programs: progs,
    shot: shotPath,
    compiled,
    hitches,
  });
  console.log(
    `${status} ${full} — ${reason} (${ms} ms, programs ${progs}${info.length ? `; ${info.join('; ')}` : ''})`,
  );
}

// ---------------------------------------------------------------------------------------------
// Browser + in-page helpers
// ---------------------------------------------------------------------------------------------

const args = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
if (!IGPU) args.unshift('--force_high_performance_gpu');
const browser = await chromium.launch({ headless: true, args });

async function openPage() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  pageErrors = [];
  p.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Offline checks never need the game server, but the dev client still pings it (connectDev):
    // a refused connection to that server is expected there. Every other error still counts.
    const url = m.location()?.url ?? '';
    if (
      offlinePhase &&
      url.includes(SERVER.split(':').pop()) &&
      /ERR_CONNECTION_REFUSED|Failed to fetch/.test(m.text())
    )
      return;
    pageErrors.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  await p.addInitScript((s) => localStorage.setItem('wd.settings.v2', JSON.stringify(s)), SETTINGS);
  await p.addInitScript(() => {
    const raf = () => new Promise((r) => requestAnimationFrame(() => r()));
    const g = () => window.__wdGame;
    // Frame-time monitor: every frame longer than 150 ms once the game is up.
    window.__fsHitches = [];
    let last = -1;
    const mon = (t) => {
      if (last >= 0 && window.__wd?.ready && t - last > 150)
        window.__fsHitches.push({ t: last, ms: t - last });
      last = t;
      requestAnimationFrame(mon);
    };
    requestAnimationFrame(mon);
    window.__fs = {
      raf,
      g,
      async wait(ms) {
        const t0 = performance.now();
        while (performance.now() - t0 < ms) await raf();
      },
      async until(fn, ms = 5000) {
        const t0 = performance.now();
        for (;;) {
          let v;
          try {
            v = fn();
          } catch {
            v = false;
          }
          if (v) return { ok: true, t: performance.now() - t0, v };
          if (performance.now() - t0 > ms) return { ok: false, t: performance.now() - t0 };
          await raf();
        }
      },
      gun() {
        const p = g().player;
        const slot = p.arsenal.slot;
        return slot === 'knife' ? null : p.guns[slot];
      },
      dummy: (id) => g().dummies.find((d) => d.def.id === id),
      /** Frame the dummy from `dist` m with a clear line of sight to its chest and flat ground. */
      spotFacing(target, dist, eye = 1.62, aimY = 1.25) {
        const ph = g().physics;
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * Math.PI * 2;
          const x = target.x + Math.sin(a) * dist;
          const z = target.z + Math.cos(a) * dist;
          const down = ph.castRay({ x, y: target.y + 1.5, z }, { x: 0, y: -1, z: 0 }, 3);
          if (!down || Math.abs(down.point.y - target.y) > 0.15) continue;
          const feet = { x, y: down.point.y + 0.03, z };
          if (ph.overlapsStatic(feet, 1.8, 0.03)) continue;
          const from = { x, y: feet.y + eye, z };
          const to = { x: target.x, y: target.y + aimY, z: target.z };
          const d = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
          const len = Math.hypot(d.x, d.y, d.z);
          const hit = ph.castRay(from, { x: d.x / len, y: d.y / len, z: d.z / len }, len);
          if (hit && hit.distance < len - 0.4) continue;
          const yaw = Math.atan2(-(to.x - x), -(to.z - z));
          const pitch = Math.atan2(to.y - from.y, Math.hypot(to.x - x, to.z - z));
          return { x, y: feet.y, z, yaw, pitch };
        }
        return null;
      },
      /** Longest open straight line from a few plaza points (knee + chest rays). */
      lane() {
        const ph = g().physics;
        let best = null;
        for (const [x, z] of [
          [100, 0],
          [60, -2],
          [80, 10],
          [95, -20],
          [120, 0],
          [110, 12],
        ]) {
          if (ph.overlapsStatic({ x, y: 0.03, z }, 1.8, 0.03)) continue;
          for (let k = 0; k < 24; k++) {
            const yaw = (k / 24) * Math.PI * 2;
            const d = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
            let len = 60;
            for (const y of [0.3, 1.0, 1.7]) {
              const hit = ph.castRay({ x, y, z }, d, 60);
              if (hit) len = Math.min(len, hit.distance);
            }
            if (!best || len > best.len) best = { x, z, yaw, len };
          }
        }
        return best;
      },
      setSetting(key, value) {
        const el = document.querySelector(`[data-key="${key}"]`);
        if (!el) return false;
        if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!value;
        else el.value = String(value);
        el.dispatchEvent(new Event('input'));
        return true;
      },
      animator(slot) {
        const vm = g().viewmodel;
        return vm.animators.get(vm.guns[slot]) ?? null;
      },
      /** Moving-part + arm-bone pose of a viewmodel gun (to see that a clip really moves it). */
      poseSig(slot) {
        const a = window.__fs.animator(slot);
        if (!a) return [];
        const vm = g().viewmodel;
        // The whole gun (clips key its camera-space offset), its moving parts, the arm bones.
        const out = [...vm.gun.matrix.elements, ...vm.guns[slot].group.matrix.elements];
        for (const part of a.rig.parts.values()) out.push(...part.mesh.matrix.elements);
        a.rig.arms?.bones?.forEach((b) => out.push(...b.matrix.elements));
        return out;
      },
      /** Live shader programs by material name (to name what a step compiled). */
      programNames() {
        return (g().renderer.info.programs ?? []).map((p) => `${p.name}#${p.id}`);
      },
      sigDiff(a, b) {
        let m = 0;
        for (let i = 0; i < Math.min(a.length, b.length); i++)
          m = Math.max(m, Math.abs(a[i] - b[i]));
        return m;
      },
    };
  });
  return p;
}

async function boot(query) {
  const t0 = Date.now();
  await page.goto(`${URL}/?autotest&${query}`);
  await page.waitForFunction('window.__wd?.ready === true && !!window.__wdGame', undefined, {
    timeout: 240_000,
  });
  await page.evaluate(() => window.__wd.hold(0));
  return Date.now() - t0;
}

const ev = (fn, arg) => page.evaluate(fn, arg);
const tap = (b) => ev((x) => window.__wd.tap(x), b);
const hold = (b, mx = 0, mz = 0) => ev(([x, y, z]) => window.__wd.hold(x, y, z), [b, mx, mz]);
const wait = (ms) => ev((t) => window.__fs.wait(t), ms);
const teleport = (p, yaw, pitch = 0) =>
  ev(([q, y, pt]) => window.__wd.teleport(q.x, q.y + 0.03, q.z, y, pt), [p, yaw, pitch]);
const until = async (src, ms = 5000) => {
  // `src` is an expression over g (game), fs (helpers), s (__wd.state())
  const r = await ev(
    ([code, t]) =>
      window.__fs.until(
        new Function('g', 'fs', `return (${code});`).bind(null, window.__wdGame, window.__fs),
        t,
      ),
    [src, ms],
  );
  return r;
};
const setSetting = (k, v) => ev(([a, b]) => window.__fs.setSetting(a, b), [k, v]);

/** Mean/std luminance of the composited page (what a player sees), from a JPEG screenshot. */
async function luminance(name) {
  const path = join(OUT, `${GPU}-${slug(name)}.jpg`);
  const buf = await page.screenshot({ path, type: 'jpeg', quality: 70 });
  const r = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const x = c.getContext('2d');
    x.drawImage(bmp, 0, 0);
    const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) {
      const l = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      s += l;
      s2 += l * l;
      n++;
    }
    const m = s / n;
    return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)) };
  }, buf.toString('base64'));
  return { ...r, path };
}

/** NaN/Inf count in the HDR scene buffer (the first render pass only), as tools/_nv3.mjs. */
const hdrNaN = () =>
  ev(() => {
    const g = window.__wdGame;
    const comp = g.post.composer;
    const rt = comp.inputBuffer;
    const type = rt.texture.type;
    const w = rt.width;
    const h = rt.height;
    const half = (v) => {
      const s = v & 0x8000 ? -1 : 1;
      const e = (v >> 10) & 31;
      const f = v & 1023;
      if (e === 31) return f ? NaN : s * Infinity;
      return e ? s * 2 ** (e - 15) * (1 + f / 1024) : s * 2 ** -14 * (f / 1024);
    };
    const enabled = comp.passes.map((q) => q.enabled);
    comp.passes.forEach((q, i) => (q.enabled = i === 0));
    let nan = 0;
    let inf = 0;
    let max = 0;
    try {
      comp.render(0);
      if (type === 1016) {
        const buf = new Uint16Array(w * h * 4);
        g.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
        for (let i = 0; i < buf.length; i += 4)
          for (let k = 0; k < 3; k++) {
            const v = half(buf[i + k]);
            if (Number.isNaN(v)) nan++;
            else if (!Number.isFinite(v)) inf++;
            else max = Math.max(max, v);
          }
      } else if (type === 1015) {
        const buf = new Float32Array(w * h * 4);
        g.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
        for (let i = 0; i < buf.length; i += 4)
          for (let k = 0; k < 3; k++) {
            const v = buf[i + k];
            if (Number.isNaN(v)) nan++;
            else if (!Number.isFinite(v)) inf++;
            else max = Math.max(max, v);
          }
      } else return { type, skipped: true };
    } finally {
      comp.passes.forEach((q, i) => (q.enabled = enabled[i]));
    }
    return { type, w, h, nan, inf, max };
  });

// ---------------------------------------------------------------------------------------------
// Offline sweep
// ---------------------------------------------------------------------------------------------

let warmPrograms = -1;
let warmNames = [];
let lane = null;
const medkitClock = { id: null, at: 0 };

async function offline() {
  page = await openPage();
  const S = 'boot';
  let loadMs = 0;
  await step(
    S,
    'page ready',
    async () => {
      loadMs = await boot(`online=0&server=${SERVER}`);
      await wait(1500);
      await ev(() => (window.__fsHitches.length = 0)); // load-time frames don't count
      const g = await until('fs.g().player.move.grounded', 10_000);
      if (!g.ok) throw new Error('player never grounded');
      return `ready in ${(loadMs / 1000).toFixed(1)} s`;
    },
    { timeout: 260_000, always: true },
  );
  if (!(await ev(() => !!window.__wdGame).catch(() => false))) return;
  // Every movement/tactical step stands on this lane, whichever steps --only selects.
  lane = await ev(() => window.__fs.lane());

  await step(S, `renderer is ${IGPU ? 'Intel' : 'NVIDIA'}`, async () => {
    const r = await ev(() => {
      const gl = window.__wdGame.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return (ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER);
    });
    const want = IGPU ? /intel/i : /nvidia/i;
    if (!want.test(r)) throw new Error(`renderer "${r}"`);
    return r;
  });

  await step(S, 'no page errors / console errors at boot', async () => {
    await wait(2000);
    return `${pageErrors.length} errors`;
  });

  await step(S, '3D view not black (mean luminance)', async () => {
    const lane0 = await ev(() => window.__fs.lane());
    lane = lane0;
    await teleport({ x: lane0.x, y: 0, z: lane0.z }, lane0.yaw, 0);
    await wait(1200);
    const l = await luminance('boot-view');
    const c = new Checks();
    c.ok(l.mean > 0.08, `mean luminance ${fmt(l.mean, 3)} ≤ 0.08 (black?)`);
    c.ok(l.std > 0.03, `luminance std ${fmt(l.std, 3)} ≤ 0.03 (flat image)`);
    c.note(`mean ${fmt(l.mean, 3)} std ${fmt(l.std, 3)}`);
    c.note(l.path);
    return c.done();
  });

  await step(S, 'HDR scene NaN count is 0', async () => {
    const r = await hdrNaN();
    if (r.skipped) throw new Error(`scene buffer type ${r.type} not half/float`);
    if (r.nan || r.inf)
      throw new Error(`NaN ${r.nan}, Inf ${r.inf} in ${r.w}×${r.h} (max ${r.max})`);
    return `0 NaN / 0 Inf in ${r.w}×${r.h}, max ${fmt(r.max)}`;
  });

  await step(S, 'shader programs stable after warm-up (look + walk around)', async () => {
    const p0 = await programs();
    await ev(async () => {
      const fs = window.__fs;
      window.__wd.hold(0, 0, 1);
      for (let i = 0; i < 120; i++) {
        window.__wd.look(i * 0.055, Math.sin(i * 0.1) * 0.4);
        await fs.raf();
      }
      window.__wd.hold(0);
    });
    await wait(500);
    const p1 = await programs();
    warmPrograms = p1;
    warmNames = await ev(() => window.__fs.programNames());
    if (p1 !== p0) throw new Error(`programs ${p0} → ${p1} while looking around`);
    return `${p0} programs`;
  });

  // ------------------------------------------------------------------- movement
  const M = 'movement';
  const toLane = async () => {
    await teleport({ x: lane.x, y: 0, z: lane.z }, lane.yaw, 0);
    await until('fs.g().player.move.grounded', 2000);
    await wait(200);
  };
  const speedOver = (buttons, ms = 1500) =>
    ev(
      async ([b, t]) => {
        const fs = window.__fs;
        const g = fs.g();
        window.__wd.hold(b, 0, 1);
        await fs.wait(t - 500);
        const a = { ...g.player.move.pos };
        const seq0 = g.seq;
        await fs.wait(500);
        const p = g.player.move;
        // Sim time (steps × 1/60 s), not wall time: a slow frame must not skew the speed.
        const dt = (g.seq - seq0) / 60;
        const r = {
          speed: Math.hypot(p.pos.x - a.x, p.pos.z - a.z) / dt,
          sprinting: p.sprinting,
          crouched: p.crouched,
          eye: p.eyeHeight,
        };
        window.__wd.hold(0);
        return r;
      },
      [buttons, ms],
    );

  await step(M, 'open lane for movement tests', async () => {
    if (!lane) lane = await ev(() => window.__fs.lane());
    if (!lane || lane.len < 18) throw new Error(`longest open lane ${fmt(lane?.len)} m < 18 m`);
    return `(${fmt(lane.x, 1)}, ${fmt(lane.z, 1)}) yaw ${fmt(lane.yaw)} len ${fmt(lane.len, 1)} m`;
  });

  await step(M, `walk speed ≈ ${MOVEMENT.walkSpeed} m/s`, async () => {
    await toLane();
    const r = await speedOver(0);
    const want = MOVEMENT.walkSpeed;
    if (Math.abs(r.speed - want) > want * 0.1) throw new Error(`walk ${fmt(r.speed)} m/s`);
    return `${fmt(r.speed)} m/s`;
  });

  await step(M, `sprint speed ≈ ${MOVEMENT.sprintSpeed} m/s`, async () => {
    await toLane();
    const r = await speedOver(B.Sprint, 1800);
    const c = new Checks();
    c.ok(r.sprinting, 'not sprinting while holding Sprint + forward');
    c.ok(
      Math.abs(r.speed - MOVEMENT.sprintSpeed) < MOVEMENT.sprintSpeed * 0.1,
      `sprint ${fmt(r.speed)} m/s`,
    );
    c.note(`${fmt(r.speed)} m/s`);
    return c.done();
  });

  await step(
    M,
    `crouch (eye ${PLAYER.crouchEyeHeight} m, ${MOVEMENT.crouchSpeed} m/s)`,
    async () => {
      await toLane();
      const r = await speedOver(B.Crouch);
      const c = new Checks();
      c.ok(r.crouched, 'not crouched while holding Crouch');
      c.ok(Math.abs(r.eye - PLAYER.crouchEyeHeight) < 0.05, `crouched eye ${fmt(r.eye)}`);
      c.ok(
        Math.abs(r.speed - MOVEMENT.crouchSpeed) < MOVEMENT.crouchSpeed * 0.12,
        `crouch walk ${fmt(r.speed)} m/s`,
      );
      const up = await until(
        `Math.abs(fs.g().player.move.eyeHeight - ${PLAYER.standEyeHeight}) < 0.02`,
        1500,
      );
      c.ok(up.ok, 'eye did not return to standing after releasing Crouch');
      c.note(`eye ${fmt(r.eye)} m, ${fmt(r.speed)} m/s`);
      return c.done();
    },
  );

  await step(M, `jump height ≈ ${MOVEMENT.jumpHeight} m`, async () => {
    await toLane();
    const r = await ev(async (jump) => {
      const fs = window.__fs;
      const m = () => fs.g().player.move;
      const y0 = m().pos.y;
      window.__wd.tap(jump);
      let max = y0;
      let airborne = false;
      // Until it lands again, not a fixed wall window: on a slow GPU Game.frame() caps catch-up
      // steps, so 1.5 s of wall clock can be well under 1.5 s of simulation.
      const t0 = performance.now();
      while (performance.now() - t0 < 10_000) {
        max = Math.max(max, m().pos.y);
        if (!m().grounded) airborne = true;
        else if (airborne || performance.now() - t0 > 1500) break;
        await fs.raf();
      }
      for (let i = 0; i < 10; i++) await fs.raf(); // settle on the ground
      const wall = performance.now() - t0;
      return { rise: max - y0, airborne, landed: m().grounded, dy: m().pos.y - y0, wall };
    }, B.Jump);
    const c = new Checks();
    c.ok(r.airborne, 'never left the ground');
    c.ok(Math.abs(r.rise - MOVEMENT.jumpHeight) < 0.12, `rise ${fmt(r.rise)} m`);
    c.ok(r.landed && Math.abs(r.dy) < 0.05, `did not land back (dy ${fmt(r.dy)})`);
    c.soft(r.wall < 2500, `jump took ${fmt(r.wall / 1000)} s wall clock (slow frames)`);
    c.note(`rise ${fmt(r.rise)} m`);
    return c.done();
  });

  await step(
    M,
    'slide: Crouch on a sprint slides, then low run; Jump cancels; cooldown',
    async () => {
      await toLane();
      const r = await ev(
        async ([sprint, crouch, jump]) => {
          const fs = window.__fs;
          const m = () => fs.g().player.move;
          const hs = () => Math.hypot(m().vel.x, m().vel.z);
          window.__wd.hold(sprint, 0, 1);
          await fs.wait(1300);
          const entry = hs();
          window.__wd.hold(sprint | crouch, 0, 1);
          await fs.wait(150);
          const mid = { sliding: m().sliding, speed: hs(), eye: m().eyeHeight };
          let peak = mid.speed;
          const t0 = performance.now();
          while (m().sliding && performance.now() - t0 < 3000) {
            peak = Math.max(peak, hs());
            await fs.raf();
          }
          const ms = performance.now() - t0;
          await fs.wait(200); // the stance settles into the low run a few steps after the slide ends
          const after = { sliding: m().sliding, lowRun: m().lowRun, ms };
          // Straight away again: the cooldown refuses it.
          window.__wd.hold(sprint, 0, 1);
          await fs.wait(80);
          window.__wd.hold(sprint | crouch, 0, 1);
          await fs.wait(120);
          const chained = m().sliding;
          // After the cooldown: slide, then Jump cancels it.
          window.__wd.hold(sprint, 0, 1);
          await fs.wait(1500);
          window.__wd.hold(sprint | crouch, 0, 1);
          await fs.wait(150);
          const second = m().sliding;
          window.__wd.tap(jump);
          await fs.wait(120);
          const cancelled = { sliding: m().sliding, grounded: m().grounded };
          window.__wd.hold(0);
          return { entry, mid, peak, after, chained, second, cancelled };
        },
        [B.Sprint, B.Crouch, B.Jump],
      );
      const c = new Checks();
      c.ok(r.mid.sliding, 'Crouch on a sprint did not start a slide');
      c.ok(
        r.peak > r.entry * 1.05,
        `no launch boost (entry ${fmt(r.entry)}, peak ${fmt(r.peak)} m/s)`,
      );
      c.ok(Math.abs(r.mid.eye - SLIDE.eyeHeight) < 0.12, `slide eye ${fmt(r.mid.eye)} m`);
      c.ok(!r.after.sliding, 'slide never ended');
      c.ok(r.after.lowRun, 'Sprint + Crouch still held after the slide is not a low run');
      c.ok(!r.chained, 'a second slide started inside the cooldown');
      c.ok(r.second, 'no slide after the cooldown');
      c.ok(
        !r.cancelled.sliding && !r.cancelled.grounded,
        'Jump did not cancel the slide into a jump',
      );
      c.soft(
        r.after.ms < SLIDE.maxTime * 1000 + 400,
        `slide lasted ${fmt(r.after.ms / 1000)} s wall clock`,
      );
      c.note(`entry ${fmt(r.entry)} → peak ${fmt(r.peak)} m/s, eye ${fmt(r.mid.eye)} m`);
      return c.done();
    },
  );

  await step(M, 'prone: enter, crawl, HUD chip, get up', async () => {
    await toLane();
    const c = new Checks();
    await tap(B.Prone);
    const down = await until(
      `fs.g().player.move.prone && fs.g().player.move.eyeHeight < ${PLAYER.proneEyeHeight + 0.03}`,
      2500,
    );
    c.ok(down.ok, 'Prone tap did not lay the player down (prone + eye 0.35)');
    const chip = await ev(() =>
      document.querySelector('[data-testid=status-prone]')?.classList.contains('on'),
    );
    c.ok(chip, 'HUD PRONE chip not on');
    await shot('prone');
    const r = await speedOver(0, 2000);
    c.ok(
      Math.abs(r.speed - PRONE.crawlSpeed) < 0.25,
      `crawl ${fmt(r.speed)} m/s (want ${PRONE.crawlSpeed})`,
    );
    const still = await ev(() => window.__wdGame.player.move.prone);
    c.ok(still, 'crawling stood the player up');
    await tap(B.Prone);
    const up = await until(
      `!fs.g().player.move.prone && fs.g().player.move.eyeHeight > 1.55`,
      3000,
    );
    c.ok(up.ok, 'Prone tap did not stand the player back up');
    const off = await ev(
      () => !document.querySelector('[data-testid=status-prone]')?.classList.contains('on'),
    );
    c.ok(off, 'HUD PRONE chip stuck on after standing');
    c.note(
      `down in ${fmt(down.t / 1000)} s, crawl ${fmt(r.speed)} m/s, up in ${fmt(up.t / 1000)} s`,
    );
    return c.done();
  });

  await step(M, 'climb (mantle) onto a ledge', async () => {
    const cands = await ev(() => {
      const g = window.__wdGame;
      const ph = g.physics;
      const out = [];
      for (const b of g.map.boxes) {
        if (b.collide === false) continue;
        if (b.rot && (Math.abs(b.rot.x) > 0.01 || Math.abs(b.rot.z) > 0.01)) continue;
        const bottom = b.center.y - b.size.y / 2;
        if (Math.abs(bottom) > 0.1 || b.size.y < 1.0 || b.size.y > 2.1) continue;
        if (Math.min(b.size.x, b.size.z) < 1.2) continue;
        if (Math.hypot(b.center.x - 100, b.center.z) > 70) continue;
        const ry = b.rot?.y ?? 0;
        for (const [lx, lz, half] of [
          [1, 0, b.size.x / 2],
          [-1, 0, b.size.x / 2],
          [0, 1, b.size.z / 2],
          [0, -1, b.size.z / 2],
        ]) {
          const dx = lx * Math.cos(ry) + lz * Math.sin(ry);
          const dz = -lx * Math.sin(ry) + lz * Math.cos(ry);
          const x = b.center.x + dx * (half + 0.55);
          const z = b.center.z + dz * (half + 0.55);
          const down = ph.castRay({ x, y: 1.0, z }, { x: 0, y: -1, z: 0 }, 2);
          if (!down || Math.abs(down.point.y) > 0.12) continue;
          const feet = { x, y: down.point.y + 0.03, z };
          if (ph.overlapsStatic(feet, 1.8, 0.03)) continue;
          const face = ph.castRay({ x, y: feet.y + 0.35, z }, { x: -dx, y: 0, z: -dz }, 1.2);
          if (!face || face.distance > 0.9) continue;
          const topY = b.center.y + b.size.y / 2;
          const onTop = { x: x - dx * 1.2, y: topY + 0.03, z: z - dz * 1.2 };
          if (ph.overlapsStatic(onTop, 1.8, 0.03)) continue;
          out.push({ x, y: feet.y, z, yaw: Math.atan2(dx, dz), top: topY, mat: b.mat });
          break;
        }
        if (out.length >= 8) break;
      }
      return out;
    });
    if (!cands.length) throw new Error('probe found no 1.0–2.1 m box to climb in the Market');
    const tries = [];
    for (const cnd of cands) {
      await teleport(cnd, cnd.yaw, 0);
      await until('fs.g().player.move.grounded', 1500);
      await wait(250);
      const r = await ev(async (jump) => {
        const fs = window.__fs;
        const m = () => fs.g().player.move;
        window.__wd.hold(jump, 0, 1);
        let kind = null;
        const t0 = performance.now();
        while (performance.now() - t0 < 1400) {
          if (m().traversal) kind = m().traversal.kind;
          await fs.raf();
        }
        window.__wd.hold(0);
        await fs.wait(300);
        return { kind, y: m().pos.y, grounded: m().grounded };
      }, B.Jump);
      tries.push(`${cnd.mat}@${fmt(cnd.top)}: ${r.kind ?? 'none'} y=${fmt(r.y)}`);
      if (r.kind && r.y > cnd.top - 0.15 && r.grounded) {
        await shot('climb');
        return `${r.kind} onto ${cnd.mat} top ${fmt(cnd.top)} m at (${fmt(cnd.x, 1)}, ${fmt(cnd.z, 1)})`;
      }
    }
    throw new Error(`no mantle succeeded: ${tries.join(' | ')}`);
  });

  await step(M, 'fall from 8 m: lands, no fall damage (none in the sim by design)', async () => {
    await ev(() => (window.__wdGame.player.health = 100));
    await teleport({ x: lane.x, y: 8, z: lane.z }, lane.yaw, 0);
    const land = await until('fs.g().player.move.grounded && fs.g().player.move.pos.y < 0.3', 4000);
    const hp = await ev(() => window.__wdGame.player.health);
    const c = new Checks();
    c.ok(land.ok, 'never landed');
    c.ok(hp === 100, `health ${hp} after the drop`);
    c.note(`landed in ${fmt(land.t / 1000)} s, health ${hp}`);
    return c.done();
  });

  // ------------------------------------------------------------------- weapons
  const W = 'weapons';
  const TARGET = 'pd1';
  // Dummies only reset on death: wait for it to be up, then top it up (test setup).
  const aliveDummy = async () => {
    await until(`fs.dummy('${TARGET}').health > 0`, 4000);
    await ev(([id, hp]) => (window.__fs.dummy(id).health = hp), [TARGET, DUMMY.maxHealth]);
  };
  /** Stand `dist` m from the dummy, facing its chest, with gun `slot` out and ready. */
  const frame = async (dist, slot = 'rifle') => {
    await aliveDummy();
    const spot = await ev(
      ([id, d]) => window.__fs.spotFacing(window.__fs.dummy(id).pos, d),
      [TARGET, dist],
    );
    if (!spot) throw new Error(`no clear firing spot ${dist} m from ${TARGET}`);
    await teleport(spot, spot.yaw, spot.pitch);
    await until(
      `fs.g().player.move.grounded && fs.g().player.arsenal.slot === '${slot}' && fs.g().player.arsenal.switchTimer <= 0`,
      3000,
    );
    await ev(([y, p]) => window.__wd.look(y, p), [spot.yaw, spot.pitch]);
    await wait(150);
    return spot;
  };
  /** Fire (hold `ms`, or one tap) and watch ammo/heat/dummy health each frame. */
  const fire = (mode, ms, ads = false) =>
    ev(
      async ([md, t, id, fireBit, adsBit]) => {
        const fs = window.__fs;
        const g = fs.g();
        if (adsBit) {
          window.__wd.hold(adsBit);
          await fs.until(() => fs.gun().adsAmount > 0.97, 1500);
        }
        const w0 = fs.gun();
        const d = fs.dummy(id);
        const r = {
          ammo0: w0.ammo,
          heat0: w0.heat,
          hits0: g.stats.hits,
          kills0: g.stats.kills,
          minHp: d.health,
          hp0: d.health,
          maxHeat: w0.heat,
          overheatSeen: false,
          maxCharge: 0,
          firstShotMs: null,
          shots0: w0.shotCounter,
        };
        const t0 = performance.now();
        if (md === 'hold') window.__wd.hold(fireBit | adsBit);
        else window.__wd.tap(fireBit);
        while (performance.now() - t0 < t) {
          const w = fs.gun();
          r.minHp = Math.min(r.minHp, d.health);
          r.maxHeat = Math.max(r.maxHeat, w.heat);
          r.maxCharge = Math.max(r.maxCharge, w.charge);
          if (w.overheat > 0) r.overheatSeen = true;
          if (r.firstShotMs === null && w.shotCounter !== r.shots0)
            r.firstShotMs = performance.now() - t0;
          await fs.raf();
        }
        window.__wd.hold(0);
        await fs.wait(120);
        const w = fs.gun();
        r.minHp = Math.min(r.minHp, d.health);
        r.ammo = w.ammo;
        r.heat = w.heat;
        r.shots = w.shotCounter - r.shots0;
        r.hits = g.stats.hits - r.hits0;
        r.kills = g.stats.kills - r.kills0;
        return r;
      },
      [mode, ms, TARGET, B.Fire, ads ? B.Ads : 0],
    );
  /** Tap Reload, check the FP clip moves the gun, and time the refill. */
  const reload = (slot, mag) =>
    ev(
      async ([sl, m, rel]) => {
        const fs = window.__fs;
        await fs.wait(900); // let a post-shot pump / recoil settle
        const before = fs.poseSig(sl);
        const t0 = performance.now();
        window.__wd.tap(rel);
        let started = null;
        let seq0 = 0;
        let maxFrame = 0;
        let lastT = performance.now();
        let kind = null;
        let moved = 0;
        let hudBar = false;
        for (;;) {
          const w = fs.gun();
          if (!w) return { error: 'gun left the hand during reload' };
          if (started === null && w.reloadTimer > 0) {
            started = performance.now() - t0;
            seq0 = fs.g().seq;
          }
          const tn = performance.now();
          maxFrame = Math.max(maxFrame, tn - lastT);
          lastT = tn;
          const a = fs.animator(sl);
          if (a?.kind) kind ??= a.kind;
          moved = Math.max(moved, fs.sigDiff(before, fs.poseSig(sl)));
          const bar = document.querySelector('.reload-bar');
          if (bar && Number(bar.style.opacity) > 0.5) hudBar = true;
          if (w.ammo === m && w.reloadTimer <= 0) break;
          if (performance.now() - t0 > 6000)
            return { error: `ammo ${w.ammo} after 6 s`, kind, moved };
          await fs.raf();
        }
        return {
          ms: performance.now() - t0 - (started ?? 0),
          simS: (fs.g().seq - seq0) / 60,
          maxFrame,
          startedMs: started,
          kind,
          moved,
          hudBar,
          dur: fs.gun().reloadDuration,
        };
      },
      [slot, mag, B.Reload],
    );
  const hudAmmo = () => ev(() => document.querySelector('[data-testid=ammo]')?.textContent ?? '');

  for (const id of BASIC ? ['ar7'] : PRIMARY_IDS) {
    const cfg = PRIMARIES[id];
    // `always`: the weapon's later checks need this loadout even when --only selects just one.
    await step(
      W,
      `${id}: loadout + respawn equips it (viewmodel ${SCAN_OF[id]})`,
      async () => {
        const set = await setSetting('primary', id);
        if (!set) throw new Error('no [data-key=primary] settings control');
        await ev(() => window.__wdGame.respawn());
        await until(`fs.g().player.arsenal.primary === '${id}'`, 2000);
        const r = await ev(async (p) => {
          const g = window.__wdGame;
          await window.__fs.wait(700);
          const vm = g.viewmodel;
          return {
            primary: g.player.arsenal.primary,
            slot: g.player.arsenal.slot,
            vmShown: vm.guns.rifle === vm.primaries[p],
            visible: vm.guns.rifle.group.visible,
            rig: window.__fs.animator('rifle')?.rig.id ?? null,
            ammo: window.__fs.gun()?.ammo,
          };
        }, id);
        const c = new Checks();
        c.ok(r.primary === id, `arsenal primary ${r.primary}`);
        c.ok(r.slot === 'rifle', `slot ${r.slot}`);
        c.ok(
          r.vmShown && r.visible,
          `viewmodel not showing ${id} (shown=${r.vmShown}, visible=${r.visible})`,
        );
        c.ok(r.rig === SCAN_OF[id], `viewmodel rig ${r.rig}`);
        c.ok(r.ammo === cfg.magazineSize, `ammo ${r.ammo} ≠ magazine ${cfg.magazineSize}`);
        c.note(`${cfg.name}, ${r.ammo} rds, rig ${r.rig}`);
        return c.done();
      },
      { always: true },
    );

    if (id === 'coil') {
      await step(W, 'coil: a tap does not fire; hold charges then fires', async () => {
        await frame(10);
        const t = await fire('tap', 600, true);
        const h = await fire('hold', 900, true);
        const c = new Checks();
        c.ok(t.shots === 0 && t.ammo === t.ammo0, `a one-step tap fired (${t.shots} shots)`);
        c.ok(h.maxCharge > 0, 'charge never rose while holding');
        c.ok(h.firstShotMs !== null, 'no shot while holding 0.9 s');
        c.ok(
          h.firstShotMs === null || h.firstShotMs >= cfg.chargeTime * 1000 - 20,
          `fired after ${fmt(h.firstShotMs, 0)} ms < charge ${cfg.chargeTime * 1000} ms`,
        );
        c.ok(h.ammo < h.ammo0, `ammo ${h.ammo0} → ${h.ammo}`);
        c.ok(h.minHp < h.hp0 || h.kills > 0, `dummy HP ${h.hp0} → min ${h.minHp}`);
        c.note(
          `first shot at ${fmt(h.firstShotMs, 0)} ms, dummy ${h.hp0}→${h.minHp}, ammo ${h.ammo0}→${h.ammo}`,
        );
        return c.done();
      });
    }

    if (cfg.scope) {
      await step(W, `${id}: ADS → full aim + scope overlay`, async () => {
        await frame(10);
        await hold(B.Ads);
        const r = await until(
          `fs.gun().adsAmount > 0.97 && document.querySelector('[data-testid=scope]').classList.contains('show')`,
          2000,
        );
        const ads = await ev(() => window.__fs.gun().adsAmount);
        const p = await shot(`${id}-scope`);
        await hold(0);
        const off = await until(
          `!document.querySelector('[data-testid=scope]').classList.contains('show')`,
          1500,
        );
        const c = new Checks();
        c.ok(r.ok, `ads ${fmt(ads)}, scope overlay not shown`);
        c.ok(off.ok, 'scope overlay stuck after releasing ADS');
        c.note(`ads ${fmt(ads)} in ${fmt(r.t, 0)} ms`);
        c.note(p);
        return c.done();
      });
    }

    if (id === 'arc') {
      await step(
        W,
        'arc: heat rises, no ammo spent, overheat lockout, HUD heat readout, vent clip',
        async () => {
          await frame(10);
          const r = await ev(
            async ([fireBit, lockout]) => {
              const fs = window.__fs;
              const g = fs.g();
              const d = fs.dummy('pd1');
              const w0 = fs.gun();
              const out = {
                ammo0: w0.ammo,
                hp0: d.health,
                minHp: d.health,
                hits0: g.stats.hits,
                maxHeat: 0,
                overAt: null,
                shotsInLock: 0,
                hudHeat: false,
                hudOver: false,
                hudText: '',
                vent: false,
              };
              window.__wd.hold(fireBit);
              const t0 = performance.now();
              let lockShots = null;
              while (performance.now() - t0 < 4500) {
                const w = fs.gun();
                out.maxHeat = Math.max(out.maxHeat, w.heat);
                out.minHp = Math.min(out.minHp, d.health);
                const box = document.querySelector('.ammo-box');
                if (box?.classList.contains('heat')) out.hudHeat = true;
                if (w.overheat > 0) {
                  if (out.overAt === null) {
                    out.overAt = performance.now() - t0;
                    lockShots = w.shotCounter;
                  }
                  if (w.overheat < lockout - 0.3) out.shotsInLock = w.shotCounter - lockShots;
                  if (box?.classList.contains('overheated')) out.hudOver = true;
                  out.hudText = document.querySelector('[data-testid=ammo]')?.textContent ?? '';
                  if (fs.animator('rifle')?.kind === 'vent') out.vent = true;
                }
                await fs.raf();
              }
              window.__wd.hold(0);
              out.ammo = fs.gun().ammo;
              out.hits = g.stats.hits - out.hits0;
              const cool = await fs.until(
                () => fs.gun().heat < 0.3 && fs.gun().overheat <= 0,
                5000,
              );
              out.cooled = cool.ok;
              out.coolMs = cool.t;
              return out;
            },
            [B.Fire, ARC.heat.lockout],
          );
          await shot('arc-overheat');
          const c = new Checks();
          c.ok(r.maxHeat > 0.9, `max heat ${fmt(r.maxHeat)}`);
          c.ok(r.ammo === r.ammo0, `ammo changed ${r.ammo0} → ${r.ammo} (energy gun)`);
          c.ok(r.overAt !== null, 'never overheated in 4.5 s of fire');
          c.ok(r.shotsInLock === 0, `${r.shotsInLock} shots fired during the lockout`);
          c.ok(
            r.hits > 0 && r.minHp < r.hp0,
            `dummy not damaged (hits ${r.hits}, HP ${r.hp0} → ${r.minHp})`,
          );
          c.ok(r.hudHeat, 'HUD ammo box never switched to the heat readout');
          c.ok(r.hudOver, 'HUD never showed OVERHEATED');
          c.ok(/HEAT/.test(r.hudText), `HUD text "${r.hudText}"`);
          c.ok(r.vent, 'FP vent clip did not play during the lockout');
          c.ok(r.cooled, 'heat did not cool below 0.3 within 5 s');
          c.note(
            `overheat at ${fmt(r.overAt / 1000)} s, hits ${r.hits}, cooled in ${fmt(r.coolMs / 1000)} s, HUD "${r.hudText.trim()}"`,
          );
          return c.done();
        },
      );
      continue;
    }

    if (id !== 'coil') {
      await step(W, `${id}: fire at a dummy → HP drops, ammo decreases`, async () => {
        const dist = id === 'shotgun' ? 4.5 : 9;
        await frame(dist);
        const semi = cfg.semiAuto || cfg.pellets > 1;
        const r = await fire(semi ? 'tap' : 'hold', semi ? 500 : 260, cfg.scope);
        const c = new Checks();
        c.ok(r.ammo < r.ammo0, `ammo ${r.ammo0} → ${r.ammo}`);
        c.ok(r.hits > 0, `no hits registered (${r.shots} shots)`);
        c.ok(r.minHp < r.hp0 || r.kills > 0, `dummy HP ${r.hp0} → min ${r.minHp}`);
        const hud = await hudAmmo();
        c.ok(leadNum(hud) === r.ammo, `HUD ammo "${hud}" ≠ ${r.ammo}`);
        if (cfg.pellets > 1) {
          const dmg = r.hp0 - r.minHp;
          const onePellet = cfg.damage * cfg.headMultiplier;
          c.ok(
            dmg > onePellet,
            `one pull did ${dmg} dmg ≤ one pellet max ${onePellet} (pellets not summed?)`,
          );
          c.note(`one pull ${dmg} dmg at ${dist} m (${cfg.pellets} pellets × ${cfg.damage})`);
        }
        c.note(
          `${r.shots} shots, ${r.hits} hits, dummy ${r.hp0}→${r.minHp}, ammo ${r.ammo0}→${r.ammo}, HUD "${hud.trim()}"`,
        );
        return c.done();
      });
    }

    await step(
      W,
      `${id}: reload refills after ${cfg.reloadTime} s + FP reload clip moves the gun`,
      async () => {
        const w = await ev(() => window.__fs.gun());
        if (w.ammo >= cfg.magazineSize) {
          await frame(9);
          await fire('hold', 400);
        }
        const r = await reload('rifle', cfg.magazineSize);
        if (r.error) throw new Error(`${r.error} (clip ${r.kind}, moved ${fmt(r.moved, 3)})`);
        const c = new Checks();
        c.ok(
          Math.abs(r.simS - r.dur) < 0.1,
          `refill after ${fmt(r.simS)} s of sim time vs duration ${r.dur}`,
        );
        c.soft(
          r.maxFrame < HITCH_MS,
          `${Math.round(r.maxFrame)} ms frame during the reload (wall ${fmt(r.ms / 1000)} s vs sim ${fmt(r.simS)} s)`,
        );
        c.ok(
          Math.abs(r.dur - cfg.reloadTime) < 1e-6,
          `duration ${r.dur} ≠ tunable reloadTime ${cfg.reloadTime} (tactical)`,
        );
        c.ok(r.kind === 'reload' || r.kind === 'reloadEmpty', `FP clip ${r.kind}`);
        c.ok(
          r.moved > 0.005,
          `viewmodel parts/arms did not move during reload (max Δ ${fmt(r.moved, 4)})`,
        );
        c.ok(r.hudBar, 'HUD reload bar never shown');
        c.note(
          `refilled after ${fmt(r.simS)} s sim / ${fmt(r.ms / 1000)} s wall, max frame ${Math.round(r.maxFrame)} ms, clip ${r.kind}, max pose Δ ${fmt(r.moved, 3)}`,
        );
        return c.done();
      },
    );
  }

  // Setup, not a check: every later step expects the AR-7 (the loop leaves the last primary,
  // ARC, equipped, and under --only the loadouts run even when no weapon check is selected).
  await setSetting('primary', 'ar7');
  await ev(() => window.__wdGame.respawn());
  await until(`fs.g().player.arsenal.primary === 'ar7'`, 2000);

  await step(W, 'inspect key (Y) plays the FP inspect clip', async () => {
    await setSetting('primary', 'ar7');
    await ev(() => window.__wdGame.respawn());
    await wait(900);
    const before = await ev(() => window.__fs.poseSig('rifle'));
    await ev(() => (window.__wdGame.input.locked = true));
    await page.keyboard.press('KeyY');
    const r = await ev(async (b) => {
      const fs = window.__fs;
      let seen = false;
      let moved = 0;
      const t0 = performance.now();
      while (performance.now() - t0 < 1500) {
        const a = fs.animator('rifle');
        if (a?.inspecting || a?.kind === 'inspect') seen = true;
        moved = Math.max(moved, fs.sigDiff(b, fs.poseSig('rifle')));
        await fs.raf();
      }
      return { seen, moved };
    }, before);
    await ev(() => (window.__wdGame.input.locked = false));
    const c = new Checks();
    c.ok(r.seen, 'inspect clip never became active after pressing Y');
    c.ok(r.moved > 0.005, `viewmodel did not move during inspect (Δ ${fmt(r.moved, 4)})`);
    c.note(`pose Δ ${fmt(r.moved, 3)}`);
    return c.done();
  });

  await step(W, 'pistol (slot 2): fire hits the dummy, reload refills', async () => {
    await tap(B.Slot2);
    await until(
      `fs.g().player.arsenal.slot === 'sidearm' && fs.g().player.arsenal.switchTimer <= 0`,
      2000,
    );
    await frame(8, 'sidearm');
    const r = await fire('tap', 400);
    const c = new Checks();
    c.ok(r.ammo === SIDEARM.magazineSize - 1, `ammo ${r.ammo0} → ${r.ammo} after one tap`);
    c.ok(r.hits > 0 && r.minHp < r.hp0, `dummy HP ${r.hp0} → ${r.minHp}`);
    const rl = await reload('sidearm', SIDEARM.magazineSize);
    if (rl.error) c.ok(false, rl.error);
    else {
      c.ok(
        Math.abs(rl.simS - SIDEARM.reloadTime) < 0.1,
        `pistol refill after ${fmt(rl.simS)} s sim vs ${SIDEARM.reloadTime}`,
      );
      c.soft(
        rl.maxFrame < HITCH_MS,
        `${Math.round(rl.maxFrame)} ms frame during the pistol reload`,
      );
      c.ok(rl.moved > 0.005, `pistol viewmodel did not move during reload (Δ ${fmt(rl.moved, 4)})`);
      c.note(`reload ${fmt(rl.simS)} s sim / ${fmt(rl.ms / 1000)} s wall, clip ${rl.kind}`);
    }
    c.note(`dummy ${r.hp0}→${r.minHp}`);
    return c.done();
  });

  if (!BASIC) {
    await step(W, 'knife (slot 3): slash hits the dummy', async () => {
      await tap(B.Slot3);
      await until(
        `fs.g().player.arsenal.slot === 'knife' && fs.g().player.arsenal.switchTimer <= 0`,
        2000,
      );
      await aliveDummy();
      const spot = await ev(() => window.__fs.spotFacing(window.__fs.dummy('pd1').pos, 1.7));
      if (!spot) throw new Error('no clear spot 1.7 m from pd1');
      await teleport(spot, spot.yaw, spot.pitch);
      await wait(200);
      const r = await ev(async (fireBit) => {
        const fs = window.__fs;
        const d = fs.dummy('pd1');
        const hits0 = fs.g().stats.hits;
        let min = d.health;
        window.__wd.hold(fireBit);
        const t0 = performance.now();
        while (performance.now() - t0 < 1200) {
          min = Math.min(min, d.health);
          await fs.raf();
        }
        window.__wd.hold(0);
        return { min, hits: fs.g().stats.hits - hits0 };
      }, B.Fire);
      if (!(r.hits > 0 && r.min < DUMMY.maxHealth))
        throw new Error(`knife: hits ${r.hits}, dummy min HP ${r.min}`);
      return `${r.hits} hits, dummy min HP ${r.min}`;
    });

    await step(W, 'quick knife (Q) from the rifle hits without leaving the rifle', async () => {
      // A switch press during the knife combo's recovery is dropped: wait for idle hands.
      await until(`fs.g().player.arsenal.melee.phase === 'idle'`, 2000);
      await wait(300);
      await tap(B.Slot1);
      const sw = await until(
        `fs.g().player.arsenal.slot === 'rifle' && fs.g().player.arsenal.switchTimer <= 0`,
        2000,
      );
      if (!sw.ok) throw new Error('Slot1 tap did not switch from the knife back to the rifle');
      await aliveDummy();
      const spot = await ev(() => window.__fs.spotFacing(window.__fs.dummy('pd1').pos, 1.7));
      if (!spot) throw new Error('no clear spot 1.7 m from pd1');
      await teleport(spot, spot.yaw, spot.pitch);
      await wait(200);
      const r = await ev(async (m) => {
        const fs = window.__fs;
        const g = fs.g();
        const hits0 = g.stats.hits;
        let melee = false;
        window.__wd.tap(m);
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) {
          if (g.player.arsenal.melee.phase !== 'idle') melee = true;
          await fs.raf();
        }
        return { hits: g.stats.hits - hits0, melee, slot: g.player.arsenal.slot };
      }, B.Melee);
      const c = new Checks();
      c.ok(r.melee, 'Melee tap never started a strike');
      c.ok(r.hits > 0, 'quick knife did not hit the dummy');
      c.ok(r.slot === 'rifle', `slot after quick knife: ${r.slot}`);
      return c.done() || `${r.hits} hit(s), slot ${r.slot}`;
    });

    // ----------------------------------------------------------------- knife defense
    const K = 'knife defense';
    await step(
      K,
      'sparring partner: parry (Block at the chamber) stuns it; held Block guards',
      async () => {
        await toLane();
        await ev(() => (window.__wdGame.player.health = 100));
        const on = await setSetting('sparring', true);
        if (!on) throw new Error('no [data-key=sparring] control');
        const up = await until('fs.g().partner && fs.g().partner.alive', 3000);
        if (!up.ok) throw new Error('sparring partner did not appear');
        const r = await ev(
          async ([block, parryWindow]) => {
            const fs = window.__fs;
            const g = fs.g();
            const face = () => {
              const me = g.player.move.pos;
              const p = g.partner.state.move.pos;
              window.__wd.look(Math.atan2(-(p.x - me.x), -(p.z - me.z)), 0);
            };
            const out = {
              parried: false,
              parryMs: null,
              strikes: 0,
              blocked: false,
              blockDmg: null,
            };
            // 1. Parry: raise Block as the opening chamber starts (inside the parry window).
            let blocking = false;
            let blockAt = 0;
            const t0 = performance.now();
            while (performance.now() - t0 < 20000 && !out.parried) {
              face();
              if (g.player.health < 50) g.player.health = 100; // keep the defender alive
              const mel = g.partner.state.arsenal.melee;
              if (!blocking && mel.phase === 'windup') {
                window.__wd.hold(block);
                blocking = true;
                blockAt = performance.now();
                out.strikes++;
              }
              if (g.partner.state.arsenal.stun > 0) {
                out.parried = true;
                out.parryMs = performance.now() - t0;
              }
              if (blocking && performance.now() - blockAt > parryWindow * 1000 + 400) {
                window.__wd.hold(0);
                blocking = false;
              }
              await fs.raf();
            }
            window.__wd.hold(0);
            out.counter = g.player.arsenal.counter;
            await fs.wait(1500);
            // 2. Guard: hold Block early (no parry) and take a strike on the forearm.
            g.player.health = 100;
            window.__wd.hold(block);
            await fs.wait(400); // held long past the parry window
            const t1 = performance.now();
            let blocks = 0;
            while (performance.now() - t1 < 15000) {
              face();
              if (g.player.health < 50) g.player.health = 100;
              blocks = Math.max(blocks, g.player.arsenal.guard.blocks);
              if (blocks > 0) break;
              await fs.raf();
            }
            out.blocked = blocks > 0;
            out.blockDmg = 100 - g.player.health;
            out.guardHeld = g.player.arsenal.guard.held;
            window.__wd.hold(0);
            return out;
          },
          [B.Block, KNIFE_DEFENSE.parryWindow],
        );
        await setSetting('sparring', false);
        await ev(() => (window.__wdGame.player.health = 100));
        const c = new Checks();
        c.ok(r.parried, `no parry in 20 s (${r.strikes} chambers seen)`);
        c.ok(r.blocked, 'held guard never blocked a strike in 15 s');
        c.ok(
          r.blockDmg !== null &&
            r.blockDmg <= KNIFE.thrustDamage * KNIFE_DEFENSE.guardDamageMultiplier + 0.5,
          `guarded strike did ${r.blockDmg} dmg (want ≤ ×${KNIFE_DEFENSE.guardDamageMultiplier})`,
        );
        c.note(
          `parry after ${fmt((r.parryMs ?? 0) / 1000)} s (${r.strikes} chambers), guard took ${r.blockDmg} dmg`,
        );
        return c.done();
      },
      { timeout: 60_000 },
    );
  }

  // ------------------------------------------------------------------- throwables + tactical
  const G = 'throwables';
  await step(G, 'frag: throw → explosion → dummy damaged (and the thrower)', async () => {
    await ev(() => window.__wdGame.respawn());
    await wait(600);
    await aliveDummy();
    const spot = await ev(() => window.__fs.spotFacing(window.__fs.dummy('pd1').pos, 2.5));
    if (!spot) throw new Error('no clear spot 2.5 m from pd1');
    await teleport(spot, spot.yaw, -1.45);
    await until('fs.g().player.move.grounded', 1500);
    const r = await ev(async (gr) => {
      const fs = window.__fs;
      const g = fs.g();
      const d = fs.dummy('pd1');
      const s0 = { hits: g.stats.hits, deaths: g.stats.deaths, nades: g.player.arsenal.grenades };
      window.__wd.tap(gr);
      const live = await fs.until(() => g.grenades.length === 1, 1500);
      let min = d.health;
      let minMe = g.player.health;
      const t0 = performance.now();
      while (performance.now() - t0 < 4500) {
        min = Math.min(min, d.health);
        minMe = Math.min(minMe, g.player.health);
        if (g.grenades.length === 0 && g.lastExplosion) break;
        await fs.raf();
      }
      await fs.wait(100);
      return {
        live: live.ok,
        nades0: s0.nades,
        exploded: !!g.lastExplosion,
        hits: g.stats.hits - s0.hits,
        deaths: g.stats.deaths - s0.deaths,
        minHp: Math.min(min, d.health),
        selfDmg: g.lastExplosion?.selfDamage ?? 0,
        fuseMs: performance.now() - t0,
      };
    }, B.Grenade);
    const c = new Checks();
    c.ok(r.nades0 === GRENADE.perLife, `started with ${r.nades0} frags`);
    c.ok(r.live, 'no live grenade after the Grenade tap');
    c.ok(r.exploded, 'no explosion within 4.5 s');
    c.ok(r.hits > 0 && r.minHp < 100, `dummy not damaged (hits ${r.hits}, min HP ${r.minHp})`);
    c.ok(r.selfDmg > 0, 'thrower took no self-damage at 2.5 m');
    c.note(
      `fuse ${fmt(r.fuseMs / 1000)} s, dummy min HP ${r.minHp}, self ${fmt(r.selfDmg, 0)}${r.deaths ? ' (killed self)' : ''}`,
    );
    return c.done();
  });

  if (!BASIC) {
    await step(G, 'smoke: throw → cloud appears (sim + SmokeView)', async () => {
      await toLane();
      const r = await ev(async (sm) => {
        const fs = window.__fs;
        const g = fs.g();
        const n0 = g.player.arsenal.smokes;
        window.__wd.look(g.input.yaw, -0.3);
        window.__wd.tap(sm);
        const ok = await fs.until(() => g.smoke.length > 0, 3500);
        await fs.wait(1500);
        let sprites = 0;
        g.smokeView.group.traverse((o) => {
          if (o.isSprite && o.visible) sprites++;
        });
        return {
          n0,
          n1: g.player.arsenal.smokes,
          cloud: ok.ok,
          t: ok.t,
          sprites,
          clouds: g.smoke.length,
        };
      }, B.Smoke);
      await shot('smoke');
      const c = new Checks();
      c.ok(r.n0 === SMOKE.perLife && r.n1 === SMOKE.perLife - 1, `smokes ${r.n0} → ${r.n1}`);
      c.ok(r.cloud, 'no smoke cloud in the sim within 3.5 s');
      c.ok(r.sprites > 0, 'SmokeView drew no puffs');
      c.note(`cloud after ${fmt(r.t / 1000)} s, ${r.sprites} puffs`);
      return c.done();
    });

    await step(G, 'jammer: pulse spends the charge and shows the ring', async () => {
      const r = await ev(async (jm) => {
        const fs = window.__fs;
        const g = fs.g();
        const n0 = g.player.arsenal.jammers;
        const p0 = fs.programNames();
        window.__wd.tap(jm);
        let rings = 0;
        let fresh = [];
        const t0 = performance.now();
        while (performance.now() - t0 < 1000) {
          rings = Math.max(rings, g.jammerFx.group.children.length);
          const now = fs.programNames().filter((n) => !p0.includes(n));
          if (now.length > fresh.length) fresh = now;
          await fs.raf();
        }
        return { n0, n1: g.player.arsenal.jammers, rings, fresh };
      }, B.Jammer);
      const c = new Checks();
      c.ok(r.n0 === JAMMER.perLife && r.n1 === JAMMER.perLife - 1, `jammers ${r.n0} → ${r.n1}`);
      c.ok(r.rings > 0, 'no jammer ring effect');
      c.ok(!r.fresh.length, `pulse compiled shader program(s) mid-game: ${r.fresh.join(', ')}`);
      return c.done() || 'ring shown';
    });

    await step(G, 'recon drone: uplink charge → launch, fly, HUD feed, recall', async () => {
      const pk = await ev(() => window.__wdGame.pickups.find((p) => p.kind === 'drone'));
      if (!pk) throw new Error('no drone uplink on this map section');
      await teleport(pk.pos, 0, 0);
      const got = await until('fs.g().tactical.droneCharges > 0', 2000);
      const r = await ev(async (dr) => {
        const fs = window.__fs;
        const g = fs.g();
        window.__wd.tap(dr);
        const up = await fs.until(() => g.tactical.drone?.alive === true, 1500);
        const p0 = up.ok ? { ...g.tactical.drone.pos } : null;
        window.__wd.hold(0, 0, 1);
        await fs.wait(1200);
        window.__wd.hold(0);
        const p1 = g.tactical.drone ? { ...g.tactical.drone.pos } : null;
        const feed = document.querySelector('[data-testid=drone-feed]')?.classList.contains('show');
        const body = { ...g.player.move.pos };
        window.__wd.tap(dr);
        const down = await fs.until(() => !g.tactical.drone || !g.tactical.drone.alive, 1500);
        await fs.wait(300);
        const feedOff = !document
          .querySelector('[data-testid=drone-feed]')
          ?.classList.contains('show');
        return {
          up: up.ok,
          moved: p0 && p1 ? Math.hypot(p1.x - p0.x, p1.z - p0.z) : 0,
          feed,
          down: down.ok,
          feedOff,
          bodyMoved: Math.hypot(g.player.move.pos.x - body.x, g.player.move.pos.z - body.z),
        };
      }, B.Drone);
      const c = new Checks();
      c.ok(got.ok, 'walking onto the drone uplink gave no drone charge');
      c.ok(r.up, 'Drone tap did not launch');
      c.ok(r.moved > 3, `drone moved only ${fmt(r.moved)} m in 1.2 s`);
      c.ok(r.feed, 'HUD drone feed not shown while flying');
      c.ok(r.down, 'second Drone tap did not recall it');
      c.ok(r.feedOff, 'drone feed still shown after recall');
      c.note(`flew ${fmt(r.moved, 1)} m`);
      return c.done();
    });
  }

  // ------------------------------------------------------------------- pickups
  const P = 'pickups';
  await step(
    P,
    `medkit: hurt player heals +${MEDKIT.heal}, kit goes on cooldown; full-health player leaves one`,
    async () => {
      const kits = await ev(() =>
        window.__wdGame.pickups.filter(
          (p) => p.kind === 'medkit' && p.pos.y < 0.5 && p.cooldown <= 0,
        ),
      );
      if (kits.length < 2) throw new Error(`only ${kits.length} ground medkits available`);
      const [a, b] = kits;
      const c = new Checks();
      // Full health: walk over it, it stays.
      await ev(() => (window.__wdGame.player.health = 100));
      await teleport(b.pos, 0, 0);
      await wait(500);
      const bCool = await ev(
        (id) => window.__wdGame.pickups.find((p) => p.id === id).cooldown,
        b.id,
      );
      c.ok(bCool <= 0, `full-health player took medkit ${b.id} (cooldown ${fmt(bCool)})`);
      // Hurt: heals.
      await ev(() => (window.__wdGame.player.health = 40));
      await teleport({ x: a.pos.x + 3, y: a.pos.y, z: a.pos.z }, 0, 0);
      await wait(300);
      const deaths0 = await ev(() => window.__wdGame.stats.deaths);
      await teleport(a.pos, 0, 0);
      const healed = await until(`fs.g().player.health > 40`, 2000);
      const trail = await ev(async () => {
        const out = [];
        for (let i = 0; i < 20; i++) {
          out.push(Math.round(window.__wdGame.player.health));
          await window.__fs.raf();
        }
        return out;
      });
      const deaths = (await ev(() => window.__wdGame.stats.deaths)) - deaths0;
      const r = await ev((id) => {
        const g = window.__wdGame;
        return {
          hp: g.player.health,
          cool: g.pickups.find((p) => p.id === id).cooldown,
          hud: document.querySelector('.health-num')?.textContent,
        };
      }, a.id);
      c.ok(
        healed.ok && r.hp === 40 + MEDKIT.heal,
        `health 40 → ${r.hp} (next frames ${[...new Set(trail)].join('→')}, deaths ${deaths})`,
      );
      c.ok(
        r.cool > MEDKIT.respawn - 3,
        `medkit cooldown ${fmt(r.cool)} (want ≈ ${MEDKIT.respawn})`,
      );
      await wait(200);
      const hud = await ev(() => document.querySelector('.health-num')?.textContent);
      c.ok(hud === String(r.hp), `HUD health "${hud}" ≠ ${r.hp}`);
      medkitClock.id = a.id;
      medkitClock.at = Date.now();
      c.note(`${a.id}: 40 → ${r.hp}, cooldown ${fmt(r.cool, 1)} s`);
      await ev(() => (window.__wdGame.player.health = 100));
      await wait(600); // let the heal cue for this reset play before the next banner check
      return c.done();
    },
    // Setup for "medkit respawns" (it times the cooldown this step starts): run it when that
    // check is selected on its own.
    {
      always:
        !!ONLY &&
        `${P} › medkit respawns after ${MEDKIT.respawn} s`
          .toLowerCase()
          .includes(ONLY.toLowerCase()),
    },
  );

  if (!BASIC) {
    await step(P, 'radar uplink: charge → call in (T) → radar live, banners', async () => {
      const ups = await ev(() =>
        window.__wdGame.pickups.filter((p) => p.kind === 'radar' && p.cooldown <= 0),
      );
      if (!ups.length) throw new Error('no radar uplink available');
      let pk = ups[0];
      let got = { ok: false };
      const tried = [];
      for (const u of ups) {
        pk = u;
        await teleport(u.pos, 0, 0);
        got = await until('fs.g().tactical.radar.charges > 0', 2000);
        tried.push(`${u.id}@y${u.pos.y}:${got.ok ? 'ok' : 'no'}`);
        if (got.ok) break;
      }
      const banner1 = await ev(() => document.querySelector('.banner')?.textContent ?? '');
      await tap(B.Radar);
      const live = await until('fs.g().tactical.radar.live > 0', 1500);
      const r = await ev(() => {
        const el = document.querySelector('[data-testid=radar]');
        return {
          banner: document.querySelector('.banner')?.textContent ?? '',
          radarShown:
            !!el &&
            getComputedStyle(el).display !== 'none' &&
            el.getBoundingClientRect().width > 50,
          label: el?.querySelector('.radar-label')?.textContent ?? '',
          cool:
            window.__wdGame.pickups.find((p) => p.kind === 'radar' && p.cooldown > 0)?.cooldown ??
            0,
        };
      });
      const c = new Checks();
      c.ok(got.ok, `walking onto uplink ${pk.id} gave no radar charge`);
      c.ok(/RADAR CHARGE/i.test(banner1), `pickup banner "${banner1}"`);
      c.ok(live.ok, 'Radar tap did not make the radar live');
      c.ok(/RADAR CALLED IN/i.test(r.banner), `call-in banner "${r.banner}"`);
      c.ok(r.radarShown, 'radar HUD not visible');
      c.ok(r.cool > 0, 'uplink did not go on cooldown');
      c.note(`${tried.join(' ')}, label "${r.label}"`);
      return c.done();
    });

    // ----------------------------------------------------------------- skateboard
    const SK = 'skateboard';
    await step(
      SK,
      'pick up in the helicopter wreck, ride faster than a sprint, ollie, BOARD chip',
      async () => {
        const b = await ev(
          () =>
            window.__wdGame.board && {
              ...window.__wdGame.board.pos,
              rider: window.__wdGame.board.rider,
            },
        );
        if (!b) throw new Error('no skateboard on this map');
        await teleport(b, 0, 0);
        const got = await until(
          `fs.g().board.rider === 'player' && fs.g().player.move.board`,
          2000,
        );
        const c = new Checks();
        c.ok(
          got.ok,
          `stepping onto the board at (${fmt(b.x, 1)}, ${fmt(b.y)}, ${fmt(b.z, 1)}) did not pick it up`,
        );
        if (!got.ok) return c.done();
        const chip = await ev(() =>
          document.querySelector('[data-testid=status-board]')?.classList.contains('on'),
        );
        c.ok(chip, 'HUD BOARD chip not on');
        await teleport({ x: lane.x, y: 0, z: lane.z }, lane.yaw, 0);
        const r = await ev(async (jump) => {
          const fs = window.__fs;
          const m = () => fs.g().player.move;
          window.__wd.hold(0, 0, 1);
          let top = 0;
          const t0 = performance.now();
          while (performance.now() - t0 < 2600) {
            top = Math.max(top, Math.hypot(m().vel.x, m().vel.z));
            await fs.raf();
          }
          const y0 = m().pos.y;
          window.__wd.tap(jump);
          let rise = 0;
          let air = false;
          const t1 = performance.now();
          while (performance.now() - t1 < 900) {
            rise = Math.max(rise, m().pos.y - y0);
            if (!m().grounded) air = true;
            await fs.raf();
          }
          window.__wd.hold(0);
          return { top, rise, air, still: m().board };
        }, B.Jump);
        await shot('board-ride');
        c.ok(
          r.top > MOVEMENT.sprintSpeed,
          `top speed ${fmt(r.top)} m/s ≤ sprint ${MOVEMENT.sprintSpeed}`,
        );
        c.ok(
          r.top <= SKATEBOARD.cruiseSpeed + 0.3,
          `top speed ${fmt(r.top)} > cruise ${SKATEBOARD.cruiseSpeed}`,
        );
        c.ok(r.air && r.rise > 0.2, `ollie rise ${fmt(r.rise)} m`);
        c.ok(r.still, 'fell off the board after the ollie');
        c.note(`top ${fmt(r.top)} m/s, ollie ${fmt(r.rise)} m`);
        return c.done();
      },
    );

    await step(SK, 'death dismounts; the board lies where the rider fell', async () => {
      const r = await ev(async () => {
        const fs = window.__fs;
        const g = fs.g();
        if (g.board?.rider !== 'player') return { skipped: 'not riding' };
        await fs.until(() => Math.hypot(g.player.move.vel.x, g.player.move.vel.z) < 0.5, 4000);
        const at = { ...g.player.move.pos };
        const deaths = g.stats.deaths;
        g.damagePlayer(999, at, 'feature sweep');
        await fs.wait(300);
        return {
          deaths: g.stats.deaths - deaths,
          rider: g.board.rider,
          riding: g.player.move.board,
          dist: Math.hypot(g.board.pos.x - at.x, g.board.pos.z - at.z),
          chip: document.querySelector('[data-testid=status-board]')?.classList.contains('on'),
        };
      });
      if (r.skipped) throw new Error(r.skipped);
      const c = new Checks();
      c.ok(r.deaths === 1, 'no death registered');
      c.ok(r.rider === null && !r.riding, `still riding after death (rider ${r.rider})`);
      c.ok(r.dist < 2, `board ${fmt(r.dist)} m from where the rider died`);
      c.ok(!r.chip, 'BOARD chip still on after respawn');
      c.note(`board ${fmt(r.dist)} m from the death spot`);
      return c.done();
    });

    // ----------------------------------------------------------------- soldiers
    const SO = 'soldiers';
    await step(SO, 'practice dummies are soldiers holding their arsenal weapon', async () => {
      const r = await ev(() =>
        [...window.__wdGame.dummyView.views.entries()].map(([id, v]) => ({
          id,
          soldier: !!v.soldier,
          weapon: v.soldier?.weapon ?? null,
          inScene: !!v.soldier?.root.parent,
          visible: v.soldier?.root.visible ?? false,
        })),
      );
      const c = new Checks();
      r.forEach((d, i) => {
        c.ok(d.soldier && d.inScene && d.visible, `${d.id} is not a visible soldier`);
        c.ok(
          d.weapon === DUMMY_WEAPONS[i],
          `${d.id} holds ${d.weapon}, expected ${DUMMY_WEAPONS[i]}`,
        );
      });
      const spot = await ev(() => window.__fs.spotFacing(window.__fs.dummy('pd1').pos, 4));
      if (!spot) throw new Error('no clear spot 4 m from pd1');
      await teleport(spot, spot.yaw, -0.08);
      await wait(800);
      c.note((await shot('dummy-soldier')) ?? '');
      c.note(r.map((d) => `${d.id}:${d.weapon}`).join(' '));
      return c.done();
    });

    await step(
      SO,
      'third-person action layers play (reload/throw/strike/guard/stun) + real-hit flinch',
      async () => {
        const r = await ev(async () => {
          const fs = window.__fs;
          const g = fs.g();
          const view = g.dummyView;
          const sol = view.views.get('pd1').soldier;
          const out = {};
          for (const [kind, want] of [
            ['reload', 'reload'],
            ['throw', 'throw'],
            ['strike', 'strike'],
            ['guard', 'guard'],
            ['stun', 'hit'],
          ]) {
            view.setAction('pd1', { kind, v: 0, t: 0.3 });
            await fs.wait(250);
            out[kind] = {
              clip: sol.actionClip,
              want,
              grenade: kind === 'throw' ? !!sol.grenadeMesh?.visible : undefined,
            };
            view.setAction('pd1', null);
            await fs.wait(350);
          }
          out.cleared = sol.actionClip;
          return out;
        });
        const c = new Checks();
        for (const k of ['reload', 'throw', 'strike', 'guard', 'stun']) {
          c.ok(r[k].clip === r[k].want, `${k}: layer clip ${r[k].clip}, expected ${r[k].want}`);
        }
        c.ok(r.throw.grenade, 'no frag in the soldier hand during the throw wind-up');
        // Real hit → flinch layer (no setAction).
        await setSetting('primary', 'ar7');
        await ev(() => window.__wdGame.respawn());
        await wait(600);
        await frame(8);
        const f = await ev(async (fireBit) => {
          const fs = window.__fs;
          const sol = fs.g().dummyView.views.get('pd1').soldier;
          window.__wd.tap(fireBit);
          let fl = null;
          const t0 = performance.now();
          while (performance.now() - t0 < 600) {
            fl ??= sol.flinchClip;
            await fs.raf();
          }
          return { fl, hp: fs.dummy('pd1').health };
        }, B.Fire);
        c.ok(
          f.fl === 'hit' || f.fl === 'hitHead',
          `no flinch layer after a real hit (flinch ${f.fl}, dummy HP ${f.hp})`,
        );
        c.note(`layers ok, flinch ${f.fl}`);
        return c.done();
      },
    );
  }

  // ------------------------------------------------------------------- HUD
  await step(
    'hud',
    'health + ammo readouts track the state; radar present; weapon slots',
    async () => {
      await ev(() => (window.__wdGame.player.health = 73));
      await wait(200);
      const r = await ev(() => {
        const g = window.__wdGame;
        const w = window.__fs.gun();
        const radar = document.querySelector('[data-testid=radar]');
        return {
          hp: document.querySelector('.health-num')?.textContent,
          ammo: document.querySelector('[data-testid=ammo]')?.textContent ?? '',
          real: w?.ammo,
          slots: document.querySelector('[data-testid=slots]')?.children.length ?? 0,
          radar: !!radar && radar.getBoundingClientRect().width > 50,
          weapon: document.querySelector('.weapon-name')?.textContent ?? '',
          slot: g.player.arsenal.slot,
        };
      });
      await ev(() => (window.__wdGame.player.health = 100));
      const c = new Checks();
      c.ok(r.hp === '73', `HUD health "${r.hp}" ≠ 73`);
      c.ok(r.real === undefined || leadNum(r.ammo) === r.real, `HUD ammo "${r.ammo}" ≠ ${r.real}`);
      c.ok(r.slots >= 3, `${r.slots} weapon slots in HUD`);
      c.ok(r.radar, 'radar HUD missing');
      c.ok(r.weapon.length > 0, 'no weapon name');
      c.note(`health "${r.hp}", ammo "${r.ammo.trim()}", weapon "${r.weapon}"`);
      return c.done();
    },
  );

  // ------------------------------------------------------------------- settings
  await step(
    'settings',
    'quality Low → Medium → High → Medium switches without errors or new programs',
    async () => {
      const p0 = await programs();
      const n0 = await ev(() => window.__fs.programNames());
      const seen = [];
      const fresh = {};
      for (const q of ['low', 'medium', 'high', 'medium']) {
        const before = await ev(() => window.__fs.programNames());
        if (!(await setSetting('quality', q))) throw new Error('no [data-key=quality] control');
        const ok = await until(`fs.g().quality === '${q}'`, 3000);
        await wait(1200);
        const p = await programs();
        const fps = await ev(() => window.__wdGame.perf.fps);
        const added = await ev(
          (b) => window.__fs.programNames().filter((n) => !b.includes(n)),
          before,
        );
        if (added.length) fresh[q] = added;
        seen.push(`${q}:${ok.ok ? 'ok' : 'NOT APPLIED'} ${p}p ${fmt(fps, 0)}fps`);
        if (!ok.ok) throw new Error(`quality ${q} not applied (${seen.join(', ')})`);
      }
      const l = await luminance('quality-medium');
      const p1 = await programs();
      const c = new Checks();
      const kept = await ev((b) => window.__fs.programNames().filter((n) => !b.includes(n)), n0);
      c.ok(
        p1 === p0 && !kept.length,
        `programs ${p0} → ${p1} across tier switches; compiled on switch: ${Object.entries(fresh)
          .map(([q, a]) => `${q}: ${a.join(' ')}`)
          .join(' | ')}`,
      );
      c.ok(l.mean > 0.08, `view dark after tier switches (${fmt(l.mean, 3)})`);
      c.note(seen.join(', '));
      return c.done();
    },
  );

  if (!BASIC) {
    await step(
      P,
      `medkit respawns after ${MEDKIT.respawn} s`,
      async () => {
        if (!medkitClock.id) throw new Error('medkit step did not run');
        const left = MEDKIT.respawn * 1000 - (Date.now() - medkitClock.at);
        if (left > 0) await wait(left);
        // Cooldowns run on sim time; allow a few seconds of drift from slow (High tier) frames.
        const back = await until(
          `fs.g().pickups.find((p) => p.id === '${medkitClock.id}').cooldown <= 0`,
          8000,
        );
        const wall = (Date.now() - medkitClock.at) / 1000;
        if (!back.ok)
          throw new Error(`${medkitClock.id} still on cooldown ${fmt(wall, 1)} s later`);
        return `${medkitClock.id} back after ${fmt(wall, 1)} s wall clock`;
      },
      { timeout: 45_000 },
    );
  }

  // --------------------------------------------------------- 2026-09-30 features
  const N = 'new';
  await step(N, 'loading screen is gone and the HUD is live once ready', async () => {
    const r = await ev(() => ({
      overlay: !!document.getElementById('wd-loading'),
      inert: !!document.getElementById('hud')?.inert,
    }));
    const c = new Checks();
    c.ok(!r.overlay, 'the loading overlay is still in the DOM after ready');
    c.ok(!r.inert, 'the HUD is still inert after ready');
    return c.done();
  });

  await step(
    N,
    `spawn protection: ${SPAWN_PROTECTION.duration} s after a respawn, chip shown, firing ends it`,
    async () => {
      await ev(() => window.__wdGame.respawn());
      await wait(250);
      const a = await ev(() => ({
        guard: window.__wdGame.player.spawnGuard,
        chip: (() => {
          const e = document.querySelector('[data-testid=status-protected]');
          return !!e && getComputedStyle(e).display !== 'none' && e.offsetParent !== null;
        })(),
      }));
      await ev(() => (window.__wdGame.input.locked = true));
      await tap(B.Fire);
      await wait(250);
      const fired = await ev(() => window.__wdGame.player.spawnGuard);
      const run = await ev(async () => {
        const fs = window.__fs;
        const g = fs.g();
        g.respawn();
        const seq0 = g.seq;
        const t0 = performance.now();
        // Sim time (steps × 1/60 s): Game.frame() caps catch-up, so a slow GPU runs the sim slower.
        while (g.player.spawnGuard > 0 && performance.now() - t0 < 20_000) await fs.raf();
        return { left: g.player.spawnGuard, simS: (g.seq - seq0) / 60 };
      });
      const c = new Checks();
      c.ok(
        a.guard > SPAWN_PROTECTION.duration - 0.8,
        `guard ${fmt(a.guard)} s just after a respawn`,
      );
      c.ok(a.chip, 'PROTECTED chip not shown');
      c.ok(fired === 0, `firing left ${fmt(fired)} s of protection`);
      c.ok(run.left === 0, `protection still ${fmt(run.left)} s left after 20 s of wall clock`);
      c.ok(
        Math.abs(run.simS - SPAWN_PROTECTION.duration) < 0.2,
        `protection ran ${fmt(run.simS)} s of sim time (want ${SPAWN_PROTECTION.duration} s)`,
      );
      c.note(`guard ${fmt(a.guard)} s, chip shown, ran out after ${fmt(run.simS)} s sim`);
      return c.done();
    },
  );

  await step(
    N,
    'player collision: walking into a dummy stops at its body (soft push)',
    async () => {
      const r = await ev(async () => {
        const fs = window.__fs;
        const g = fs.g();
        const d = g.dummies.find((x) => x.health > 0 && !x.def.path);
        if (!d) return { none: true };
        const start = { x: d.pos.x + 1.6, y: d.pos.y, z: d.pos.z };
        const yaw = Math.atan2(-(d.pos.x - start.x), -(d.pos.z - start.z));
        window.__wd.teleport(start.x, start.y + 0.03, start.z, yaw, 0);
        await fs.wait(300);
        window.__wd.hold(0, 0, 1);
        let min = Infinity;
        const t0 = performance.now();
        while (performance.now() - t0 < 1800) {
          const q = g.player.move.pos;
          min = Math.min(min, Math.hypot(q.x - d.pos.x, q.z - d.pos.z));
          await fs.raf();
        }
        window.__wd.hold(0);
        return { min, id: d.def.id };
      });
      if (r.none) return new Warn('no standing dummy to walk into');
      const floor = PLAYER_COLLISION.radius * 2 - PLAYER_COLLISION.walkPenetration - 0.06;
      const c = new Checks();
      c.ok(
        r.min >= floor,
        `walked to ${fmt(r.min)} m of ${r.id} (bodies stop at ≥ ${fmt(floor)} m)`,
      );
      c.ok(r.min < 1.2, `never reached ${r.id} (min ${fmt(r.min)} m)`);
      c.note(`closest ${fmt(r.min)} m to ${r.id}`);
      return c.done();
    },
  );

  await step(
    N,
    'camera moments: intro fly-over, death cam, victory shot; back to first person',
    async () => {
      const cam = () => ev(() => window.__wd.state().camera);
      const c = new Checks();
      const intro = await ev(() => window.__wd.cam('intro'));
      await wait(700);
      const a = await cam();
      c.ok(a.mode === 'intro', `intro: mode ${a.mode} (${intro})`);
      c.ok(a.pos.y > 5, `intro camera only ${fmt(a.pos.y)} m up`);
      await ev(() => window.__wd.cam('off'));
      await wait(200);
      const vulnerable = await until('fs.g().player.spawnGuard === 0', 20_000);
      c.ok(vulnerable.ok, 'spawn protection never ran out before the death camera');
      await ev(() => window.__wd.cam('death'));
      await wait(900);
      const b = await cam();
      c.ok(b.mode !== 'play', 'death: the camera stayed in first person');
      c.ok(b.localSoldier, 'death: the local soldier is not drawn');
      await ev(() => window.__wd.cam('off'));
      await until('fs.g().player.health > 0', 5000);
      await ev(() => window.__wd.cam('victory'));
      await wait(1200);
      const v = await cam();
      c.ok(v.mode === 'victory', `victory: mode ${v.mode}`);
      await ev(() => window.__wd.cam('off'));
      await wait(300);
      const end = await cam();
      c.ok(end.mode === 'play', `did not return to first person (${end.mode})`);
      c.note(`intro ${fmt(a.pos.y, 1)} m up, death "${b.mode}", victory ok`);
      return c.done();
    },
  );

  await step('boot', 'shader programs unchanged after the whole sweep', async () => {
    const p = await programs();
    const grew = results.filter(
      (r, i) =>
        i > 0 &&
        r.programs > 0 &&
        results[i - 1].programs > 0 &&
        r.programs > results[i - 1].programs,
    );
    const added = await ev(
      (b) => window.__fs.programNames().filter((n) => !b.includes(n)),
      warmNames,
    );
    if (p !== warmPrograms || added.length)
      throw new Error(
        `programs ${warmPrograms} after warm-up → ${p} now (+${added.length}: ${added.join(' ')}); grew in: ${grew.map((r) => `${r.name} (${r.programs})`).join(', ') || '?'}`,
      );
    return `${p} programs`;
  });

  await step('boot', `no frame hitches > ${HITCH_MS} ms during gameplay steps`, async () => {
    const bad = results.filter((r) => r.hitches?.length && r.section !== 'settings');
    if (bad.length)
      return new Warn(
        bad
          .map(
            (r) =>
              `${r.section} › ${r.name}: ${r.hitches.map((h) => `${Math.round(h.ms)}ms`).join(',')}`,
          )
          .join(' | '),
      );
    return 'none';
  });

  await step('boot', 'no shader program links mid-game (outside the quality switch)', async () => {
    const bad = results.filter(
      (r) => r.compiled?.length && r.section !== 'settings' && r.name !== 'page ready',
    );
    if (bad.length)
      throw new Error(
        bad.map((r) => `${r.section} › ${r.name}: ${r.compiled.join(' ')}`).join(' | '),
      );
    return 'none';
  });

  await step('boot', 'HDR NaN count still 0 at the end', async () => {
    await teleport({ x: lane.x, y: 0, z: lane.z }, lane.yaw, 0);
    await wait(800);
    const r = await hdrNaN();
    if (r.nan || r.inf) throw new Error(`NaN ${r.nan}, Inf ${r.inf}`);
    return `0 NaN / 0 Inf`;
  });

  await page.context().close();
  page = null;
}

// ---------------------------------------------------------------------------------------------
// Online sweep (dev server with bots)
// ---------------------------------------------------------------------------------------------

async function online() {
  page = await openPage();
  const O = 'online';
  await step(
    O,
    `join ${SERVER} (Play) → online`,
    async () => {
      const ms = await boot(`online&server=${SERVER}`);
      await ev(() => {
        window.__feed = 0;
        const el = document.querySelector('[data-testid=kill-feed]');
        if (el)
          new MutationObserver(
            () => (window.__feed = Math.max(window.__feed, el.children.length)),
          ).observe(el, { childList: true });
        void window.__wdGame.play(false).catch(() => {});
      });
      const r = await until(
        `fs.g().online && fs.g().online.status.state === 'online' && fs.g().online.id`,
        30_000,
      );
      if (!r.ok) {
        const st = await ev(() => window.__wdGame.online?.status);
        throw new Error(`not online after 30 s: ${JSON.stringify(st)}`);
      }
      return `ready ${(ms / 1000).toFixed(1)} s, online after ${fmt(r.t / 1000, 1)} s`;
    },
    { timeout: 280_000, always: true },
  );
  if (!(await ev(() => window.__wdGame?.online?.status.state === 'online').catch(() => false)))
    return;
  await wait(1500);
  const joinNames = await ev(() => window.__fs.programNames());

  await step(
    O,
    'recon drone online: server uplink charge → launch, fly, HUD feed, recall',
    async () => {
      const r = await ev(async (dr) => {
        const fs = window.__fs;
        const g = fs.g();
        const w = window.__wd;
        const up = g.online.tactical?.pickups?.find((p) => p.kind === 'drone');
        if (!up) return { error: 'no drone uplink in the server pickups' };
        // First online step, from the fresh spawn (the walk is shortest and most repeatable there).
        // Walk there on the server's terms (no teleport online), sidestepping clutter.
        let last = null;
        let stuck = 0;
        let side = 1;
        const t0 = performance.now();
        while (performance.now() - t0 < 60_000 && g.tactical.droneCharges === 0) {
          const p = g.player.move.pos;
          w.look(Math.atan2(-(up.pos.x - p.x), -(up.pos.z - p.z)), 0);
          stuck = last && Math.hypot(p.x - last.x, p.z - last.z) < 0.2 ? stuck + 1 : 0;
          if (stuck > 5) {
            side = -side;
            w.hold(0, side, 0);
            await fs.wait(600);
            stuck = 0;
          }
          w.hold(0, 0, 1);
          last = { x: p.x, z: p.z };
          await fs.wait(150);
        }
        w.hold(0);
        const charged = g.tactical.droneCharges > 0;
        if (!charged) return { charged, walkMs: performance.now() - t0 };
        w.tap(dr);
        const launched = await fs.until(() => g.tactical.drone?.alive === true, 2000);
        if (!launched.ok) return { charged, launched: false };
        const p0 = { ...g.tactical.drone.pos };
        w.hold(0, 0, 1);
        await fs.wait(1200);
        w.hold(0);
        const p1 = g.tactical.drone ? { ...g.tactical.drone.pos } : p0;
        const feed = document.querySelector('[data-testid=drone-feed]')?.classList.contains('show');
        w.tap(dr);
        const down = await fs.until(() => !g.tactical.drone?.alive, 2000);
        return {
          charged,
          launched: true,
          moved: Math.hypot(p1.x - p0.x, p1.z - p0.z),
          feed,
          down: down.ok,
          walkMs: Math.round(performance.now() - t0),
        };
      }, B.Drone);
      if (r.error) throw new Error(r.error);
      // The scripted walk has no navigation: clutter it can't get round is the probe's limit,
      // not the game's (the server path is covered by server/match/drone.test.ts).
      if (!r.charged)
        return new Warn(`could not walk to the drone uplink in ${fmt(r.walkMs / 1000, 0)} s`);
      const c = new Checks();
      c.ok(r.charged, 'walking onto the server drone uplink gave no charge');
      c.ok(r.launched, 'Drone tap did not launch online');
      c.ok(r.moved > 3, `drone moved only ${fmt(r.moved ?? 0)} m in 1.2 s`);
      c.ok(r.feed, 'HUD drone feed not shown while flying online');
      c.ok(r.down, 'second Drone tap did not recall it');
      c.note(`walk ${fmt((r.walkMs ?? 0) / 1000, 1)} s, flew ${fmt(r.moved ?? 0)} m`);
      return c.done();
    },
    { timeout: 90_000 },
  );

  await step(O, '5 bots in the roster and moving', async () => {
    await wait(3000);
    const r = await ev(async () => {
      const fs = window.__fs;
      const s = fs.g().online;
      // Furthest each bot got from where it was, over 8 s: a 3 s snapshot pair caught bots
      // mid-hold (anchors hold 5–9 s, flankers wait at their offset point) and failed on timing.
      const a = new Map(s.remotePlayers(performance.now()).map((p) => [p.id, { ...p.pose }]));
      const far = new Map();
      const t0 = performance.now();
      let b = [];
      while (performance.now() - t0 < 8000) {
        b = s.remotePlayers(performance.now());
        for (const p of b) {
          const q = a.get(p.id);
          if (q)
            far.set(p.id, Math.max(far.get(p.id) ?? 0, Math.hypot(p.pose.x - q.x, p.pose.z - q.z)));
        }
        await fs.wait(100);
      }
      const moved = [...far.values()].filter((d) => d > 1).length;
      return {
        roster: s.roster.length,
        bots: s.roster.filter((x) => x.bot).length,
        remotes: b.length,
        moved,
      };
    });
    const c = new Checks();
    c.ok(r.bots === 5, `${r.bots} bots in the roster (${r.roster} players)`);
    c.ok(r.remotes >= 5, `${r.remotes} remote players drawn`);
    c.ok(r.moved >= 3, `only ${r.moved} remotes moved > 1 m in 8 s`);
    c.note(`roster ${r.roster}, bots ${r.bots}, moved ${r.moved}/${r.remotes}`);
    return c.done();
  });

  await step(
    O,
    'bots drawn as soldiers holding their snapshot weapon; action layers play',
    async () => {
      const r = await ev(async (scanOf) => {
        const fs = window.__fs;
        const g = fs.g();
        const slots = ['rifle', 'sidearm', 'knife']; // shared/net/protocol SNAP_SLOTS
        const held = (p) => {
          const sl = slots[p.pose.sl] ?? 'rifle';
          return sl === 'knife' ? 'knife' : sl === 'sidearm' ? 'pistol' : scanOf[p.pose.primary];
        };
        let checked = 0;
        const wrong = new Set();
        let pending;
        let next = new Set();
        let transient = 0;
        const noSoldier = new Set();
        const clips = new Set();
        const t0 = performance.now();
        while (performance.now() - t0 < 12000) {
          await fs.wait(200); // let the view apply this frame's poses
          pending = next;
          next = new Set();
          for (const p of g.online.remotePlayers(performance.now())) {
            const f = g.remoteView.figures[p.slot];
            if (!f?.soldier) {
              noSoldier.add(p.id);
              continue;
            }
            if (p.pose.hp <= 0) continue;
            checked++;
            // A pose sampled between the view's frames can lead it by one snapshot (respawn,
            // switch): only a mismatch that is still there 200 ms later counts.
            const key = `${p.id}:${f.soldier.weapon}≠${held(p)}`;
            if (f.soldier.weapon !== held(p)) {
              if (pending.has(key)) wrong.add(key);
              else transient++;
              next.add(key);
            }
            if (f.soldier.actionClip) clips.add(f.soldier.actionClip);
            if (f.soldier.flinchClip) clips.add(f.soldier.flinchClip);
          }
        }
        return {
          checked,
          wrong: [...wrong],
          transient,
          noSoldier: [...noSoldier],
          clips: [...clips],
        };
      }, SCAN_OF);
      const c = new Checks();
      c.ok(r.noSoldier.length === 0, `no soldier for ${r.noSoldier.join(', ')}`);
      c.ok(r.checked > 0, 'no live remote to check');
      c.ok(r.wrong.length === 0, `soldier weapon ≠ snapshot: ${r.wrong.join(', ')}`);
      c.ok(r.clips.length > 0, 'no bot played any action/flinch layer in 12 s');
      c.note(
        `${r.checked} samples (${r.transient} one-sample mismatches), layers seen: ${r.clips.join(' ') || 'none'}`,
      );
      return c.done();
    },
  );

  await step(O, 'snapshots arrive at ~30/s', async () => {
    const r = await ev(async () => {
      const fs = window.__fs;
      const s = fs.g().online;
      let n = 0;
      const orig = s.handleSnapshot;
      s.handleSnapshot = function (...a) {
        n++;
        return orig.apply(this, a);
      };
      await fs.wait(3000);
      s.handleSnapshot = orig;
      return n / 3;
    });
    if (r < 25 || r > 35) throw new Error(`${fmt(r, 1)} snapshots/s`);
    return `${fmt(r, 1)}/s`;
  });

  await step(
    O,
    'combat: bots take damage, deal damage; kill feed + score line update',
    async () => {
      const r = await ev(
        async ([fireBit, adsBit, jumpBit]) => {
          const fs = window.__fs;
          const g = fs.g();
          const s = g.online;
          const out = {
            botHurt: false,
            meHurt: false,
            kills: 0,
            myHits: 0,
            myShots: 0,
            aimFrames: 0,
            maxAds: 0,
            feed: 0,
            score: '',
            respawns: [],
          };
          const t0 = performance.now();
          const hits0 = g.stats.hits;
          let diedAt = null;
          let lifeAtDeath = 0;
          // Only deaths seen happen count: already dead when the loop starts (killed while an
          // earlier step idled) would time a respawn from partway through its delay.
          let seenAlive = g.player.health > 0;
          let lastShot = g.player.guns.rifle.shotCounter;
          while (performance.now() - t0 < 90_000) {
            const now = performance.now();
            // Deaths and respawns as they happen (server-owned health and life).
            if (g.player.health > 0 && diedAt === null) seenAlive = true;
            if (diedAt === null && seenAlive && g.player.health <= 0) {
              diedAt = now;
              lifeAtDeath = s.currentLife;
            } else if (
              diedAt !== null &&
              g.player.health === 100 &&
              s.currentLife !== lifeAtDeath
            ) {
              out.respawns.push((now - diedAt) / 1000);
              diedAt = null;
            }
            const w = g.player.guns.rifle;
            if (w.shotCounter > lastShot) out.myShots += w.shotCounter - lastShot;
            lastShot = w.shotCounter;
            const me = g.player.move.pos;
            const eye = { x: me.x, y: me.y + g.player.move.eyeHeight, z: me.z };
            let best = null;
            for (const p of s.remotePlayers(now)) {
              if (p.pose.hp < 100 && p.pose.hp >= 0) out.botHurt = true;
              if (p.pose.hp <= 0) continue;
              const to = { x: p.pose.x, y: p.pose.y + 1.2, z: p.pose.z };
              const d = { x: to.x - eye.x, y: to.y - eye.y, z: to.z - eye.z };
              const len = Math.hypot(d.x, d.y, d.z);
              if (len > 45) continue;
              const hit = g.physics.castRay(eye, { x: d.x / len, y: d.y / len, z: d.z / len }, len);
              if (hit && hit.distance < len - 0.5) continue;
              if (!best || len < best.len) best = { len, to };
            }
            let near = null;
            for (const p of s.remotePlayers(now)) {
              if (p.pose.hp <= 0) continue;
              const dd = Math.hypot(p.pose.x - me.x, p.pose.z - me.z);
              if (!near || dd < near.d) near = { d: dd, x: p.pose.x, z: p.pose.z };
            }
            if (best) {
              out.aimFrames++;
              out.maxAds = Math.max(out.maxAds, fs.gun()?.adsAmount ?? 0);
              window.__wd.look(
                Math.atan2(-(best.to.x - eye.x), -(best.to.z - eye.z)),
                Math.atan2(best.to.y - eye.y, Math.hypot(best.to.x - eye.x, best.to.z - eye.z)),
              );
              // Aimed short bursts (0.2 s on, 0.25 s off): hip spray at 30 m mostly misses.
              const burst = (now - t0) % 450 < 200;
              window.__wd.hold(adsBit | (burst && fs.gun()?.adsAmount > 0.9 ? fireBit : 0));
            } else if (near && g.player.health > 0) {
              // Nobody in sight: walk toward the nearest bot (a hop now and then over clutter).
              window.__wd.look(Math.atan2(-(near.x - me.x), -(near.z - me.z)), 0);
              window.__wd.hold((now - t0) % 1500 < 50 ? jumpBit : 0, 0, 1);
            } else window.__wd.hold(0);
            if (g.player.health < 100) out.meHurt = true;
            const scores = s.match?.scores ?? [];
            out.kills = scores.reduce((a, x) => a + x.kills, 0);
            out.feed = window.__feed ?? 0;
            out.score = document.querySelector('[data-testid=match-score]')?.textContent ?? '';
            out.myHits = g.stats.hits - hits0;
            if (
              out.botHurt &&
              out.meHurt &&
              out.myHits > 0 &&
              out.kills > 0 &&
              out.feed > 0 &&
              out.score &&
              out.respawns.length > 0
            )
              break;
            await fs.raf();
          }
          window.__wd.hold(0);
          out.ms = performance.now() - t0;
          window.__fsRespawns = out.respawns;
          return out;
        },
        [B.Fire, B.Ads, B.Jump],
      );
      await shot('online-combat');
      const c = new Checks();
      c.ok(r.botHurt, 'no bot ever below 100 HP');
      c.ok(
        r.myHits > 0,
        `the server never confirmed a hit of mine on a bot (${r.myShots} aimed shots in ${fmt(r.ms / 1000, 0)} s, ${r.aimFrames} frames with a bot in sight, max ADS ${fmt(r.maxAds)})`,
      );
      c.ok(r.meHurt, 'bots never damaged the player');
      c.ok(r.kills > 0, 'no kills on the scoreboard');
      c.ok(r.feed > 0, 'kill feed never showed a line');
      c.ok(r.score.length > 0, 'match score line empty');
      c.note(
        `${fmt(r.ms / 1000, 1)} s, my shots ${r.myShots} / confirmed hits ${r.myHits}, kills ${r.kills}, feed ${r.feed}, respawns ${r.respawns.map((x) => fmt(x, 1)).join(',') || 'none'}, score "${r.score}"`,
      );
      return c.done();
    },
    { timeout: 110_000 },
  );

  await step(
    O,
    `death → respawn after ${MATCH.respawnDelay} s (own frag at my feet, else the bots)`,
    async () => {
      const seen = await ev(() => window.__fsRespawns ?? []);
      if (seen.length) {
        const bad = seen.filter((x) => Math.abs(x - MATCH.respawnDelay) > 1);
        if (bad.length)
          throw new Error(`respawn delays ${seen.map((x) => fmt(x, 1)).join(', ')} s`);
        return `${seen.length} death(s) during combat, back after ${seen.map((x) => fmt(x, 1)).join(', ')} s`;
      }
      await until('fs.g().player.health > 0', 8000);
      const r = await ev(
        async ([gr, delay]) => {
          const fs = window.__fs;
          const g = fs.g();
          const life0 = g.online.currentLife;
          await fs.until(() => g.player.arsenal.grenades > 0 && g.player.health > 0, 6000);
          const nades0 = g.player.arsenal.grenades;
          window.__wd.look(g.input.yaw, -1.5);
          window.__wd.tap(gr);
          const thrown = await fs.until(() => g.player.arsenal.grenades < nades0, 1500);
          const t0 = performance.now();
          let minHp = g.player.health;
          const dead = await fs.until(() => {
            minHp = Math.min(minHp, g.player.health);
            return g.player.health <= 0;
          }, 60000);
          const byFrag = dead.ok && dead.t < 4500;
          const back = await fs.until(
            () => g.player.health === 100 && g.online.currentLife !== life0,
            (delay + 4) * 1000,
          );
          return {
            thrown: thrown.ok,
            minHpAfterFrag: minHp,
            dead: dead.ok,
            deadMs: performance.now() - t0 - back.t,
            byFrag,
            back: back.ok,
            backMs: back.t,
            life0,
            life1: g.online.currentLife,
          };
        },
        [B.Grenade, MATCH.respawnDelay],
      );
      const c = new Checks();
      c.ok(r.thrown, 'Grenade tap did not spend the frag online');
      c.ok(r.dead, 'never died within 60 s');
      c.ok(r.back, `no respawn within ${MATCH.respawnDelay + 4} s of dying`);
      c.ok(
        !r.back || Math.abs(r.backMs / 1000 - MATCH.respawnDelay) < 1,
        `respawned ${fmt(r.backMs / 1000)} s after dying`,
      );
      c.ok(r.life1 !== r.life0, `life ${r.life0} → ${r.life1}`);
      c.note(
        `died ${r.byFrag ? 'to my own frag' : 'to a bot'} after ${fmt(r.deadMs / 1000)} s, back after ${fmt(r.backMs / 1000)} s, life ${r.life0}→${r.life1}`,
      );
      return c.done();
    },
    { timeout: 90_000 },
  );

  await step(O, 'reconnect after a dropped socket (same seat)', async () => {
    const r = await ev(async () => {
      const fs = window.__fs;
      const g = fs.g();
      const room = g.onlineLink.room;
      if (!room?.connection) return { error: 'no room connection handle' };
      const id0 = g.online.id;
      const states = [];
      const seen = () => {
        const st = g.online.status.state;
        if (states[states.length - 1] !== st) states.push(st);
      };
      room.connection.close(4010, 'feature sweep drop');
      const drop = await fs.until(() => {
        seen();
        return g.online.status.state === 'reconnecting';
      }, 3000);
      const back = await fs.until(() => {
        seen();
        return g.online.status.state === 'online';
      }, 15000);
      let n = 0;
      const orig = g.online.handleSnapshot;
      g.online.handleSnapshot = function (...a) {
        n++;
        return orig.apply(this, a);
      };
      await fs.wait(1000);
      g.online.handleSnapshot = orig;
      return {
        drop: drop.ok,
        back: back.ok,
        ms: back.t,
        same: g.online.id === id0,
        states,
        snaps: n,
      };
    });
    if (r.error) throw new Error(r.error);
    const c = new Checks();
    c.ok(r.drop, `status never went 'reconnecting' (${r.states.join('→')})`);
    c.ok(r.back, `not back online in 15 s (${r.states.join('→')})`);
    c.ok(r.same, 'came back with a different player id');
    c.ok(r.snaps > 20, `${r.snaps} snapshots in the first second back`);
    c.note(`${r.states.join('→')} in ${fmt(r.ms / 1000, 1)} s`);
    return c.done();
  });

  await step(O, 'shader programs stable during online play (no links after joining)', async () => {
    const added = await ev(
      (b) => window.__fs.programNames().filter((n) => !b.includes(n)),
      joinNames,
    );
    const p = await programs();
    if (added.length || p !== joinNames.length)
      throw new Error(`${joinNames.length} → ${p} programs; linked: ${added.join(' ')}`);
    return `${p} programs`;
  });

  await page.context().close();
  page = null;
}

// ---------------------------------------------------------------------------------------------

try {
  if (OFFLINE) {
    offlinePhase = true;
    await offline();
    offlinePhase = false;
  }
  if (ONLINE) await online();
} catch (e) {
  results.push({
    section: 'runner',
    name: 'crash',
    status: 'FAIL',
    reason: String(e?.stack ?? e),
    ms: 0,
  });
  console.error(e);
} finally {
  await browser.close();
}

const pad = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
console.log(`\n==== Feature sweep (${GPU}${BASIC ? ', basic' : ''}) — screenshots in ${OUT} ====`);
console.log(`${pad('STATUS', 6)} ${pad('SECTION', 14)} ${pad('CHECK', 78)} DETAIL`);
for (const r of results) {
  console.log(
    `${pad(r.status, 6)} ${pad(r.section, 14)} ${pad(r.name, 78)} ${r.reason.slice(0, 400)}`,
  );
}
const n = (s) => results.filter((r) => r.status === s).length;
if (ONLY && onlyMatched === 0)
  results.push({
    section: 'runner',
    name: `--only=${ONLY}`,
    status: 'FAIL',
    reason: 'matched no check',
    ms: 0,
  });
console.log(
  `\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('WARN')} warnings (timing only), ${n('SKIP')} skipped`,
);
process.exit(n('FAIL') ? 1 : 0);
