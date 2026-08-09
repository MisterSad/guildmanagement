import { defineConfig } from '@playwright/test';

// Playwright e2e for the FGF Guild Management Tool.
// The app is a static client-side SPA talking to Supabase. For e2e we serve
// the static files locally (no build step) and use Playwright route
// interception to stub the Supabase REST API, so tests run without touching
// the real backend.
//
// Run with:  npx playwright test
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npx serve . -l 4173 --no-clipboard',
    port: 4173,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
