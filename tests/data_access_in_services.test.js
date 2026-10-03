// Medium-term plan, M4b (audit ARC-01, FE-06): views, controllers and
// renderers do not build queries. Every table read or write, RPC, Edge
// Function call and storage call is a function of the module's service, which
// receives the guarded client from its caller (src/core/api/db-client.ts).
// There were 189 such call sites in views and controllers before M4b.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../src');
const QUERY = /\.from\(\s*['"`]|\.rpc\(\s*['"`]|functions\.invoke\(|storage\.from\(/;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : (e.name.endsWith('.ts') ? [p] : []);
  });
}

const presentation = files(SRC).filter((f) =>
  f.includes(`${path.sep}views${path.sep}`) || f.endsWith('.render.ts') || f.endsWith('.controller.ts'));

describe('data access lives in services', () => {
  it('finds the presentation files it guards', () => {
    expect(presentation.length).toBeGreaterThanOrEqual(20);
  });

  it('no view, controller or renderer builds a query', () => {
    const offenders = [];
    for (const f of presentation) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (QUERY.test(line)) offenders.push(`${path.relative(SRC, f)}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
