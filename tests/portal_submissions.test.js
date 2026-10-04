/**
 * tests/portal_submissions.test.js
 *
 * Player Portal event submissions had never recorded anything. Measured on
 * 2026-09-30: 8 `score_submission` audit entries since 2026-08-19, none with a
 * matching `event_participants` row. Three causes, each pinned here:
 *   - Shadowfront rows live under "Shadowfront", the status under "Shadowfront Squad N";
 *   - `is_pending` defaults to false, so every pre-created row read as "validated";
 *   - an SvS/GvG war session refused the Days 1-5 score outright.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  participantEventName,
  isOfficerRecorded,
  warSubmissionRows,
} from '../supabase/functions/_shared/player-actions.ts';
import { pendingApprovalHtml, wirePendingApprovals } from '../src/modules/events/pending-approval';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

describe('participantEventName', () => {
  it('maps both Shadowfront squads to the name their rows are stored under', () => {
    expect(participantEventName('Shadowfront Squad 1')).toBe('Shadowfront');
    expect(participantEventName('Shadowfront Squad 2')).toBe('Shadowfront');
  });
  it('leaves every other event name alone', () => {
    for (const n of ['SvS', 'GvG', 'Defend Trade Route', 'ARMS RACE STAGE A', 'Shadowfront']) {
      expect(participantEventName(n)).toBe(n);
    }
  });
});

describe('isOfficerRecorded', () => {
  it('does not treat the row created at Start as validated', () => {
    expect(isOfficerRecorded({ is_pending: false, participated: 0, score: null, score_prep: null, score_pvp: null })).toBe(false);
    expect(isOfficerRecorded({ is_pending: null, participated: 0 })).toBe(false);
  });
  it('treats a row carrying participation or a score as recorded', () => {
    expect(isOfficerRecorded({ is_pending: false, participated: 1 })).toBe(true);
    expect(isOfficerRecorded({ is_pending: false, participated: 0, score_prep: 1200 })).toBe(true);
    expect(isOfficerRecorded({ is_pending: false, participated: 0, score: '5' })).toBe(true);
  });
  it('lets a player revise a submission still awaiting approval', () => {
    expect(isOfficerRecorded({ is_pending: true, participated: 1, score_prep: 1200 })).toBe(false);
  });
});

describe('warSubmissionRows', () => {
  it('files Days 1-5 as the aggregate day 0 and Day 6 as day 6', () => {
    expect(warSubmissionRows('Ann', 150000, 50000)).toEqual([
      { pseudo: 'Ann', day: 0, score: 150000 },
      { pseudo: 'Ann', day: 6, score: 50000 },
    ]);
  });
  it('writes no zero rows (a zero day 0 would still wipe the daily grid)', () => {
    expect(warSubmissionRows('Ann', 0, 50000)).toEqual([{ pseudo: 'Ann', day: 6, score: 50000 }]);
    expect(warSubmissionRows('Ann', null, null)).toEqual([]);
  });
});

describe('member-portal submit-scores', () => {
  const _src = edgeSource('member-portal');
  const handler = edgeFunctionBody('member-portal', 'submitScores');

  it('refuses loudly when the player has no row, instead of updating zero rows', () => {
    expect(handler).toContain('error: "not_in_session"');
    expect(handler).toMatch(/\.select\("pseudo"\);\s*\n\s*if \(uErr \|\| !updatedRows \|\| updatedRows\.length === 0\)/);
  });
  it('reads and writes the participant rows under the mapped name', () => {
    expect(handler).toContain('const rowEventName = participantEventName(eventName);');
    expect(handler).not.toMatch(/\.from\("event_participants"\)[\s\S]{0,200}\.eq\("event_name", eventName\)/);
  });
  it('only refuses a row an officer already recorded', () => {
    expect(handler).toContain('if (isOfficerRecorded(existing))');
    expect(handler).not.toContain('existing.is_pending === false');
  });
  it('checks the daily-scores RPC result, not just the transport error', () => {
    expect(handler).toContain('dsRow.ok !== true');
  });
});

describe('gm_upsert_daily_scores service-role parity migration', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20260930173247_daily_scores_service_role_parity.sql'), 'utf-8');
  it('gates on write access only when there is a JWT', () => {
    expect(sql).toMatch(/IF auth\.uid\(\) IS NOT NULL THEN\s+IF NOT public\.check_user_guild_write_access\(v_target\) THEN/);
  });
  it('reloads the PostgREST schema', () => {
    expect(sql).toContain("NOTIFY pgrst, 'reload schema';");
  });
});

describe('pending approval control (Arms Race, Shadowfront)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('renders nothing for a row that is not pending', () => {
    expect(pendingApprovalHtml('Ann', false)).toBe('');
  });

  it('escapes the pseudo', () => {
    expect(pendingApprovalHtml('<b>x</b>', true)).not.toContain('<b>x</b>');
  });

  it('approves through the RPC and reports back', async () => {
    document.body.innerHTML = '<div id="a">' + pendingApprovalHtml('Ann', true) + '</div>';
    const rpc = vi.fn(async () => ({ data: { ok: true, updated: 1 }, error: null }));
    const onApproved = vi.fn();
    wirePendingApprovals(document.getElementById('a'),
      { db: { rpc }, guild: 'DEMO', eventName: 'Shadowfront', sessionId: 'SF1-20260930-1', showToast: vi.fn() }, onApproved);
    document.querySelector('.pending-approve-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc).toHaveBeenCalledWith('gm_approve_participant_submission',
      { p_guild: 'DEMO', p_event_name: 'Shadowfront', p_session_id: 'SF1-20260930-1', p_pseudo: 'Ann' });
    expect(onApproved).toHaveBeenCalledWith('Ann');
  });

  it('surfaces a refused approval instead of pretending', async () => {
    document.body.innerHTML = '<div id="a">' + pendingApprovalHtml('Ann', true) + '</div>';
    const showToast = vi.fn();
    const onApproved = vi.fn();
    wirePendingApprovals(document.getElementById('a'),
      { db: { rpc: async () => ({ data: { ok: false, error: 'forbidden' }, error: null }) }, guild: 'DEMO', eventName: 'X', sessionId: 'S', showToast }, onApproved);
    document.querySelector('.pending-approve-btn').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(onApproved).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('Failed to approve submission.', 'error');
  });
});
