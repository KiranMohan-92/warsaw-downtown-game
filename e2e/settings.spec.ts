import { expect, test } from '@playwright/test';

/** Menu behaviour through the real UI (no autotest hooks). Regressions from the Codex M1 review. */
test('settings: overlay toggle, Low → Auto restarts at High, Play takes pointer lock', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.removeItem('wd.settings.v1'));
  await page.goto('/');
  // The menu opens on the Match tab; these settings live under Graphics & weather.
  await page.getByRole('button', { name: 'Graphics & weather' }).click();
  const perf = page.getByTestId('perf');
  const fps = page.getByTestId('setting-showFps');
  const quality = page.getByTestId('setting-quality');

  await fps.check();
  await expect(perf).toBeVisible();
  await quality.selectOption('low');
  await expect(perf).toContainText('quality low', { timeout: 20_000 });
  // Auto must not inherit the manual tier (it only ever steps down). Auto resumes where it last
  // settled on this machine (wd.perf.v1): on a software renderer the first Auto load already
  // settled low, so forget that to test the tier Auto starts from on a fresh machine.
  await page.evaluate(() => localStorage.removeItem('wd.perf.v1'));
  await quality.selectOption('auto');
  await expect(perf).toContainText('quality high', { timeout: 20_000 });
  // Unchecking the setting hides the overlay again.
  await fps.uncheck();
  await expect(perf).toBeHidden();

  // Pointer lock is requested inside the click gesture.
  await page.getByTestId('play').click();
  await expect
    .poll(() => page.evaluate(() => document.pointerLockElement?.id ?? null), { timeout: 10_000 })
    .toBe('game');
});
