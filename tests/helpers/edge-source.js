// The source of one Edge Function, as one string: index.ts first, then every
// other module of its directory (actions/, shared.ts, ...), tests and
// snapshots excluded. Medium-term plan M3 split the large handlers into
// modules; a test that pins a property of "the function" reads it here
// rather than index.ts, so it keeps holding wherever the code now lives.

import fs from 'node:fs';
import path from 'node:path';

const FUNCTIONS = path.resolve(__dirname, '../../supabase/functions');

function modules(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return e.name.startsWith('__') ? [] : modules(p);
      return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
    })
    .sort();
}

export function edgeSource(name) {
  const dir = path.join(FUNCTIONS, name);
  const index = path.join(dir, 'index.ts');
  const rest = modules(dir).filter((p) => p !== index);
  return [index, ...rest].map((p) => fs.readFileSync(p, 'utf8')).join('\n');
}

/**
 * The source of one top-level function of an Edge Function, from its
 * declaration to its closing brace, in whichever module it now lives.
 * `edgeFunctionBody('admin-accounts', 'discordUnlink')` is the
 * `discord-unlink` action. Fails loudly when the function does not exist, so
 * a renamed action cannot turn a test into an assertion on ''.
 */
export function edgeFunctionBody(name, fnName) {
  const src = edgeSource(name);
  const decl = new RegExp(`^(?:export )?(?:async )?function ${fnName}\\(`, 'm');
  const m = decl.exec(src);
  if (!m) throw new Error(`${name}: no top-level function ${fnName}`);
  const end = src.indexOf('\n}\n', m.index);
  return src.slice(m.index, end === -1 ? undefined : end + 2);
}
