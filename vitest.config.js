import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost:3000/' }
    },
    setupFiles: ['tests/setup.js'],
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    /*
     * A FLOOR, not a target. The project had no threshold at all, so nothing
     * stopped coverage drifting down one untested module at a time -- which is
     * how `banned.controller.ts`, a moderation action that deletes roster rows,
     * reached 0.8%.
     *
     * The numbers sit ~2 points under what the suite actually achieves today
     * (58.0 / 46.9 / 64.0 / 61.1). That headroom is deliberate: a ratchet set at
     * the current value fails on noise, and a ratchet set aspirationally fails
     * immediately and gets deleted. Raise these when the real figure rises.
     */
    coverage: {
      provider: 'v8',
      enabled: true,
      reporter: ['text-summary'],
      thresholds: {
        statements: 56,
        branches: 45,
        functions: 62,
        lines: 59
      }
    }
  },
  resolve: {
    alias: [
      {
        find: 'discord.js',
        replacement: path.resolve(__dirname, 'tests/mocks/discord.js')
      },
      {
        find: /^https:\/\/esm\.sh\/zod(?:@[\d.]+)?$/,
        replacement: 'zod'
      }
    ]
  }
});

