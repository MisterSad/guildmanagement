/**
 * A player and their admin must read the same number.
 *
 * They did not. Measured on ALPHA, same guild, same data, same day: the Player
 * Portal told members their guild attends 48.1% while the admin's Stats page
 * said 31.6%. The Portal counted attended ROWS over ALL rows of the guild --
 * no session de-duplication, no week window, Glory included (it is 100%
 * "participated" by construction) and rows still awaiting approval included.
 *
 * A number that two people read differently is worse than no number, because
 * it makes both of them wrong in an argument about it. What is asserted here
 * is that there is ONE implementation of the weighting and that both screens
 * reach it.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { weightedRate, coeffBucketOf } from '../src/core/scoring/reliability';
import { StatsService } from '../src/modules/stats/stats.service';
import { DEFAULT_EVENT_COEFFS } from '../src/core/config/event-coeffs';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const portal = stripComments(read('src/modules/portal/views/PortalView.ts'));
const edge = stripComments(read('supabase/functions/member-portal/index.ts'));
const migration = read('supabase/migrations/20260927123150_gm_player_stats.sql');

describe('there is one weighting, in core, and both screens import it', () => {
  it('the Stats page and the Portal reach the same module', () => {
    expect(stripComments(read('src/modules/stats/stats.service.ts')))
      .toContain("from '../../core/scoring/reliability'");
    expect(portal).toContain("from '../../../core/scoring/reliability'");
  });

  it('produces the same number for the same counts, through both entry points', () => {
    // The Stats board goes through computeReliabilityLeaderboard; the Portal
    // calls weightedRate directly. Same buckets in, same rate out.
    const buckets = {
      SvS: { att: 1, opp: 2, exc: 0 },
      'Arms Race': { att: 4, opp: 8, exc: 0 },
      DTR: { att: 3, opp: 3, exc: 0 }
    };

    const viaPortal = weightedRate(buckets, DEFAULT_EVENT_COEFFS);
    const viaStats = StatsService.computeReliabilityLeaderboard({
      ok: true,
      members: [{
        pseudo: 'X', attended: 8, weeks_active: 1, late_count: 0,
        excused_count: 0, sub_count: 0, buckets
      }],
      tenant: { total_events: 13, buckets: {} },
      glory: []
    }, DEFAULT_EVENT_COEFFS)[0];

    expect(Math.round(viaPortal.rate * 10) / 10).toBe(viaStats.reliability);
  });

  it('weighs an unrecognised bucket at 1 rather than dropping it', () => {
    expect(coeffBucketOf('Some New Event')).toBeNull();
    const r = weightedRate({ 'Some New Event': { att: 1, opp: 2 } }, DEFAULT_EVENT_COEFFS);
    expect(r.rate).toBe(50);
  });

  it('returns null, not 0, when nothing ran', () => {
    expect(weightedRate({ SvS: { att: 0, opp: 0 } }, DEFAULT_EVENT_COEFFS).rate).toBeNull();
    expect(weightedRate({}, DEFAULT_EVENT_COEFFS).rate).toBeNull();
  });
});

describe('the portal no longer computes a rate of its own', () => {
  it('has dropped the row-pooled guild attendance rate and its unbounded scan', () => {
    const block = edge.slice(edge.indexOf('async function getGuildAverages'),
                             edge.indexOf('export async function handleRequest'));
    expect(block).not.toContain('attendance_rate');
    expect(block, 'it fetched every participation row of the tenant to count two things')
      .not.toContain('.from("event_participants")');
  });

  it('shows one attendance figure on the dashboard, not two', () => {
    // The stats strip used to print its own "Attendance rate" a few
    // centimetres from the reliability card, answering the same question with
    // a different denominator.
    expect(portal).not.toContain('portal-stat-label">Attendance rate');
    expect(portal).toContain('Your reliability');
  });

  it('states that it weights with the standard coefficients', () => {
    // A member cannot read guild_config, so a guild that customised its
    // weights will see a slightly different figure from its admin. Said on
    // the card rather than passed off as identical.
    expect(portal).toContain('standard weights');
  });
});

describe('the KPI grid is reachable at all', () => {
  it('assigns the state every card guards on', () => {
    // `state.kpis` was declared, initialised to null and never assigned: the
    // response was destructured into a local and only guild_averages read from
    // it, so every card behind `if (kpis && kpis.power)` was dead code.
    expect(portal).toContain('this.state.kpis =');
    expect(portal).toContain('this.state.reliability =');
  });

  it('grades the rally against the guild, not against the player themselves', () => {
    // With kpis always null, maxGuildPower fell back to
    // `player.overall_power * 1.25` -- a ceiling derived from the player's own
    // power, which no amount of progress could ever move them up.
    expect(portal).toContain('Number(guildTotals.max_power)');
    expect(portal).toContain('guild_totals');
  });
});

describe('the player RPC cannot leak a peer', () => {
  it('is service_role only', () => {
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.gm_player_stats(text, text, integer) FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.gm_player_stats(text, text, integer) TO service_role');
    expect(migration).toContain('must not be reachable from a browser');
  });

  it('returns the caller\'s own buckets and the guild pooled total, and no rank', () => {
    expect(migration).toContain('WHERE mo.pseudo = v_pseudo');
    expect(migration).toContain('member_opportunities');
    expect(migration.toLowerCase()).not.toContain('row_number() over');
  });

  it('applies the same exclusions as the admin side', () => {
    expect(migration).toContain("ep.event_name <> 'Glory'");
    expect(migration).toContain('coalesce(ep.is_pending, false) = false');
    expect(migration).toContain('o.week_start >= r.joined_week');
  });
});

describe('the Glory badge counts every week a player recorded', () => {
  it('no longer discards the oldest one', () => {
    // Measured: 658 of the 1,686 players with any Glory have exactly one week,
    // so `.slice(1)` left their best at 0 and they earned no Glory badge at
    // all -- one of them holding 369,393,189, seven times the top threshold.
    // A further 287 had their best week dropped for being their first.
    const block = edge.slice(edge.indexOf('const gloryBest'), edge.indexOf('const gloryBest') + 400);
    expect(block).not.toContain('.slice(1)');
    expect(block).toContain('.reduce(');
    expect(edge).not.toContain('if ((gloryRows ?? []).length > 1)');
  });
});
