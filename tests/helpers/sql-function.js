// The latest definition of a public SQL function, as the migration chain
// leaves it: the body from the last migration that creates or replaces it.
// For tests that pin a property of a database function a browser flow moved
// into (medium-term plan, M4a); its behaviour is run by supabase/tests/*.sql.

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = path.resolve(__dirname, '../../supabase/migrations');

export function sqlFunctionBody(name) {
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, files[i]), 'utf8');
    const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start === -1) continue;
    const end = sql.indexOf('$function$;', start);
    return sql.slice(start, end === -1 ? undefined : end);
  }
  throw new Error(`no migration defines public.${name}`);
}
