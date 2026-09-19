/**
 * tests/ui_primitives.test.js
 *
 * Foundation suite for the shadcn/ui philosophy layer:
 * - cn() canonical combiner (clsx + tailwind-merge)
 * - cva() variant recipes (class-variance-authority)
 * - theme.css semantic token layer (1:1 over tokens.css M3 base)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { cn } from '../src/core/utils/cn';
import { cva } from '../src/core/utils/cva';
import { UiSize, UiAccent, UiState } from '../src/components/ui/types';

const rootDir = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');

describe('cn — canonical class combiner (clsx + tailwind-merge)', () => {
  it('joins plain strings and filters falsy values', () => {
    expect(cn('a', 'b')).toBe('a b');
    expect(cn('a', false, null, undefined, 0, '')).toBe('a');
  });

  it('resolves conditional objects and nested arrays', () => {
    expect(cn({ 'is-active': true, hidden: false }, ['x', ['y']])).toBe('is-active x y');
  });

  it('resolves utility conflicts last-wins (tailwind-merge)', () => {
    expect(cn('px-2 px-4')).toBe('px-4');
    expect(cn('bg-red-500', 'bg-blue-500')).toBe('bg-blue-500');
    expect(cn('text-sm', 'text-lg')).toBe('text-lg');
  });

  it('passes non-utility (gm-ui-*) classes through untouched', () => {
    expect(cn('gm-ui-switch', 'gm-ui-switch-md')).toBe('gm-ui-switch gm-ui-switch-md');
  });

  it('returns empty string when every input is falsy', () => {
    expect(cn()).toBe('');
    expect(cn(false, null, undefined)).toBe('');
  });
});

describe('cva — class-variance-authority recipes', () => {
  const recipe = cva('gm-ui-switch', {
    variants: {
      size: { sm: 'gm-ui-switch-sm', md: 'gm-ui-switch-md' },
      accent: { svs: 'gm-ui-accent-svs', gvg: 'gm-ui-accent-gvg' }
    },
    defaultVariants: { size: 'md' }
  });

  it('returns the base when no variant prop is provided', () => {
    expect(recipe({})).toBe('gm-ui-switch gm-ui-switch-md');
  });

  it('applies defaultVariants when a variant key is omitted', () => {
    expect(recipe({ accent: 'svs' })).toContain('gm-ui-switch-md');
    expect(recipe({ accent: 'svs' })).toContain('gm-ui-accent-svs');
  });

  it('lets an explicit variant override the default', () => {
    expect(recipe({ size: 'sm' })).toBe('gm-ui-switch gm-ui-switch-sm');
  });

  it('appends custom class/className props', () => {
    expect(recipe({ size: 'sm', className: 'is-tested' })).toContain('is-tested');
  });
});

describe('theme.css — semantic shadcn token layer over tokens.css', () => {
  const theme = read('theme.css');
  const tokens = read('tokens.css');

  const SHADCN_TOKENS = [
    '--background', '--foreground',
    '--card', '--card-foreground',
    '--popover', '--popover-foreground',
    '--primary', '--primary-foreground',
    '--secondary', '--secondary-foreground',
    '--muted', '--muted-foreground',
    '--accent', '--accent-foreground',
    '--destructive', '--destructive-foreground',
    '--border', '--input', '--ring',
    '--radius', '--radius-sm', '--radius-lg'
  ];

  it('declares every canonical shadcn token', () => {
    SHADCN_TOKENS.forEach((name) => {
      expect(theme, `missing shadcn token ${name}`).toMatch(new RegExp(`${name}\\s*:`));
    });
  });

  it('resolves every var() reference to a token actually defined in tokens.css', () => {
    const refs = [...theme.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
    const defined = new Set([...tokens.matchAll(/^(\s*)--([\w-]+):/gm)].map((m) => `--${m[2]}`));
    expect(refs.length).toBeGreaterThan(0);
    refs.forEach((ref) => {
      expect(defined, `theme.css references ${ref} which tokens.css does not define`).toContain(ref);
    });
  });

  it('stays dark-only: no light-theme selector (parity with tokens.css rule)', () => {
    expect(theme).not.toContain('[data-theme="light"]');
  });

  it('is loaded right after tokens.css in src/main.ts cascade order', () => {
    const mainTs = read('src/main.ts');
    const tokensIdx = mainTs.indexOf("import '../tokens.css';");
    const themeIdx = mainTs.indexOf("import '../theme.css';");
    expect(tokensIdx).toBeGreaterThan(-1);
    expect(themeIdx).toBeGreaterThan(tokensIdx);
  });
});