import { defineConfig, devices } from '@playwright/test';

const reuse = !process.env.CI;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1280, height: 720 },
        launchOptions: {
          args: [
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
    // Friends play in whatever browser they have: the compatibility spec runs in Firefox and
    // WebKit (Safari's engine) too. `pnpm e2e:compat` runs just these.
    {
      name: 'firefox',
      testMatch: /compat\.spec\.ts/,
      use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 720 } },
    },
    {
      name: 'webkit',
      testMatch: /compat\.spec\.ts/,
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 720 } },
    },
  ],
  // Two servers so Playwright waits for BOTH to be ready (the game server cold-starts slower).
  webServer: [
    {
      command: 'pnpm --filter @wd/server dev',
      url: 'http://localhost:2567/health',
      reuseExistingServer: reuse,
      timeout: 120_000,
    },
    {
      command: 'pnpm --filter @wd/client dev',
      url: 'http://localhost:5173',
      reuseExistingServer: reuse,
      timeout: 120_000,
    },
  ],
});
