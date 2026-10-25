import { expect, test, type Page } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~25–45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

/** Button bits, mirrored from packages/shared/src/sim/input.ts. */
const B = { Fire: 8, Ads: 16, Melee: 64, Grenade: 128, Slot1: 256, Slot2: 512, Slot3: 1024 };

type WD = {
  __wd: {
    state: () => Record<string, unknown>;
    dummies: () => { id: string; health: number }[];
    hold: (buttons: number, moveX?: number, moveZ?: number) => void;
    teleport: (x: number, y: number, z: number, yaw?: number, pitch?: number) => void;
  };
};
const wd = (page: Page, fn: string, ...args: unknown[]): Promise<unknown> =>
  page.evaluate(
    ([f, a]) => {
      const w = (window as unknown as WD).__wd as unknown as Record<
        string,
        (...x: unknown[]) => unknown
      >;
      return w[f]!(...a);
    },
    [fn, args] as const,
  );
const until = (page: Page, predicate: string, timeout = 30_000): Promise<unknown> =>
  page.waitForFunction(predicate, undefined, { timeout, polling: 50 });
/** One latched tap (can't be lost to a slow software-rendered frame). */
const tap = (page: Page, buttons: number): Promise<unknown> => wd(page, 'tap', buttons);
const dummy = (id: string) => `__wd.dummies().find((d) => d.id === '${id}').health`;

async function boot(page: Page, matchMode = 'standard'): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(
    (mode) =>
      localStorage.setItem(
        'wd.settings.v1',
        JSON.stringify({ map: 'range', quality: 'low', matchMode: mode }),
      ),
    matchMode,
  );
  await page.goto('/?autotest');
  await until(page, 'window.__wd?.ready === true && __wd.state().grounded === true', BOOT_MS);
  return errors;
}

test.use({ viewport: { width: 1280, height: 720 } });

test('switch to pistol, knife and quick-knife the near dummy', async ({ page }) => {
  test.setTimeout(BOOT_MS + 180_000);
  const errors = await boot(page);
  expect(await wd(page, 'state')).toMatchObject({ slot: 'rifle', grenades: 1 });

  // 2 → pistol; one tap = one shot.
  await tap(page, B.Slot2);
  await until(page, "__wd.state().slot === 'sidearm'");
  await tap(page, B.Fire);
  await until(page, '__wd.state().ammo === 14');
  await page.screenshot({ path: 'e2e/artifacts/arsenal-pistol.png' });

  // 3 → knife; stand next to the near dummy and slash it to death (2 hits).
  await wd(page, 'teleport', 0, 0.02, -8.9, 0, -0.35);
  await tap(page, B.Slot3);
  await until(page, "__wd.state().slot === 'knife'");
  await wd(page, 'hold', B.Fire);
  await until(page, `${dummy('d-near')} === 0`);
  await wd(page, 'hold', 0);
  await page.screenshot({ path: 'e2e/artifacts/arsenal-knife.png' });

  // Back to the rifle, then Q quick-knife: hits without leaving the rifle.
  await tap(page, B.Slot1);
  await until(page, "__wd.state().slot === 'rifle'");
  await until(page, `${dummy('d-near')} === 100`); // dummy respawned
  // The combo's lunges carried us past the dummy (dummies have no collision body); step back.
  await wd(page, 'teleport', 0, 0.02, -8.9, 0, -0.35);
  const hits = ((await wd(page, 'state')) as { stats: { hits: number } }).stats.hits;
  await tap(page, B.Melee);
  await until(page, `__wd.state().stats.hits > ${hits}`);
  expect(await wd(page, 'state')).toMatchObject({ slot: 'rifle' });
  expect(errors).toEqual([]);
});

test('frag grenade bounces, explodes, and damages the dummy (and the careless thrower)', async ({
  page,
}) => {
  test.setTimeout(BOOT_MS + 180_000);
  const errors = await boot(page);
  // 2.5 m from the mid dummy, looking almost straight down: a frag dropped at your own feet.
  await wd(page, 'teleport', -4, 0.02, -22.5, 0, -1.45);
  await until(page, '__wd.state().grounded === true');
  await tap(page, B.Grenade);
  await until(page, '__wd.state().liveGrenades === 1');
  expect(await wd(page, 'state')).toMatchObject({ grenades: 0 });
  await until(page, '__wd.state().liveGrenades === 0'); // fuse ran out
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'e2e/artifacts/arsenal-explosion.png' });
  const s = (await wd(page, 'state')) as {
    stats: { hits: number; deaths: number };
    health: number;
  };
  expect(s.stats.hits).toBeGreaterThan(0); // the dummy was hit by the blast
  expect(s.stats.deaths > 0 || s.health < 100).toBe(true); // …and so was the thrower
  // A second grenade is not available this life (unless the blast respawned us).
  expect(errors).toEqual([]);
});

test('knife-only mode: knife in hand, no guns, no grenade', async ({ page }) => {
  test.setTimeout(BOOT_MS + 120_000);
  const errors = await boot(page, 'knife');
  expect(await wd(page, 'state')).toMatchObject({
    slot: 'knife',
    mode: 'knife',
    grenades: 0,
    ammo: -1,
  });
  await tap(page, B.Slot1);
  await page.waitForTimeout(700);
  expect(await wd(page, 'state')).toMatchObject({ slot: 'knife' });
  await expect(page.locator('.slot', { hasText: 'Rifle' })).toBeHidden();
  await expect(page.locator('.slot', { hasText: 'Knife' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('switching to knife-only mode removes a live grenade from the old mode', async ({ page }) => {
  test.setTimeout(BOOT_MS + 120_000);
  const errors = await boot(page);
  await tap(page, B.Grenade);
  await until(page, '__wd.state().liveGrenades === 1');
  // Change the loadout through the real settings control (menu is hidden under autotest).
  await page.evaluate(() => {
    const sel = document.querySelector<HTMLSelectElement>('[data-key="matchMode"]')!;
    sel.value = 'knife';
    sel.dispatchEvent(new Event('input'));
  });
  await until(page, "__wd.state().mode === 'knife'");
  expect(await wd(page, 'state')).toMatchObject({ liveGrenades: 0 });
  await page.waitForTimeout(3500); // past the old fuse
  expect(await wd(page, 'state')).toMatchObject({ health: 100, lastExplosion: null });
  expect(errors).toEqual([]);
});

test('recorded CC0 sounds load, decode, and play through the sample paths', async ({ page }) => {
  test.setTimeout(BOOT_MS + 120_000);
  const errors = await boot(page);
  const failed: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  // A trusted click (user activation), exactly like pressing Play, starts the AudioContext.
  await wd(page, 'unlockAudioOnClick');
  await page.mouse.click(640, 360);
  await until(page, "__wd.audioState() === 'running'");
  await until(page, '__wd.audioClips() >= 60', 60_000);
  // Wait on game state, never fixed sleeps (the sim can stall under software WebGL).
  await tap(page, B.Fire);
  await until(page, '__wd.state().stats.shots === 1');
  await tap(page, B.Slot3);
  await until(page, "__wd.state().slot === 'knife'");
  await tap(page, B.Fire);
  await until(
    page,
    // The knife strike adds its own cloth layer on top of the switch's.
    "__wd.recentSamples().filter((n) => n.startsWith('cloth_')).length >= 2",
  );
  const played = (await wd(page, 'recentSamples')) as string[];
  // Recorded clips, not synthesized fallbacks: rifle shot, switch foley (cloth + knife draw).
  expect(played).toContain('rifle_shot');
  expect(played.some((n) => n.startsWith('knife_draw_'))).toBe(true);
  expect(played.filter((n) => n.startsWith('cloth_')).length).toBeGreaterThanOrEqual(2);
  expect(failed).toEqual([]);
  expect(errors).toEqual([]);
});
