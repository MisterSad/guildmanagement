// Medium-term plan, M3 (audit BE-A-20, ARC-09, QA-09): the four largest Edge
// Functions were split so that index.ts only authenticates and routes, and
// each action or reminder block is its own module. What they DO is pinned by
// the characterization snapshots next to them (scenarios.test.ts), recorded
// from the single-file handlers before the split and run by `deno test`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const fnDir = path.resolve(__dirname, '../supabase/functions');
const SPLIT = {
  'event-reminders': ['shared.ts', 'standard.ts', 'gvg.ts', 'svs.ts', 'calamity.ts'],
  'member-portal': [
    'schemas.ts',
    'context.ts',
    'actions/sessions.ts',
    'actions/profile.ts',
    'actions/transfer.ts',
    'actions/history.ts',
    'actions/absences.ts',
  ],
  'admin-accounts': [
    'schemas.ts',
    'context.ts',
    'provision.ts',
    'actions/accounts.ts',
    'actions/discord.ts',
    'actions/join-code.ts',
    'actions/registrations.ts',
    'actions/guild-requests.ts',
    'actions/recovery-codes.ts',
  ],
  'auth-discord': [
    'config.ts',
    'http.ts',
    'tickets.ts',
    'oauth.ts',
    'actions/redeem.ts',
    'actions/redeem-code.ts',
    'actions/backup-login.ts',
    'actions/claim.ts',
    'actions/onboard.ts',
  ],
};

describe('the large handlers stay split', () => {
  for (const [fn, modules] of Object.entries(SPLIT)) {
    it(`${fn}: index.ts routes, its modules hold the work`, () => {
      const index = fs.readFileSync(path.join(fnDir, fn, 'index.ts'), 'utf8');
      // They were 920 to 1,261 lines each.
      expect(index.split('\n').length).toBeLessThan(200);
      for (const m of modules) expect(fs.existsSync(path.join(fnDir, fn, m)), m).toBe(true);
    });

    it(`${fn}: its behaviour is pinned by characterization snapshots`, () => {
      expect(fs.existsSync(path.join(fnDir, fn, 'scenarios.test.ts'))).toBe(true);
      const snap = fs.readFileSync(path.join(fnDir, fn, '__snapshots__', 'scenarios.test.ts.snap'), 'utf8');
      expect((snap.match(/^snapshot\[/gm) || []).length).toBeGreaterThanOrEqual(12);
    });
  }
});
