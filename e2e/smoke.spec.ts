import { expect, test } from '@playwright/test';

// Booting under software WebGL (SwiftShader) compiles ~220 shader programs: ~45 s on the dev
// laptop (2026-10-13), more on a slower runner. Every "ready" wait gets this budget, and each
// test deadline adds it on top of the time the test needs after boot.
const BOOT_MS = 120_000;

test('client boots, renders, and connects to the server', async ({ page, request }) => {
  test.setTimeout(BOOT_MS + 60_000);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  const health = await request.get('http://localhost:2567/health');
  expect(health.ok()).toBe(true);

  await page.addInitScript(() => {
    localStorage.setItem('wd.settings.v1', JSON.stringify({ quality: 'low' }));
  });
  await page.goto('/');
  await expect(page.getByTestId('net-status')).toContainText('server: connected', {
    timeout: BOOT_MS,
  });
  await page.screenshot({ path: 'e2e/artifacts/m0-smoke.png' });
  expect(errors).toEqual([]);
});
