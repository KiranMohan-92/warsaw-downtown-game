import { expect, test, type Page } from '@playwright/test';

/** Tactical kit in the Market: smoke (H), recon drone (B, from a drone uplink), jammer (J). */
const B = { Jump: 1, Smoke: 1 << 15, Drone: 1 << 16, Jammer: 1 << 17 };
type Tac = {
  smokes: number;
  jammers: number;
  droneCharges: number;
  flying: boolean;
  spotted: string[];
  smokeClouds: number;
};
const wd = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const w = (window as unknown as { __wd: Record<string, (...x: unknown[]) => unknown> }).__wd;
      return w[f]!(...a);
    },
    [fn, args] as const,
  );
const tac = async (page: Page): Promise<Tac> =>
  ((await wd(page, 'state')) as { tactical: Tac }).tactical;
const until = (page: Page, predicate: string, timeout = 30_000): Promise<unknown> =>
  page.waitForFunction(predicate, undefined, { timeout, polling: 50 });

// Small viewport: under software WebGL the Market runs < 1 fps at 720p, and the sim caps steps
// per frame, so game time crawls (a 1.5 s smoke fuse could exceed the wait). Quarter the pixels.
test.use({ viewport: { width: 640, height: 360 } });

test('smoke blooms, the recon drone spots players, the jammer pulses', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() =>
    localStorage.setItem(
      'wd.settings.v1',
      JSON.stringify({ map: 'defilad', mapSize: 'market', quality: 'low', weather: 'sunny' }),
    ),
  );
  await page.goto('/?autotest');
  await until(page, 'window.__wd?.ready === true', 180_000);

  // Smoke: thrown ahead, pops into a cloud.
  await wd(page, 'teleport', 70, 0.05, 8, Math.PI / 2, -0.1);
  await until(page, 'window.__wd.state().grounded === true');
  await wd(page, 'tap', B.Smoke);
  await until(page, 'window.__wd.state().tactical.smokes === 0');
  await until(page, 'window.__wd.state().tactical.smokeClouds === 1', 60_000);
  expect((await tac(page)).smokes).toBe(0);
  await page.waitForTimeout(2500); // bloom
  await page.screenshot({ path: 'e2e/artifacts/tactical-smoke.png' });

  // Drone uplink (market hall ground floor) → charge.
  const pickups = (
    (await wd(page, 'state')) as {
      radar: { pickups: { id: string; pos: { x: number; y: number; z: number } }[] };
    }
  ).radar.pickups;
  const up = pickups.find((p) => p.id.startsWith('drone'))!;
  await wd(page, 'teleport', up.pos.x - 0.4, up.pos.y + 0.05, up.pos.z, 0, 0);
  await until(page, 'window.__wd.state().tactical.droneCharges === 1');

  // Launch near the forecourt dummies, climb and look down at them: they get spotted.
  await wd(page, 'teleport', 100, 0.05, 2, Math.PI / 2, 0);
  await page.waitForTimeout(300);
  await wd(page, 'tap', B.Drone);
  await until(page, 'window.__wd.state().tactical.flying === true');
  await wd(page, 'hold', B.Jump); // climb
  await page.waitForTimeout(1500);
  await wd(page, 'hold', 0);
  await wd(page, 'look', Math.PI / 2, -0.45);
  await until(page, 'window.__wd.state().tactical.spotted.length > 0');
  await page.screenshot({ path: 'e2e/artifacts/tactical-drone.png' });
  await wd(page, 'tap', B.Drone); // return
  await until(page, 'window.__wd.state().tactical.flying === false');
  await page.screenshot({ path: 'e2e/artifacts/tactical-radar-spotted.png' });

  // Jammer: one pulse per life.
  await wd(page, 'tap', B.Jammer);
  await until(page, 'window.__wd.state().tactical.jammers === 0');
  await page.waitForTimeout(250);
  await page.screenshot({ path: 'e2e/artifacts/tactical-jammer.png' });
  expect(errors).toEqual([]);
});
