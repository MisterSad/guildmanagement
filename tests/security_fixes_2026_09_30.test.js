/**
 * tests/security_fixes_2026_09_30.test.js
 *
 * Three defects found while writing the user guides, each proven on production
 * inside a rolled-back transaction before it was fixed:
 *   1. A guild admin could pull any player of another guild on the server and
 *      approve the request themselves.
 *   2. The Migration Hub AI summary read any page by id with the service role,
 *      checking only the scope the REQUEST claimed.
 *   3. A Members OCR scan could delete the R5 leader, history and all.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { transferActionFor } from '../src/modules/app/members/members.store';
import { canReadIntel } from '../supabase/functions/_shared/intel-access.ts';
import { categorizeOcrDiff } from '../src/modules/ocr/ocr.service';

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf-8');

describe('1. transfers: whoever asks never decides', () => {
  const pull = { id: 't', uid: '1', pseudo: 'P', source_guild: 'LOSER', target_guild: 'PULLER', requested_by: 'admin' };
  const playerReq = { id: 't', uid: '1', pseudo: 'P', source_guild: 'OLD', target_guild: 'NEW', requested_by: 'player' };

  it('an admin pull is decided by the guild the player is leaving', () => {
    expect(transferActionFor(pull, 'LOSER')).toBe('decide');
    expect(transferActionFor(pull, 'PULLER')).toBe('withdraw');
    expect(transferActionFor(pull, 'OTHER')).toBe('wait');
  });

  it("a player's own request is decided by the receiving guild", () => {
    expect(transferActionFor(playerReq, 'NEW')).toBe('decide');
    expect(transferActionFor(playerReq, 'OLD')).toBe('wait');
  });

  it('a row predating the column is a player request', () => {
    const legacy = { ...playerReq, requested_by: undefined };
    expect(transferActionFor(legacy, 'NEW')).toBe('decide');
  });

  const sql = read('supabase/migrations/20260930182818_transfer_requester_cannot_approve.sql');
  it('records who asked, and resolves the approver from it', () => {
    expect(sql).toContain("VALUES (p_uid, v_pseudo, v_source_guild, v_target, 'pending', 'admin')");
    expect(sql).toMatch(/v_approver_guild := CASE WHEN v_transfer\.requested_by = 'admin'\s+THEN v_transfer\.source_guild ELSE v_transfer\.target_guild END;/);
    expect(sql).toContain("IF NOT v_is_approver AND NOT (p_action = 'reject' AND v_is_requester) THEN");
  });
  it('closes the direct-UPDATE path around the RPC', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS gm_authenticated_update ON public.guild_transfers;');
    expect(sql).toContain('REVOKE ALL ON public.guild_transfers FROM anon;');
    expect(sql).toMatch(/REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public\.guild_transfers FROM authenticated;/);
  });
  it("no longer falls back to 'ALPHA'", () => {
    const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    expect(code).not.toMatch(/'ALPHA'/);
  });
  it('the client never writes guild_transfers directly', () => {
    const src = read('src/modules/app/members/members.controller.ts');
    expect(src).not.toMatch(/from\('guild_transfers'\)\.(update|insert|delete)/);
    expect(src).toContain("select('id, uid, pseudo, source_guild, target_guild, requested_by')");
  });
});

describe('2. Migration Hub AI summary: checked on the data actually read', () => {
  const guildAdmin = { role: 'guild_admin', guild: 'ALPHA', serverNumber: '1058' };
  const serverAdmin = { role: 'server_admin', guild: null, serverNumber: '1058' };

  it('guild intel: own guild only for a guild admin, own server for a server admin', () => {
    expect(canReadIntel(guildAdmin, { scope: 'guild', guildId: 'ALPHA', serverNumber: '1058', guildServerNumber: '1058' })).toBe(true);
    expect(canReadIntel(guildAdmin, { scope: 'guild', guildId: 'OMEGA', serverNumber: '1058', guildServerNumber: '1058' })).toBe(false);
    expect(canReadIntel(serverAdmin, { scope: 'guild', guildId: 'OMEGA', serverNumber: '1058', guildServerNumber: '1058' })).toBe(true);
    expect(canReadIntel(serverAdmin, { scope: 'guild', guildId: 'FAR', serverNumber: '2000', guildServerNumber: '2000' })).toBe(false);
  });

  it('server intel: own server only, for guild admins too', () => {
    expect(canReadIntel(guildAdmin, { scope: 'server', guildId: null, serverNumber: '1058' })).toBe(true);
    expect(canReadIntel(guildAdmin, { scope: 'server', guildId: null, serverNumber: '2000' })).toBe(false);
  });

  it('refuses members, unknown scopes and missing data', () => {
    expect(canReadIntel({ role: 'member', guild: 'ALPHA', serverNumber: '1058' }, { scope: 'server', guildId: null, serverNumber: '1058' })).toBe(false);
    expect(canReadIntel(guildAdmin, { scope: 'weird', guildId: 'ALPHA', serverNumber: '1058' })).toBe(false);
    expect(canReadIntel(guildAdmin, { scope: 'guild', guildId: null, serverNumber: '1058' })).toBe(false);
    expect(canReadIntel({ role: 'guild_admin', guild: 'ALPHA', serverNumber: null }, { scope: 'server', guildId: null, serverNumber: '1058' })).toBe(false);
  });

  const fn = read('supabase/functions/migration-summary/index.ts');
  it("checks a page against the page's own scope, not the request's", () => {
    expect(fn).toMatch(/scope: page\.scope, guildId: page\.guild_id \?\? null, serverNumber: page\.server_number \?\? null/);
  });
  it('rate-limits per account, and never echoes the provider error', () => {
    expect(fn).toContain('`migration-summary:${caller.accountId}`');
    expect(fn).not.toContain('message: lastError');
  });
  it('names the right game', () => {
    expect(fn).not.toContain('Whiteout Survival');
  });
  it('is disclosed in privacy.html', () => {
    const privacy = read('privacy.html');
    expect(privacy).toContain('AI summary in the Migration Hub');
    expect(privacy).toContain('Bug reports submitted from the Service');
  });
});

describe('3. the R5 leader is never removed by accident', () => {
  const roster = [
    { pseudo: 'Leader', uid: '100001', role: 'R5', overall_power: 9 },
    { pseudo: 'Officer', uid: '100002', role: 'R4', overall_power: 8 },
    { pseudo: 'Gone', uid: '100003', role: 'R1', overall_power: 1 },
  ];
  it('a Members OCR scan that misses the R5 does not list them for removal', () => {
    const diff = categorizeOcrDiff([{ pseudo: 'Officer', overall_power: 8 }], roster, null, 'overall_power', false, 'members');
    const removed = diff.removed.map((r) => r.pseudo);
    expect(removed).toContain('Gone');
    expect(removed).not.toContain('Leader');
  });

  it('the commit, the single delete and the ban all refuse an R5 before any request', () => {
    expect(read('src/modules/app/ocr/ocr.controller.ts')).toContain("if (p && !r5Pseudos.has(p.toLowerCase())) checkedRemovalPseudos.push(p);");
    expect(read('src/modules/app/members/members.controller.ts')).toMatch(/if \(target && target\.role === 'R5'\) \{ showToast\(R5_DELETE_MESSAGE/);
    expect(read('src/modules/app/members/banned.controller.ts')).toContain("m.uid === uidVal && m.role === 'R5'");
  });

  it('the database refuses it from a user session, and leaves system paths alone', () => {
    const sql = read('supabase/migrations/20260930182821_protect_r5_from_deletion.sql');
    expect(sql).toMatch(/IF OLD\.role = 'R5'\s+AND auth\.uid\(\) IS NOT NULL\s+AND NOT public\.is_super_admin\(\) THEN/);
    expect(sql).toContain('BEFORE DELETE ON public.guild_members');
    expect(sql).toContain('REVOKE EXECUTE ON FUNCTION public.gm_protect_r5_deletion() FROM PUBLIC, anon, authenticated;');
  });
});
