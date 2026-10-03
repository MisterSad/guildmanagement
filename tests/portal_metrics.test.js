// Regression guard for the 2026-08-23 portal metrics outage: the Player Portal
// "Military Force Breakdown & Guild Benchmarks" tiles were always empty because
// the get-active-sessions response never included the member's military metrics
// and getGuildAverages never computed per-metric guild averages.

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const memberLookupPath = path.resolve(__dirname, '../supabase/functions/_shared/member-lookup.ts');

describe('Player Portal military metrics response (v127.1)', () => {
  it('getPlayer selects the full military metric set including timezone and metrics timestamp', () => {
    // getPlayer moved to _shared/member-lookup.ts (2026-09, Discord bot Phase
    // 1) so discord-bot-interactions can reuse the exact same query for
    // /myinfo instead of duplicating it -- member-portal now imports it.
    const content = fs.readFileSync(memberLookupPath, 'utf-8');
    const selectMatch = content.match(/\.select\("pseudo, guild, overall_power, power_updated_at, metrics_updated_at, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, role, timezone_offset(?:,\s*timezone)?"\)/);
    expect(selectMatch).not.toBeNull();
  });

  it('member-portal imports getPlayer from the shared module instead of redefining it', () => {
    const content = edgeSource('member-portal');
    expect(content).toMatch(/import \{ getPlayer \} from "(?:\.\.\/)+_shared\/member-lookup\.ts"/);
    expect(content).not.toMatch(/async function getPlayer\(/);
  });

  it('get-active-sessions response carries every metric field the portal tiles render', () => {
    const content = edgeSource('member-portal');
    const sessionsBlock = edgeFunctionBody('member-portal', 'getActiveSessions');
    for (const field of [
      'overall_power', 'tech_power', 'champion_power', 'crew_power',
      'flagship_power', 'fleet_rating', 'glory_score',
      'timezone_offset', 'power_updated_at', 'metrics_updated_at'
    ]) {
      expect(
        sessionsBlock.includes(`${field}: member.${field}`),
        `get-active-sessions response must include ${field}: member.${field}`
      ).toBe(true);
    }
  });

  it('getGuildAverages computes per-metric guild averages for every benchmark tile', () => {
    const content = edgeSource('member-portal');
    const avgBlock = content.slice(
      content.indexOf('async function getGuildAverages'),
      content.indexOf('async function', content.indexOf('async function getGuildAverages') + 10)
    );
    for (const field of [
      'fleet_rating', 'tech_power', 'flagship_power',
      'champion_power', 'crew_power', 'glory_score'
    ]) {
      expect(
        avgBlock.includes(`${field}: avgOf(`),
        `getGuildAverages must return ${field} average`
      ).toBe(true);
    }
    // overall_power average may be inlined via the pre-computed avgPower variable
    expect(avgBlock).toContain('overall_power: avg');

    // `attendance_rate` used to be returned from here, computed as
    //   attended rows / all rows
    // over EVERY event_participants row of the guild: no session
    // de-duplication, no week window, Glory included (100% participated by
    // construction) and unapproved rows included. Measured on ALPHA it gave
    // 48.1% where the admin's Stats page gave 31.6% on the same data. It is
    // gone, with the unbounded scan that fed it; the rate now comes from
    // gm_player_stats on the same rules both sides use.
    expect(avgBlock).not.toContain('attendance_rate');
    expect(avgBlock, 'the unbounded event_participants scan must not come back')
      .not.toContain('.from("event_participants")');
    expect(avgBlock).toContain('avg_power');
    expect(avgBlock).toContain('member_count');
  });
});
