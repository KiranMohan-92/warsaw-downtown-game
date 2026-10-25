import { expect, test } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

test.use({ viewport: { width: 1920, height: 1080 } });

for (const weather of ['golden', 'sunny', 'overcast', 'rain', 'dusk'] as const) {
  test(`weather preset renders cleanly: ${weather}`, async ({ page }) => {
    test.setTimeout(BOOT_MS + 90_000);
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((w) => {
      localStorage.setItem(
        'wd.settings.v1',
        JSON.stringify({ map: 'range', weather: w, quality: 'high' }),
      );
    }, weather);
    await page.goto('/?autotest');
    await page.waitForFunction('window.__wd?.ready === true', undefined, { timeout: BOOT_MS });
    // A view with the building, crates, ramps, and a dummy; look slightly toward the sun side.
    await page.evaluate(() => {
      const wd = (window as unknown as { __wd: { teleport: (...a: number[]) => void } }).__wd;
      wd.teleport(-3, 0.02, 38, -0.35, 0.02);
    });
    await page.waitForFunction('__wd.state().grounded === true', undefined, { timeout: 20_000 });
    await page.waitForTimeout(1200);
    const s = await page.evaluate(() =>
      (
        window as unknown as { __wd: { state: () => { weather: string; quality: string } } }
      ).__wd.state(),
    );
    expect(s.weather).toBe(weather);
    await page.screenshot({ path: `e2e/artifacts/weather-${weather}.png` });
    expect(errors).toEqual([]);
  });
}
