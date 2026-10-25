import { expect, test, type Page } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

/** Button bits, mirrored from packages/shared/src/sim/input.ts. */
const B = { Fire: 8, Slot3: 1024, Block: 8192 };

const wd = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const w = (window as unknown as { __wd: Record<string, (...x: unknown[]) => unknown> }).__wd;
      return w[f]!(...a);
    },
    [fn, args] as const,
  );
const until = (page: Page, predicate: string, timeout = 30_000): Promise<unknown> =>
  page.waitForFunction(predicate, undefined, { timeout, polling: 30 });

// Small viewport: the parry/counter windows are a few hundred ms of wall time, and under software
// WebGL the sim only advances as fast as frames render (steps per frame are capped).
test.use({ viewport: { width: 640, height: 360 } });

test('sparring partner attacks with tells; blocking on the tell parries; the counter lands', async ({
  page,
}) => {
  test.setTimeout(BOOT_MS + 180_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() =>
    localStorage.setItem(
      'wd.settings.v1',
      JSON.stringify({ map: 'range', quality: 'low', sparring: true }),
    ),
  );
  await page.goto('/?autotest');
  await until(page, 'window.__wd?.ready === true && __wd.state().partner?.alive === true', BOOT_MS);

  // 1) It closes in and attacks through the real input path; the HUD tell shows the chamber.
  await until(
    page,
    "document.querySelector('[data-testid=knife-tell]').classList.contains('show')",
    60_000,
  );
  await page.screenshot({ path: 'e2e/artifacts/sparring-tell.png' });
  // It lands the strike: either we're hurt, or it killed us and we respawned elsewhere.
  await until(page, '__wd.state().health < 100 || __wd.state().stats.deaths > 0', 60_000);
  // Stand 6 m from it again (a respawn can put us across the range) so the parry step is
  // about parrying, not about the partner's pathing.
  await page.evaluate(() => {
    const w = (
      window as unknown as {
        __wd: {
          state: () => { partner: { pos: { x: number; z: number } } };
          teleport: (...a: number[]) => void;
        };
      }
    ).__wd;
    const p = w.state().partner.pos;
    w.teleport(p.x, 0.05, p.z + 6, 0, 0);
  });

  // 2) Parry: raise the guard the moment the partner starts chambering.
  let parried = false;
  for (let attempt = 0; attempt < 8 && !parried; attempt++) {
    await wd(page, 'hold', 0);
    await until(page, "__wd.state().partner.melee === 'windup'", 60_000);
    await wd(page, 'hold', B.Block);
    try {
      await until(page, '__wd.state().partner.stun > 0', 1_500);
      parried = true;
    } catch {
      // too early/late this time (it may also have been a fast follow-up); try the next one
    }
  }
  expect(parried).toBe(true);
  await page.screenshot({ path: 'e2e/artifacts/sparring-parry.png' });

  // 3) Counter: drop the guard, draw the knife, strike while it's stunned.
  const before = (await wd(page, 'state')) as { partner: { health: number } };
  await wd(page, 'hold', 0);
  await wd(page, 'tap', B.Slot3);
  await until(page, "__wd.state().slot === 'knife'");
  // Face the partner (the parry shoves it back, often off-centre), then keep striking,
  // re-aiming each attempt as it moves.
  const landed = `__wd.state().partner.health < ${before.partner.health} || __wd.state().partner.alive === false`;
  let countered = false;
  for (let attempt = 0; attempt < 20 && !countered; attempt++) {
    const s = (await wd(page, 'state')) as {
      pos: { x: number; z: number };
      partner: { pos: { x: number; z: number } };
    };
    // The parry shoves it back out of knife reach: step in to 1.3 m, like a player would.
    const dx = s.partner.pos.x - s.pos.x;
    const dz = s.partner.pos.z - s.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    const yaw = Math.atan2(-dx, -dz);
    if (d > 1.6) {
      await wd(
        page,
        'teleport',
        s.partner.pos.x - (dx / d) * 1.3,
        0.05,
        s.partner.pos.z - (dz / d) * 1.3,
        yaw,
        -0.1,
      );
    }
    await wd(page, 'look', yaw, -0.1);
    await wd(page, 'hold', B.Fire);
    try {
      await until(page, landed, 600);
      countered = true;
    } catch {
      // out of reach or it moved; re-aim and go again
    }
  }
  await wd(page, 'hold', 0);
  expect(countered).toBe(true);
  expect(errors).toEqual([]);
});

test('sparring partner gets around cover instead of pressing into it', async ({ page }) => {
  test.setTimeout(BOOT_MS + 120_000);
  await page.addInitScript(() =>
    localStorage.setItem(
      'wd.settings.v1',
      JSON.stringify({ map: 'range', quality: 'low', sparring: true }),
    ),
  );
  await page.goto('/?autotest');
  await until(page, 'window.__wd?.ready === true && __wd.state().partner?.alive === true', BOOT_MS);
  // Stand 2.3 m behind the low wall (x 2..5, z 39.8..40.2); the partner comes from z≈30, so its
  // straight line runs into the wall.
  await wd(page, 'teleport', 3.5, 0.05, 42.5, Math.PI, 0);
  await until(
    page,
    'Math.hypot(__wd.state().partner.pos.x - __wd.state().pos.x, __wd.state().partner.pos.z - __wd.state().pos.z) < 2.3',
    60_000,
  );
});
