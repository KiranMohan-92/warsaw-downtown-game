import { expect, test, type Page } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

/** Button bits, mirrored from packages/shared/src/sim/input.ts. */
const B = { Jump: 1, Sprint: 2, Crouch: 4, Fire: 8, Ads: 16, Reload: 32 } as const;

interface Snap {
  pos: { x: number; y: number; z: number };
  grounded: boolean;
  crouched: boolean;
  ammo: number;
  reserve: number;
  reloading: boolean;
  adsAmount: number;
  stats: { shots: number; hits: number; kills: number };
  drawCalls: number;
  overlaps: boolean;
}

const state = (page: Page): Promise<Snap> =>
  page.evaluate(() => (window as unknown as { __wd: { state: () => Snap } }).__wd.state());
const call = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const wd = (window as unknown as { __wd: Record<string, (...x: unknown[]) => unknown> }).__wd;
      return wd[f]!(...a);
    },
    [fn, args] as const,
  );
/** Wait in game-time terms (the sim may run slower than real time under software WebGL). */
const until = (page: Page, predicate: string, timeout = 20_000): Promise<unknown> =>
  page.waitForFunction(predicate, undefined, { timeout, polling: 50 });

test.use({ viewport: { width: 1920, height: 1080 } });

test('M1: move, shoot, reload, ADS in the greybox range', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  test.setTimeout(BOOT_MS + 180_000);
  // Functional test: Low quality keeps software WebGL (no GPU in CI) near real time.
  await page.addInitScript(() => {
    localStorage.setItem('wd.settings.v1', JSON.stringify({ map: 'range', quality: 'low' }));
  });

  await page.goto('/?autotest');
  await until(page, 'window.__wd?.ready === true', BOOT_MS);
  await until(page, '__wd.state().grounded === true');

  // Spawn view
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'e2e/artifacts/m1-spawn.png' });

  // Walk forward: z decreases (yaw 0 looks down -Z), stays on the ground, never overlaps.
  const z0 = (await state(page)).pos.z;
  await call(page, 'hold', 0, 0, 1);
  await until(page, `__wd.state().pos.z < ${z0 - 2}`);
  await call(page, 'hold', B.Jump, 0, 1);
  await until(page, '__wd.state().pos.y > 0.5');
  await call(page, 'hold', 0, 0, 0);
  await until(page, '__wd.state().grounded === true');
  expect((await state(page)).overlaps).toBe(false);

  // Shoot the near dummy (10 m ahead) in the torso.
  await call(page, 'teleport', 0, 0.02, 0, 0, Math.atan2(1.17 - 1.62, 10));
  await until(page, '__wd.state().grounded === true');
  await call(page, 'hold', B.Fire);
  await until(page, '__wd.state().stats.hits >= 3');
  await page.screenshot({ path: 'e2e/artifacts/m1-hipfire.png' });
  await call(page, 'hold', 0);
  const afterFire = await state(page);
  expect(afterFire.ammo).toBeLessThan(30);
  const dummies = (await call(page, 'dummies')) as { id: string; health: number }[];
  const near = dummies.find((d) => d.id === 'd-near')!;
  expect(near.health).toBeLessThan(100);

  // Reload restores the magazine from reserve.
  await call(page, 'hold', B.Reload);
  await until(page, '__wd.state().reloading === true');
  await call(page, 'hold', 0);
  await until(page, '__wd.state().reloading === false && __wd.state().ammo === 30');
  expect((await state(page)).reserve).toBeLessThan(120);

  // ADS on the far dummy.
  await call(page, 'teleport', 3, 0.02, -20, 0, Math.atan2(1.3 - 1.62, 25));
  await call(page, 'hold', B.Ads);
  await until(page, '__wd.state().adsAmount === 1');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/artifacts/m1-ads.png' });
  await call(page, 'hold', 0);

  // Crouch.
  await call(page, 'hold', B.Crouch);
  await until(page, '__wd.state().crouched === true');
  await call(page, 'hold', 0);
  await until(page, '__wd.state().crouched === false');

  // Two-storey building: ground floor looking at the stairwell, then the upper floor.
  await call(page, 'teleport', 24, 0.2, -7, Math.PI * 0.62, -0.05);
  await until(page, '__wd.state().grounded === true');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/artifacts/m1-interior.png' });
  await call(page, 'teleport', 24, 3.65, -3, Math.PI / 2, -0.05);
  await until(page, '__wd.state().grounded === true');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'e2e/artifacts/m1-upper-floor.png' });

  const final = await state(page);
  expect(final.overlaps).toBe(false);
  expect(final.drawCalls).toBeLessThan(80);
  expect(errors).toEqual([]);
});
