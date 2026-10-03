// Regression guard for Phase B of the UX audit roadmap: gm_stats_data
// promotion + projection extension, the new gm_get_player_event_history
// RPC, the Shadowfront/Arms Race/Glory granularity added to stats.js, and
// the admin Player History modal (app.js) wired from clickable leaderboard
// rows (stats.js) using the chart renderer shared with the player Portal
// (gm-utils.js).

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.resolve(root, p), 'utf-8');
// Absence assertions must not be satisfied -- or defeated -- by prose. Seven
// suites in this repository have been fooled by a comment naming the very
// thing it said was removed, including the one below, on first writing.
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('gm_stats_data promotion + projection extension', () => {
  const migrationPath = path.resolve(root, 'supabase/migrations/20260831000000_promote_and_extend_gm_stats_data.sql');
  const content = fs.readFileSync(migrationPath, 'utf-8');

  it('is promoted into the canonical migrations set', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    expect(content).toContain('create or replace function public.gm_stats_data');
  });

  it('extends the squads projection with squad, session_id, is_commander', () => {
    expect(content).toContain("'squad', sq.squad");
    expect(content).toContain("'session_id', sq.session_id");
    expect(content).toContain("'is_commander', sq.is_commander");
  });

  it('extends the participants projection with late, excused, appointed', () => {
    expect(content).toContain("'late', ep.late");
    expect(content).toContain("'excused', ep.excused");
    expect(content).toContain("'appointed', ep.appointed");
  });

  it('keeps the REVOKE/GRANT pattern and schema reload notification', () => {
    expect(content).toContain('revoke all on function public.gm_stats_data(text)');
    expect(content).toContain('grant execute on function public.gm_stats_data(text)');
    expect(content.trim().toLowerCase()).toMatch(/notify pgrst, 'reload schema';\s*$/);
  });
});

describe('gm_get_player_event_history RPC', () => {
  const migrationPath = path.resolve(root, 'supabase/migrations/20260831010000_gm_get_player_event_history.sql');
  const content = fs.readFileSync(migrationPath, 'utf-8');

  it('is defined with the self-OR-in-scope-admin authorization pattern already proven by gm_get_player_metrics_history', () => {
    expect(content).toContain('CREATE OR REPLACE FUNCTION public.gm_get_player_event_history(p_uid text, p_limit int DEFAULT 60)');
    expect(content).toContain('public.is_super_admin()');
    expect(content).toContain('public.check_user_guild_access(v_member.guild)');
    expect(content).toContain("a.uid = p_uid OR a.id = p_uid");
  });

  it('returns per-session score, guild average/max, and the late/excused/sub_present/appointed flags', () => {
    expect(content).toContain("'guild_avg_score', COALESCE(ss.avg_score, 0)");
    expect(content).toContain("'guild_max_score', COALESCE(ss.max_score, 0)");
    expect(content).toContain('mr.late');
    expect(content).toContain('mr.excused');
    expect(content).toContain('mr.sub_present');
    expect(content).toContain('mr.appointed');
  });

  it('is scoped to authenticated only (not anon)', () => {
    expect(content).toContain('REVOKE ALL ON FUNCTION public.gm_get_player_event_history(text, int) FROM public, anon');
    expect(content).toContain('GRANT EXECUTE ON FUNCTION public.gm_get_player_event_history(text, int) TO authenticated');
  });
});

describe('stats granularity additions (StatsView + StatsService after cutover)', () => {
  // Aggregation moved to StatsService, rendering stayed in StatsView.
  const statsView = read('src/modules/stats/views/StatsView.ts');
  const statsService = read('src/modules/stats/stats.service.ts');

  it('splits Shadowfront squad assignment into participant/reserve, squad1/squad2, and commander counts', () => {
    // The split moved into SQL with phase S5: the browser no longer receives
    // every shadowfront_squads row to tally it. Same six counters, counted once.
    const migration = read('supabase/migrations/20260927120934_gm_stats_events.sql');
    expect(migration).toContain("lower(coalesce(sq.role, '')) = 'reserve'");
    expect(migration).toContain("sq.squad = 'squad1'");
    expect(migration).toContain("sq.squad = 'squad2'");
    expect(migration).toContain('sq.is_commander');
    expect(statsService).toContain('participant_count');
    expect(statsService).toContain('commander_count');
  });

  it('still counts late and excused per row, but no longer spends a column on them', () => {
    // Measured in production on 2026-09-27: `late` is set on 0.09% of the
    // 55,739 participation rows and `excused` on 0.41%. The column rendered
    // "-" for the other 99.5%. The counters stay in the service and on the row
    // -- `excused` becomes load-bearing in phase S3, where it leaves a member's
    // denominator instead of being displayed -- so this pins the split: the
    // data survives, the column does not.
    expect(statsService).toContain('late_count');
    expect(statsService).toContain('excused_count');
    const viewCode = stripComments(statsView);
    expect(viewCode).not.toContain('showLateExcused');
    expect(viewCode).not.toContain('Late / Excused');
  });

  it('treats Glory as an event bucket rather than a separate array to normalise', () => {
    // gm_stats_data returned Glory in its own array, which the view reshaped
    // into participant-like rows by hand. Glory buckets naturally through the
    // scoring key, so gm_stats_events resolves it like any other event.
    expect(statsView).toContain("if (key === 'glory') return 'Glory'");
    expect(statsView).toContain("{ key: 'Glory'");
    const migration = read('supabase/migrations/20260927120934_gm_stats_events.sql');
    expect(migration).toContain("'Shadowfront', 'DTR', 'Arms Race', 'Glory'");
  });

  it('makes leaderboard rows clickable and dispatches to the player-history bridge', () => {
    expect(statsView).toContain('gm-stats-row-clickable');
    expect(statsView).toContain('data-player-uid');
    expect(statsView).toContain('legacy.showPlayerHistory');
    expect(statsView).toContain('state.uidMap');
  });
});

describe('Admin Player History modal (src/modules/app/dialogs/dialogs.service.ts)', () => {
  const appJs = read('src/modules/app/dialogs/dialogs.service.ts');
  const mainTs = read('src/main.ts');

  it('defines showPlayerHistoryDialog and exposes it on window.GM_APP', () => {
    expect(appJs).toMatch(/async function showPlayerHistoryDialog\(/);
    expect(mainTs).toContain('GM_APP.showPlayerHistory = showPlayerHistoryDialog');
  });

  it('calls both gm_get_player_metrics_history (previously unused) and the new gm_get_player_event_history RPC', () => {
    expect(appJs).toMatch(/\.rpc\('gm_get_player_metrics_history'/);
    expect(appJs).toMatch(/\.rpc\('gm_get_player_event_history'/);
  });

  it('renders the power trend using the chart renderer shared with the player Portal', () => {
    expect(appJs).toContain('drawScoreTrendChart');
  });
});

describe('Chart renderer extracted to /src and reused by the portal view', () => {
  const uiTs = read('src/core/dom/ui.ts');
  const dateTs = read('src/core/utils/date.ts');
  const bridgeTs = read('src/core/gm-bridge.ts');
  const portalJs = read('src/modules/portal/views/PortalView.ts');

  it('exposes drawScoreTrendChart (ui.ts) and formatChartDate (date.ts) through the GM bridge', () => {
    expect(uiTs).toContain('function drawScoreTrendChart(');
    expect(dateTs).toContain('function formatChartDate(');
    expect(bridgeTs).toContain('drawScoreTrendChart');
    expect(bridgeTs).toContain('formatChartDate');
  });

  it('the portal view delegates its own drawChart() to the shared renderer instead of a private implementation', () => {
    expect(portalJs).toContain('drawScoreTrendChart(canvas, ev.history || [])');
    expect(portalJs).not.toContain('function formatPortalDateDDMMAA');
  });
});
