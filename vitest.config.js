import { defineConfig } from 'vitest/config';
import path from 'node:path';

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

