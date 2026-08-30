// Bundles vendor-src/noble-crypto-entry.js into a single, minified,
// dependency-free browser script (noble-crypto.bundle.js) committed at the
// repo root and loaded via a plain <script> tag, same as the other root
// files. Rerun this whenever @noble/curves or @noble/hashes are upgraded.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [path.join(root, 'vendor-src/noble-crypto-entry.js')],
  outfile: path.join(root, 'noble-crypto.bundle.js'),
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  banner: {
    js: '/* noble-crypto.bundle.js — generated from vendor-src/noble-crypto-entry.js. Do not edit by hand; run `npm run build:vendor-crypto`. Bundles @noble/curves + @noble/hashes (MIT). */',
  },
});

console.log('Built noble-crypto.bundle.js');
