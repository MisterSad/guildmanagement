import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('Ticket 2.2: tsconfig.json Strict TypeScript Typing', () => {
  const tsconfigPath = path.resolve(__dirname, '../tsconfig.json');
  const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8'));

  it('enforces strict compiler options in tsconfig.json', () => {
    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.noImplicitAny).toBe(true);
    expect(tsconfig.compilerOptions.strictNullChecks).toBe(true);
  });

  it('preserves exclusion of legacy JavaScript scripts from strict type checks', () => {
    expect(tsconfig.compilerOptions.allowJs).toBe(true);
    expect(tsconfig.compilerOptions.checkJs).toBe(false);
  });

  it('includes src and build configs in the compilation scope', () => {
    expect(tsconfig.include).toContain('src/**/*');
    expect(tsconfig.include).toContain('vite.config.ts');
    expect(tsconfig.include).toContain('vitest.config.js');
  });
});
