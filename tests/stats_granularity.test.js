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

describe('stats.js granularity additions', () => {
  const statsJs = read('stats.js');

  it('splits Shadowfront squad assignment into participant/reserve, squad1/squad2, and commander counts', () => {
    expect(statsJs).toContain('participantCounts');
    expect(statsJs).toContain('reserveCounts');
    expect(statsJs).toContain('squad1Counts');
    expect(statsJs).toContain('squad2Counts');
    expect(statsJs).toContain('commanderCounts');
    expect(statsJs).toContain("sq.squad === 'squad1'");
    expect(statsJs).toContain('sq.is_commander');
  });

  it('tracks late/excused counts per row and exposes a Late/Excused column gated to Event Deep-Dive only', () => {
    expect(statsJs).toContain('late_count');
    expect(statsJs).toContain('excused_count');
    expect(statsJs).toContain('showLateExcused');
    expect(statsJs).toContain("state.primaryView === 'events'");
  });

  it('adds Glory as a normalized-row source in loadSingleEventMode and to the event picker', () => {
    expect(statsJs).toContain("eventName === 'Glory'");
    expect(statsJs).toContain('raw && raw.glory');
    expect(statsJs).toContain("{ key: 'Glory'");
  });

  it('makes leaderboard rows clickable and dispatches to window.GM_APP.showPlayerHistory', () => {
    expect(statsJs).toContain('gm-stats-row-clickable');
    expect(statsJs).toContain('data-player-uid');
    expect(statsJs).toContain('window.GM_APP.showPlayerHistory');
    expect(statsJs).toContain('state.uidMap');
  });
});

describe('Admin Player History modal (app.js)', () => {
  const appJs = read('app.js');

  it('defines showPlayerHistoryDialog and exposes it on window.GM_APP', () => {
    expect(appJs).toContain('async function showPlayerHistoryDialog(uid, pseudo)');
    expect(appJs).toContain('window.GM_APP.showPlayerHistory = showPlayerHistoryDialog');
  });

  it('calls both gm_get_player_metrics_history (previously unused) and the new gm_get_player_event_history RPC', () => {
    expect(appJs).toContain("supabase.rpc('gm_get_player_metrics_history'");
    expect(appJs).toContain("supabase.rpc('gm_get_player_event_history'");
  });

  it('renders the power trend using the chart renderer shared with the player Portal', () => {
    expect(appJs).toContain('window.GM.drawScoreTrendChart');
  });
});

describe('Chart renderer extracted to gm-utils.js and reused by portal.js', () => {
  const utilsJs = read('gm-utils.js');
  const portalJs = read('portal.js');

  it('gm-utils.js defines and exports drawScoreTrendChart and formatChartDate', () => {
    expect(utilsJs).toContain('function drawScoreTrendChart(canvas, history)');
    expect(utilsJs).toContain('function formatChartDate(h)');
    expect(utilsJs).toContain('drawScoreTrendChart: drawScoreTrendChart');
    expect(utilsJs).toContain('formatChartDate: formatChartDate');
  });

  it('portal.js delegates its own drawChart() to the shared renderer instead of a private implementation', () => {
    expect(portalJs).toContain('window.GM.drawScoreTrendChart(canvas, ev.history || [])');
    expect(portalJs).not.toContain('function formatPortalDateDDMMAA');
  });
});
