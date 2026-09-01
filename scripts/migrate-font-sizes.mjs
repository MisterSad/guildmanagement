#!/usr/bin/env node
/**
 * One-off migration: replaces literal font-size values with the nearest
 * step of the --fs-* type scale defined in tokens.css (2026-09 consolidation
 * of ~100 distinct near-duplicate values into 12 named steps). Deleted after
 * the migration lands -- not a permanent tool.
 *
 * Deliberately does NOT touch clamp()-based font-size declarations (a
 * handful of hand-tuned responsive sidebar rules) -- only bare
 * `font-size: <number><unit>` values are in scope.
 *
 * Usage: node scripts/migrate-font-sizes.mjs <file> [<file> ...]
 */
import fs from 'fs';

// value (normalized: leading zero, no trailing zero) -> scale variable
const MAP = {
  '0.52rem': '--fs-2xs', '0.58rem': '--fs-2xs', '0.6rem': '--fs-2xs', '0.62rem': '--fs-2xs',
  '0.64rem': '--fs-2xs', '0.65rem': '--fs-2xs', '0.66rem': '--fs-2xs',

  '0.68rem': '--fs-xs', '0.7rem': '--fs-xs', '0.72rem': '--fs-xs', '0.74rem': '--fs-xs',

  '0.75rem': '--fs-sm', '0.76rem': '--fs-sm', '0.78rem': '--fs-sm', '0.8rem': '--fs-sm',
  '0.82rem': '--fs-sm', '0.83rem': '--fs-sm',

  '0.84rem': '--fs-base', '0.85rem': '--fs-base', '0.86rem': '--fs-base', '0.875rem': '--fs-base', '0.88rem': '--fs-base',

  '0.9rem': '--fs-md', '0.92rem': '--fs-md', '0.9375rem': '--fs-md', '0.94rem': '--fs-md', '0.95rem': '--fs-md', '0.98rem': '--fs-md',

  '1rem': '--fs-lg', '1.02rem': '--fs-lg', '1.05rem': '--fs-lg', '1.08rem': '--fs-lg',

  '1.1rem': '--fs-xl', '1.125rem': '--fs-xl', '1.15rem': '--fs-xl', '1.2rem': '--fs-xl', '1.25rem': '--fs-xl',

  '1.28rem': '--fs-2xl', '1.3rem': '--fs-2xl', '1.35rem': '--fs-2xl', '1.4rem': '--fs-2xl',

  '1.5rem': '--fs-3xl', '1.55rem': '--fs-3xl', '1.6rem': '--fs-3xl', '1.65rem': '--fs-3xl', '1.75rem': '--fs-3xl', '1.8rem': '--fs-3xl',

  '1.9rem': '--fs-4xl', '2rem': '--fs-4xl', '2.1rem': '--fs-4xl', '2.2rem': '--fs-4xl', '2.4rem': '--fs-4xl',

  '2.5rem': '--fs-5xl', '2.8rem': '--fs-5xl', '3rem': '--fs-5xl', '3.5rem': '--fs-5xl',

  '4.5rem': '--fs-6xl', '5rem': '--fs-6xl',

  // px values, mapped by their rem-equivalent (÷16) to the nearest step
  '12px': '--fs-sm',   // 0.75rem
  '13px': '--fs-sm',   // 0.8125rem
  '14px': '--fs-base', // 0.875rem exact
  '16px': '--fs-lg',   // 1rem
  '32px': '--fs-4xl',  // 2rem
};

function normalize(raw) {
  const m = raw.match(/^(\d*\.?\d+)(rem|px|em)$/);
  if (!m) return raw;
  let num = m[1];
  if (num.startsWith('.')) num = '0' + num;
  num = String(parseFloat(num));
  return num + m[2];
}

function migrate(file) {
  const src = fs.readFileSync(file, 'utf8');
  let count = 0;
  const unmapped = new Set();
  const out = src.replace(
    /font-size:\s*([.\d]+(?:rem|px|em))(\s*!important)?/g,
    (whole, rawVal, important) => {
      const norm = normalize(rawVal);
      const varName = MAP[norm];
      if (!varName) { unmapped.add(rawVal); return whole; }
      count++;
      return 'font-size: var(' + varName + ')' + (important || '');
    }
  );
  fs.writeFileSync(file, out);
  return { count, unmapped };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/migrate-font-sizes.mjs <file> [<file> ...]');
  process.exit(1);
}
let totalCount = 0;
let anyUnmapped = false;
for (const f of files) {
  const { count, unmapped } = migrate(f);
  totalCount += count;
  if (unmapped.size) anyUnmapped = true;
  console.log(f + ': migrated ' + count + (unmapped.size ? ', UNMAPPED: ' + [...unmapped].join(', ') : ''));
}
console.log('Total migrated: ' + totalCount);
if (anyUnmapped) {
  console.error('Some values had no scale mapping -- add them to MAP before re-running.');
  process.exit(1);
}
