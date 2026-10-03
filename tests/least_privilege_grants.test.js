/**
 * tests/least_privilege_grants.test.js
 *
 * Grants, not just policies (AGENTS.md rule 2). Migration 20260930185459 takes
 * away Supabase's default grants: everything from `anon`, TRUNCATE/TRIGGER/
 * REFERENCES from `authenticated`, and the direct write path beside tables that
 * are only ever written through a SECURITY DEFINER RPC.
 *
 * The browser-usage guard below is what keeps the migration honest: if the
 * client starts writing one of the RPC-only tables directly, it would fail with
 * 42501 in production -- the test fails first.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20260930185459_least_privilege_table_grants.sql'), 'utf-8');

function srcFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return srcFiles(p);
    return e.name.endsWith('.ts') && !e.name.includes('.test.') ? [p] : [];
  });
}
const clientSrc = srcFiles(path.join(root, 'src')).map((f) => fs.readFileSync(f, 'utf-8')).join('\n');

function browserOps(table) {
  const ops = new Set();
  const re = new RegExp(`from\\(['"]${table}['"]\\)\\s*\\.(select|insert|update|upsert|delete)\\(`, 'g');
  let m;
  while ((m = re.exec(clientSrc)) !== null) ops.add(m[1]);
  return ops;
}

describe('least-privilege table grants', () => {
  it('anon gets nothing, now or for future tables', () => {
    expect(sql).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;');
    expect(sql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon;');
  });

  it('refuses to run if a policy ever names anon or PUBLIC', () => {
    expect(sql).toMatch(/RAISE EXCEPTION 'least_privilege_grants: a policy grants anon or PUBLIC/);
  });

  it('authenticated never holds TRUNCATE, TRIGGER or REFERENCES', () => {
    expect(sql).toContain('REVOKE TRUNCATE, TRIGGER, REFERENCES ON ALL TABLES IN SCHEMA public FROM authenticated;');
  });

  const noAccess = ['account_backup_codes', 'account_passkeys', 'discord_account_links', 'discord_link_codes',
    'guild_creation_requests', 'login_throttle', 'tickets', 'webauthn_challenges'];
  it.each(noAccess)('%s: no browser access at all, and the browser never asks', (t) => {
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON public\\.${t}\\s+FROM authenticated;`));
    expect([...browserOps(t)]).toEqual([]);
  });

  const rpcOnly = ['event_chest_tiers', 'event_daily_scores', 'player_metrics_history', 'war_opponents', 'war_sessions', 'weekly_scores',
    'ocr_cache', 'player_absences', 'system_audit_logs'];
  it.each(rpcOnly)('%s: read-only for the browser, which never writes it directly', (t) => {
    expect(sql).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON public\\.${t}\\s+FROM authenticated;`));
    const writes = [...browserOps(t)].filter((op) => op !== 'select');
    expect(writes, `${t} is written directly by the client`).toEqual([]);
  });

  it('migration_wiki_comments is never updated in place by the browser', () => {
    expect(sql).toContain('REVOKE UPDATE ON public.migration_wiki_comments FROM authenticated;');
    expect(browserOps('migration_wiki_comments').has('update')).toBe(false);
    expect(browserOps('migration_wiki_comments').has('upsert')).toBe(false);
  });
});

describe('least-privilege function defaults (20260930190017)', () => {
  const fsql = fs.readFileSync(path.join(root, 'supabase/migrations/20260930190017_least_privilege_function_defaults.sql'), 'utf-8');
  it('new functions are born without PUBLIC or anon EXECUTE', () => {
    // PUBLIC's EXECUTE is a GLOBAL default: it cannot be revoked IN SCHEMA.
    expect(fsql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;');
    expect(fsql).toContain('ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon;');
  });
  it('leaves the deliberately anonymous crash reporter alone (ADR-011)', () => {
    const code = fsql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toContain('gm_report_client_error');
  });
});
