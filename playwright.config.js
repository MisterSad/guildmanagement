import { defineConfig } from '@playwright/test';

// Playwright e2e for the FGF Guild Management Tool.
// The app is a static client-side SPA talking to Supabase. The suite runs
// against the PRODUCTION BUNDLE in dist/ (the root index.html references the
// raw /src/main.ts TS module, which a browser cannot execute), so the webServer
// builds first and then serves dist/. Playwright route interception stubs the
// Supabase REST/functions APIs, so tests run without touching the real backend.
//
// Run with:  npx playwright test   (builds dist/ automatically)
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
    // Build the production bundle, then serve dist/ at the root so `/sw.js`,
    // `/terms.html` and `/assets/*` all resolve exactly as in production.
    command: 'npm run build && npx serve dist -l 4173 --no-clipboard',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
