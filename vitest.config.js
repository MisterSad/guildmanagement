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
        replacement: path.resolve(__dirname, 'discord-verification-worker/node_modules/discord.js/src/index.js')
      },
      {
        find: /^https:\/\/esm\.sh\/zod(?:@[\d.]+)?$/,
        replacement: 'zod'
      }
    ]
  }
});

