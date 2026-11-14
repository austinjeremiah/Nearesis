import { defineConfig } from '@playwright/test';

/**
 * Smoke tests run against the REAL stack: the kernel API (default
 * http://127.0.0.1:4110, override NEARESIS_API_URL) and this Next app, started here
 * on port 3400 with the dev sign-in enabled. There are no mocks: the tests sign in
 * through POST /v1/dev/login and read real workspaces.
 */
const PORT = Number(process.env.E2E_PORT ?? 3400);
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: !!process.env.E2E_REUSE,
    timeout: 120_000,
    env: {
      NEARESIS_DEV_LOGIN: '1',
      NEARESIS_API_URL: process.env.NEARESIS_API_URL ?? 'http://127.0.0.1:4110',
    },
  },
});
