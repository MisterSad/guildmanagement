import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    environmentOptions: {
      jsdom: { url: 'http://localhost:3000/' }
    },
    setupFiles: ['tests/setup.js'],
    include: ['tests/**/*.test.js']
  },
  resolve: {
    alias: [
      {
        find: /^https:\/\/esm\.sh\/zod(?:@[\d.]+)?$/,
        replacement: 'zod'
      }
    ]
  }
});

