import { expect, test, type Page } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

/** Plac Defilad (M2): the real block loads, renders, and the map-size options resolve. */
const until = (page: Page, predicate: string, timeout = 60_000): Promise<unknown> =>
  page.waitForFunction(predicate, undefined, { timeout, polling: 50 });

type State = {
  map: { name: string; spawns: number; bounds: { minZ: number; maxZ: number } };
  pos: { x: number; y: number; z: number };
};

async function load(page: Page, settings: Record<string, unknown>): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    (s) => localStorage.setItem('wd.settings.v1', JSON.stringify(s)),
    settings,
  );
  await page.goto('/?autotest');
  // The whole block builds more than the Market: twice the boot budget.
  await until(page, 'window.__wd?.ready === true', 2 * BOOT_MS);
  return errors;
}

const state = (page: Page): Promise<State> =>
  page.evaluate(() => (window as unknown as { __wd: { state: () => State } }).__wd.state());

async function view(
  page: Page,
  name: string,
  at: [number, number, number, number, number],
): Promise<void> {
  await page.evaluate((a) => {
    (window as unknown as { __wd: { teleport: (...x: number[]) => void } }).__wd.teleport(...a);
  }, at);
  // Let a few frames render (shadows, AO) before capturing.
  await page.evaluate(() => new Promise((r) => setTimeout(r, 1500)));
  await page.screenshot({ path: `e2e/artifacts/defilad-${name}.png` });
}

test.use({ viewport: { width: 1280, height: 720 } });

test('Plac Defilad loads at full size and renders the key areas', async ({ page }) => {
  test.setTimeout(2 * BOOT_MS + 420_000); // boot, then 7 views of the whole block under software WebGL
  const errors = await load(page, {
    map: 'defilad',
    mapSize: 'full',
    quality: 'low',
    weather: 'sunny',
  });
  const s = await state(page);
  expect(s.map.name).toBe('Plac Defilad');
  expect(s.map.spawns).toBeGreaterThanOrEqual(24);
  await view(page, 'palace-from-plaza', [150, 0.05, -5, Math.PI / 2, 0.32]);
  await view(page, 'construction-site', [118, 0.05, -80, -0.45, 0.14]);
  await view(page, 'north-square', [10, 0.05, -125, Math.PI, 0.25]);
  await view(page, 'underpass', [231, -4.95, 150, 0, 0.05]);
  await view(page, 'marszalkowska', [275, 0.05, 20, 0, 0.05]);
  await view(page, 'park-cover', [40, 0.05, -200, 0.3, 0.0]);
  await view(page, 'south-gardens', [-60, 0.05, 180, Math.PI * 0.95, 0.0]);
  expect(errors).toEqual([]);
});

test('map size option: south half spawns and bounds stay south of the cut', async ({ page }) => {
  test.setTimeout(2 * BOOT_MS + 120_000);
  const errors = await load(page, { map: 'defilad', mapSize: 'south', quality: 'low' });
  const s = await state(page);
  expect(s.map.name).toMatch(/South half/);
  expect(s.map.spawns).toBeGreaterThanOrEqual(12);
  expect(s.pos.z).toBeGreaterThan(s.map.bounds.minZ);
  expect(errors).toEqual([]);
});

test('Market (close quarters): dense cover, uplink gives a radar charge you call in', async ({
  page,
}) => {
  test.setTimeout(2 * BOOT_MS + 240_000);
  // Functional test: quarter the pixels so sim time keeps up under software WebGL (the dressed
  // Market is heavy; screenshots of the key areas stay full-size in the test above).
  await page.setViewportSize({ width: 640, height: 360 });
  const errors = await load(page, {
    map: 'defilad',
    mapSize: 'market',
    quality: 'low',
    weather: 'sunny',
  });
  const s = await state(page);
  expect(s.map.name).toMatch(/Market/);
  expect(s.map.spawns).toBeGreaterThanOrEqual(8);
  await view(page, 'market-forecourt', [60, 0.05, 2, -Math.PI / 2 + 0.2, 0.05]);
  await view(page, 'market-alley', [116, 0.05, 40, 0, 0.02]);
  await view(page, 'market-hall-upstairs', [134, 3.65, 18, -Math.PI / 2, -0.05]);
  await view(page, 'market-metro', [70, -4.95, 0, -Math.PI / 2, 0.02]);
  // Walk onto the hall's upstairs uplink.
  const up = await page.evaluate(() => {
    const w = (
      window as unknown as {
        __wd: {
          state: () => {
            radar: { pickups: { id: string; pos: { x: number; y: number; z: number } }[] };
          };
        };
      }
    ).__wd;
    return w.state().radar.pickups.find((p) => p.pos.y > 3)!.pos;
  });
  await page.evaluate((p) => {
    (window as unknown as { __wd: { teleport: (...a: number[]) => void } }).__wd.teleport(
      p.x - 0.4,
      p.y + 0.05,
      p.z,
      0,
      0,
    );
  }, up);
  // Collecting stores a charge — it does NOT reveal anyone.
  await page.waitForFunction('window.__wd.state().radar.charges === 1', undefined, {
    timeout: 30_000,
  });
  expect(await page.evaluate('window.__wd.state().radar.live')).toBe(0);
  await page.screenshot({ path: 'e2e/artifacts/market-radar-ready.png' });
  // Calling it in (the Radar key) turns the radar on and spends the charge.
  await page.evaluate('window.__wd.tap(16384)'); // Button.Radar
  await page.waitForFunction('window.__wd.state().radar.live > 0', undefined, { timeout: 30_000 });
  expect(await page.evaluate('window.__wd.state().radar.charges')).toBe(0);
  await page.screenshot({ path: 'e2e/artifacts/market-radar-live.png' });
  const after = (await page.evaluate(
    () =>
      (
        window as unknown as {
          __wd: { state: () => { radar: { pickups: { cooldown: number }[] } } };
        }
      ).__wd.state().radar.pickups,
  )) as { cooldown: number }[];
  expect(after.some((p) => p.cooldown > 0)).toBe(true);
  expect(errors).toEqual([]);
});
