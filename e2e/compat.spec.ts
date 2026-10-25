import { expect, test, type Page } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

/**
 * Cross-browser compatibility (Chromium, Firefox, WebKit/Safari): the game must boot and play in
 * whatever browser a friend has. Covers the engine-sensitive parts — WebGL2 rendering, Rapier
 * WASM, the real map build, the fixed-step sim, hit registration — with zero console errors.
 */
const wd = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const w = (window as unknown as { __wd: Record<string, (...x: unknown[]) => unknown> }).__wd;
      return w[f]!(...a);
    },
    [fn, args] as const,
  );
type State = { pos: { x: number; z: number }; map: { name: string; spawns: number } };

test('boots, builds the real map, simulates and registers hits', async ({ page, browserName }) => {
  test.setTimeout(BOOT_MS + 240_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() =>
    localStorage.setItem(
      'wd.settings.v1',
      // The Market (the map people play): every engine runs the real map code, while a full-block
      // frame under software WebGL took the test past its budget (defilad.spec covers the block).
      JSON.stringify({ map: 'defilad', mapSize: 'market', quality: 'low' }),
    ),
  );
  await page.goto('/?autotest');
  expect(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))).toBe(
    true,
  );
  await page.waitForFunction('window.__wd?.ready === true', undefined, { timeout: BOOT_MS });
  const s = (await wd(page, 'state')) as State;
  expect(s.map.name).toMatch(/^Plac Defilad .*Market/);
  expect(s.map.spawns).toBeGreaterThanOrEqual(8);

  // The sim runs: walk forward across the plaza.
  // Along dummy pd3's patrol line (kept clear of cover), walking north.
  await wd(page, 'teleport', 90.6, 0.05, 5, 0, 0);
  await page.waitForTimeout(500);
  const before = ((await wd(page, 'state')) as State).pos;
  await wd(page, 'hold', 0, 0, 1);
  await page.waitForFunction(
    (b) => {
      const p = (window as unknown as { __wd: { state: () => State } }).__wd.state().pos;
      return Math.hypot(p.x - b.x, p.z - b.z) > 2;
    },
    before,
    { timeout: 60_000 },
  );
  await wd(page, 'hold', 0);

  // Hits register: stand in front of practice dummy pd1 (x 76, z −8) and fire.
  await wd(page, 'teleport', 80, 0.05, -8, Math.PI / 2, -0.12); // pd1 at x 76: aim at the chest
  await page.waitForTimeout(500);
  await wd(page, 'hold', 8); // Fire
  await page.waitForFunction('window.__wd.state().stats.hits > 0', undefined, { timeout: 60_000 });
  await wd(page, 'hold', 0);
  // The game server connection works in every engine.
  await page.waitForFunction(
    () => document.body.innerText.includes('server: connected'),
    undefined,
    {
      timeout: 60_000,
    },
  );
  await page.screenshot({ path: `e2e/artifacts/compat-${browserName}.png` });
  // Known benign SDK noise: @colyseus/sdk first tries Node's `new WebSocket(url, {headers})`,
  // catches the browser's error and retries the browser form; WebKit logs the first attempt.
  const real = errors.filter((e) => !/Wrong protocol for WebSocket '\[object Object\]'/.test(e));
  expect(real).toEqual([]);
});
