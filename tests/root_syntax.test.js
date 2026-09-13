/**
 * Root Script Syntax Verification Suite
 *
 * This test suite guards against unparseable JavaScript files in the repository root.
 * Classic browser scripts loaded directly by index.html (like app.js, gm-utils.js,
 * i18n.js, etc.) are executed by browsers outside the TypeScript compiler pipeline.
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
    const rootJsFiles = fs.readdirSync(rootDir)
        .filter(f => f.endsWith('.js') && fs.statSync(path.join(rootDir, f)).isFile())
        .sort();

    it('finds at least 10 root JavaScript scripts', () => {
        expect(rootJsFiles.length).toBeGreaterThanOrEqual(10);
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
