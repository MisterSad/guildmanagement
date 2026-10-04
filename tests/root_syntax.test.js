/**
 * Root Script Syntax Verification Suite
 *
 * This test suite guards against unparseable JavaScript files in the repository root.
 * After the Strangler final cutover there are no root runtime scripts left: the
 * app entrypoint is the `/src/main.ts` TS module and the service worker now
 * lives at `src/sw/service-worker.ts` (compiled to `dist/sw.js` by the build).
 * The only remaining root .js files are the build/test configs
 * (`playwright.config.js`, `vitest.config.js`).
 *
 * This test runs `node --check <file>` on every root .js file to ensure zero syntax errors
 * can ever slip through CI or production releases silently again.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

describe('Root Scripts Syntax Validation (node --check)', () => {
  const rootDir = path.resolve(__dirname, '..');
  const rootJsFiles = fs
    .readdirSync(rootDir)
    .filter((f) => f.endsWith('.js') && fs.statSync(path.join(rootDir, f)).isFile())
    .sort();

  it('finds at least 2 root JavaScript config scripts', () => {
    expect(rootJsFiles.length).toBeGreaterThanOrEqual(2);
  });

  rootJsFiles.forEach((file) => {
    it(`parses cleanly with node --check: ${file}`, () => {
      const filePath = path.join(rootDir, file);
      let checkError = null;
      try {
        execSync(`node --check "${filePath}"`, { stdio: 'pipe' });
      } catch (err) {
        checkError = err;
      }
      expect(checkError, `SyntaxError detected in root script: ${file}`).toBeNull();
    });
  });
});
