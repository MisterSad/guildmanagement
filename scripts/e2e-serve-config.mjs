#!/usr/bin/env node
/**
 * scripts/e2e-serve-config.mjs
 *
 * Writes the `serve` configuration the e2e suite serves dist/ with, from the
 * headers vercel.json gives production -- so the suite runs under the real
 * Content-Security-Policy and a violation fails a test instead of shipping.
 * Generated, never hand-copied: a CSP edited in vercel.json is the CSP tested.
 *
 * Strict-Transport-Security is left out: it means nothing on http://localhost
 * and a browser that honoured it would refuse the test server.
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
// Outside test-results/, which Playwright empties when a run starts.
const out = path.join(root, 'node_modules', '.cache', 'e2e', 'serve.json');

const headers = (vercel.headers || []).map((rule) => ({
  source: rule.source === '/(.*)' ? '**' : rule.source,
  headers: rule.headers.filter((h) => h.key.toLowerCase() !== 'strict-transport-security'),
}));
if (!headers.some((r) => r.headers.some((h) => h.key === 'Content-Security-Policy'))) {
  throw new Error('vercel.json declares no Content-Security-Policy: refusing to run e2e without one');
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ headers }, null, 2));
console.log(`e2e serve config: ${path.relative(root, out)} (${headers.length} header rules)`);
