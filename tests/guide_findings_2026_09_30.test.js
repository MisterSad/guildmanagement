/**
 * tests/guide_findings_2026_09_30.test.js
 *
 * Defects found while writing the user guides (items 5 to 9 of that review;
 * item 4, the silent history loss on ban, is covered in banned_controller).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sqlFunctionBody } from './helpers/sql-function.js';
import fs from 'fs';
import path from 'path';

vi.mock('../src/core/config/guild-config', () => ({ getGuildConfig: vi.fn() }));
import { getGuildConfig } from '../src/core/config/guild-config';
import { resolveCoeff, paintEventCoeffLabels } from '../src/core/config/event-coeff-labels';
import { canManageWikiPage } from '../src/modules/migration/views/MigrationHubView';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf-8');

describe('5. a Glory typed outside the Glory page reaches the Glory Tracker', () => {
  it('Player Portal: a CHANGED Glory is filed for the week through updatePlayerGlory', () => {
    const src = edgeSource('member-portal');
    const handler = edgeFunctionBody('member-portal', 'updateMetrics');
    expect(handler).toMatch(/if \(payload\?\.glory_score !== undefined && gloryScore !== \(Number\(member\.glory_score\) \|\| 0\)\)/);
    expect(handler).toContain('await updatePlayerGlory(admin, uid, identity.guild, gloryScore)');
    // and it now reads the RPC's own verdict, not only the transport error
    expect(handler).toContain('metricsRow.ok === false');
  });
  it('Members → Edit: a changed Glory also writes this week through gm_upsert_player_glory', () => {
    // M4a: the edit is gm_update_member, which files a changed Glory for the
    // week in the same transaction (run by supabase/tests/10_transactional_writes.sql).
    const fn = sqlFunctionBody('gm_update_member');
    expect(fn).toContain("IF p_update ? 'glory_score' AND v_new.glory_score IS DISTINCT FROM COALESCE(v_old.glory_score, 0) THEN");
    expect(fn).toContain('public.gm_upsert_player_glory(v_guild, v_new.pseudo,');
  });
});

describe('7. event pages show the guild\'s own weights', () => {
  beforeEach(() => { getGuildConfig.mockReset(); });

  it('falls back to the default for a missing or out-of-range value', () => {
    expect(resolveCoeff('SvS', '8')).toBe(8);
    expect(resolveCoeff('SvS', '')).toBe(5);
    expect(resolveCoeff('DTR', null)).toBe(2);
    expect(resolveCoeff('GvG', '99')).toBe(5);
    expect(resolveCoeff('GvG', 'abc')).toBe(5);
    expect(resolveCoeff('GvG', '0')).toBe(0);
  });

  it('paints every marked label from guild_config', async () => {
    document.body.innerHTML = '<span data-gm-event-coeff="SvS">· coeff. 5×</span><span data-gm-event-coeff="DTR">· coeff. 2×</span>';
    getGuildConfig.mockImplementation(async (k) => (k === 'coeff_svs' ? '7' : ''));
    await paintEventCoeffLabels();
    const [svs, dtr] = document.querySelectorAll('[data-gm-event-coeff]');
    expect(svs.textContent).toBe('· coeff. 7×');
    expect(dtr.textContent).toBe('· coeff. 2×');
  });

  it('no hard-coded label is left unmarked in index.html', () => {
    const html = read('index.html');
    const labels = html.match(/<span[^>]*>· coeff\. \d+×<\/span>/g) || [];
    expect(labels.length).toBeGreaterThan(0);
    labels.forEach((l) => expect(l).toContain('data-gm-event-coeff='));
  });
});

describe('8. Stats speaks English', () => {
  it('no French squad words in the Shadowfront deep-dive', () => {
    const src = read('src/modules/stats/views/StatsView.ts');
    expect(src).not.toMatch(/titulaire|réserve/);
  });
});

describe('9. Migration Hub page deletion', () => {
  it('only the author guild or a super admin sees Edit and Delete (mirrors the wiki policies)', () => {
    expect(canManageWikiPage({ owner_guild: 'ALPHA' }, 'ALPHA', 'guild_admin')).toBe(true);
    expect(canManageWikiPage({ owner_guild: 'BETA' }, 'ALPHA', 'guild_admin')).toBe(false);
    expect(canManageWikiPage({ owner_guild: null }, 'ALPHA', 'server_admin')).toBe(false);
    expect(canManageWikiPage({ owner_guild: 'BETA' }, null, 'super_admin')).toBe(true);
  });
  it('a refused delete is reported, not announced as done', () => {
    const src = read('src/modules/migration/views/MigrationHubView.ts');
    expect(src).toContain(".delete().eq('id', page.id).select('id')");
    expect(src).toContain('if (error || !data || data.length === 0)');
  });
  it('the page title is escaped in the HTML confirm dialog', () => {
    const src = read('src/modules/migration/views/MigrationHubView.ts');
    expect(src).toContain('${escapeHTML(page.title)}');
    expect(src).not.toContain('delete "${page.title}"');
  });
});

describe('6. in-app help no longer describes removed features', () => {
  it('drops the stale wording', () => {
    const src = read('src/modules/help/HelpView.ts');
    for (const stale of ['Start SvS', 'import from Discord', 'One session per calendar day', 'date range', 'pick a sanction type', 'Top 5 share', 'self-register on the Player Portal']) {
      expect(src, stale).not.toContain(stale);
    }
  });
});
