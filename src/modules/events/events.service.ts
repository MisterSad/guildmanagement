/**
 * src/modules/events/events.service.ts
 *
 * ES Module TypeScript service managing active event sessions,
 * score submissions, and auto-enrollment helpers.
 */

import { getSupabaseClient } from '../../core/api/supabase';
import { buildEventSessionId, sessionIdBase } from '../../core/config/events';
import { EventStatus, EventParticipant, ChestTier, WarSession, EventDailyScore, WarOpponentKind } from '../../types/database';
import { logger } from '../../core/logger/logger';

export type WarEventName = 'SvS' | 'GvG';

export interface WarOpponentInput {
  kind: WarOpponentKind;
  name: string;
  server_number?: string;
  guild_ref?: string;
}

export interface ChestTiersResult { ok: boolean; tiers: ChestTier[]; error?: string; }
export interface SaveChestTiersResult { ok: boolean; saved?: number; error?: string; }
export interface WarSessionResult { ok: boolean; session?: WarSession | null; error?: string; }
export interface DailyScoresResult { ok: boolean; rows: EventDailyScore[]; error?: string; }
export interface UpsertDailyScoresResult { ok: boolean; updated?: number; error?: string; }

/**
 * One row of the granular war score grid. `day` spans 0..6:
 *   0    — aggregate "Day 1 to 5 total" (prep total; mutually exclusive with
 *          1..5 per pseudo per session — the RPC converges the two);
 *   1..5 — per-day prep scores;
 *   6    — Day 6 PvP score.
 * `chests` is optional: when omitted, the RPC computes it from the frozen grid.
 */
export interface UpsertDailyScoreRow {
  pseudo: string;
  day: number;
  score: number;
  chests?: number;
}
export interface OpponentCandidate {
  id?: string;
  kind: string;
  name: string;
  server_number?: string | null;
  is_existing: boolean;
}
export interface OpponentCandidatesResult { ok: boolean; items: OpponentCandidate[]; error?: string; }

export interface UpsertWarSessionParams {
  guild: string;
  eventName: WarEventName;
  sessionId: string;
  opponent?: WarOpponentInput;
  dailyResults?: Record<string, 'won' | 'lost' | null>;
  startAt?: string;
}

function rpcData(resultData: unknown, fallback: Record<string, unknown>): Record<string, unknown> {
  return (resultData && typeof resultData === 'object' ? resultData : fallback) as Record<string, unknown>;
}

export class EventsService {
  public static async getActiveSessions(guild: string): Promise<EventStatus[]> {
    const supabase = getSupabaseClient();
    if (!supabase) return [];

    const { data, error } = await supabase
      .from('event_status')
      .select('*')
      .eq('guild', guild)
      .eq('is_active', true);

    if (error) {
      logger.error('Error fetching active event sessions', error, { guild });
      return [];
    }

    return (data || []) as EventStatus[];
  }

  /**
   * Session ids already taken today, read under the day's prefix only.
   *
   * Starting a daily session picks the first free `-n` suffix. The ids used to
   * be read as every participant row of the guild for that event, which
   * PostgREST caps at 1,000 rows with no order. Above that cap (9 guilds, up to
   * 3,036 rows) today's ids could be missing from the answer, and the new
   * session would reuse a taken id and merge into it (audit PERF-03).
   *
   * `participantEvent` is the event_name the participant rows carry, which
   * differs from the session's event for Shadowfront squads.
   */
  public static async takenSessionIdsToday(
    guild: string,
    participantEvent: string,
    sessionEvent: string,
    startAt?: string | Date | null
  ): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    const base = sessionIdBase(sessionEvent, startAt || new Date());
    if (!base) return { ok: true, ids: [] };
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { data, error } = await supabase
      .from('event_participants')
      .select('session_id')
      .eq('guild', guild)
      .eq('event_name', participantEvent)
      .like('session_id', base + '-%');
    if (error) {
      logger.error('Error reading today\'s session ids', error, { guild, participantEvent, base });
      return { ok: false, error: error.message };
    }
    const ids = Array.from(new Set(((data || []) as Array<{ session_id: string | null }>)
      .map((r) => r.session_id)
      .filter((id): id is string => !!id)));
    return { ok: true, ids };
  }

  public static async startEventSession(
    eventName: string,
    guild: string,
    startAt?: string
  ): Promise<{ ok: boolean; session_id?: string; error?: string }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const activeSessions = await this.getActiveSessions(guild);
    const existingIds = activeSessions
      .map((s) => s.session_id)
      .filter((id): id is string => id !== null);
    const sessionId = buildEventSessionId(eventName, startAt, existingIds);

    const { data, error } = await supabase
      .from('event_status')
      .upsert({
        event_name: eventName,
        guild,
        session_id: sessionId,
        is_active: true,
        start_at: startAt || new Date().toISOString()
      }, { onConflict: 'guild,event_name' })
      .select()
      .single();

    if (error) {
      logger.error('Error starting event session', error, { eventName, guild, sessionId });
      return { ok: false, error: error.message };
    }

    logger.info('Event session started successfully', { eventName, guild, sessionId });
    return { ok: true, session_id: data.session_id };
  }

  public static async submitParticipantScore(
    participant: EventParticipant
  ): Promise<{ ok: boolean; error?: string }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { error } = await supabase
      .from('event_participants')
      .upsert(participant, { onConflict: 'guild,event_name,session_id,pseudo' });

    if (error) {
      logger.error('Error submitting participant score', error, { pseudo: participant.pseudo, eventName: participant.event_name });
      return { ok: false, error: error.message };
    }

    return { ok: true };
  }

  // ── SvS / GvG granular war helpers (RPCs from Lot 1) ─────────────────────

  /** Active chest-tier grid for one event (SvS or GvG). */
  public static async getChestTiers(guild: string, eventName: WarEventName): Promise<ChestTiersResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, tiers: [], error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_get_chest_tiers', { p_guild: guild, p_event_name: eventName });
    if (error) {
      logger.error('gm_get_chest_tiers failed', error, { guild, eventName });
      return { ok: false, tiers: [], error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, tiers: [], error: String(payload.error || 'rpc_failed') };
    const tiers = Array.isArray(payload.tiers) ? (payload.tiers as ChestTier[]) : [];
    return { ok: true, tiers };
  }

  /** Atomically replaces the chest-tier grid for one event. */
  public static async saveChestTiers(
    guild: string,
    eventName: WarEventName,
    tiers: ChestTier[]
  ): Promise<SaveChestTiersResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_save_chest_tiers', { p_guild: guild, p_event_name: eventName, p_tiers: tiers as unknown as Record<string, unknown> });
    if (error) {
      logger.error('gm_save_chest_tiers failed', error, { guild, eventName, count: tiers.length });
      return { ok: false, error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, error: String(payload.error || 'rpc_failed') };
    return { ok: true, saved: typeof payload.saved === 'number' ? payload.saved : tiers.length };
  }

  /** Session metadata: opponent snapshot, Won/Lost per day, frozen grid. */
  public static async getWarSession(
    guild: string,
    eventName: WarEventName,
    sessionId: string
  ): Promise<WarSessionResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_get_war_session', { p_guild: guild, p_event_name: eventName, p_session_id: sessionId });
    if (error) {
      logger.error('gm_get_war_session failed', error, { guild, eventName, sessionId });
      return { ok: false, error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, error: String(payload.error || 'rpc_failed') };
    return { ok: true, session: payload.session ? (payload.session as WarSession) : null };
  }

  /** All war sessions for a guild (optionally filtered to one event). */
  public static async listWarSessions(
    guild: string,
    eventName?: WarEventName
  ): Promise<{ ok: boolean; sessions: WarSession[]; error?: string }> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, sessions: [], error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_list_war_sessions', { p_guild: guild, p_event_name: eventName || '' });
    if (error) {
      logger.error('gm_list_war_sessions failed', error, { guild, eventName });
      return { ok: false, sessions: [], error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, sessions: [], error: String(payload.error || 'rpc_failed') };
    const sessions = Array.isArray(payload.sessions) ? (payload.sessions as WarSession[]) : [];
    return { ok: true, sessions };
  }

  /** Creates or updates a war session + its opponent/daily results. */
  public static async upsertWarSession(params: UpsertWarSessionParams): Promise<WarSessionResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { data, error } = await supabase.rpc('gm_upsert_war_session', {
      p_guild: params.guild,
      p_event_name: params.eventName,
      p_session_id: params.sessionId,
      p_opponent: params.opponent ? (params.opponent as unknown as Record<string, unknown>) : null,
      p_daily_results: params.dailyResults ? (params.dailyResults as unknown as Record<string, unknown>) : null,
      p_start_at: params.startAt || null
    });
    if (error) {
      logger.error('gm_upsert_war_session failed', error, {
        guild: params.guild,
        eventName: params.eventName,
        sessionId: params.sessionId
      });
      return { ok: false, error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, error: String(payload.error || 'rpc_failed') };
    return { ok: true, session: payload.session ? (payload.session as WarSession) : null };
  }

  /** Pick-list candidates for an opponent selector (server or guild). */
  public static async listOpponentCandidates(
    guild: string,
    kind: 'server' | 'guild'
  ): Promise<OpponentCandidatesResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, items: [], error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_list_opponent_candidates', { p_guild: guild, p_kind: kind });
    if (error) {
      logger.error('gm_list_opponent_candidates failed', error, { guild, kind });
      return { ok: false, items: [], error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, items: [], error: String(payload.error || 'rpc_failed') };
    const items = Array.isArray(payload.items) ? (payload.items as OpponentCandidate[]) : [];
    return { ok: true, items };
  }

  /** Full player × day score matrix for a session. */
  public static async getDailyScores(
    guild: string,
    eventName: WarEventName,
    sessionId: string
  ): Promise<DailyScoresResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, rows: [], error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_get_daily_scores', { p_guild: guild, p_event_name: eventName, p_session_id: sessionId });
    if (error) {
      logger.error('gm_get_daily_scores failed', error, { guild, eventName, sessionId });
      return { ok: false, rows: [], error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, rows: [], error: String(payload.error || 'rpc_failed') };
    const rows = Array.isArray(payload.rows) ? (payload.rows as EventDailyScore[]) : [];
    return { ok: true, rows };
  }

  /** Batch upserts the war score grid (day 0..6). `day = 0` is the aggregate
   *  "Day 1 to 5 total" prep bucket (mutually exclusive with days 1..5 per
   *  pseudo — convergence is enforced by the RPC); chests are auto-computed
   *  by the RPC when omitted. */
  public static async upsertDailyScores(
    guild: string,
    eventName: WarEventName,
    sessionId: string,
    rows: UpsertDailyScoreRow[]
  ): Promise<UpsertDailyScoresResult> {
    const supabase = getSupabaseClient();
    if (!supabase) return { ok: false, error: 'no_client' };

    const { data, error } = await supabase
      .rpc('gm_upsert_daily_scores', {
        p_guild: guild,
        p_event_name: eventName,
        p_session_id: sessionId,
        p_rows: rows as unknown as Record<string, unknown>[]
      });
    if (error) {
      logger.error('gm_upsert_daily_scores failed', error, { guild, eventName, sessionId, count: rows.length });
      return { ok: false, error: error.message };
    }

    const payload = rpcData(data, {});
    if (payload.ok !== true) return { ok: false, error: String(payload.error || 'rpc_failed') };
    return { ok: true, updated: typeof payload.updated === 'number' ? payload.updated : rows.length };
  }
}

// ── Events view constants (verbatim from the root events.js) ──────────────────

export const STANDARD_EVENTS = ['SvS', 'GvG', 'Defend Trade Route'];

/** UI tab → DB event_name(s) it drives (Arms Race has 2 stages). */
export const TAB_TO_DB_EVENTS: Record<string, string[]> = {
  'SvS': ['SvS'],
  'GvG': ['GvG'],
  'Defend Trade Route': ['Defend Trade Route']
};

export const PANEL_MAP: Record<string, string> = {
  'SvS': 'event-svs',
  'GvG': 'event-gvg',
  'Defend Trade Route': 'event-dtr'
};

export const EVENTS_WITHOUT_SCORE = ['Defend Trade Route'];

/** These tabs require an admin-set UTC start date before launching. */
export const SCHEDULED_TABS = ['SvS', 'GvG', 'Defend Trade Route'];

export type EventTabKey = 'SvS' | 'GvG' | 'Defend Trade Route';

export interface EventTabState {
  activeEventName: string | null;
  sessionId: string | null;
  stage: string | null;
  startAt?: string | null;
  isActive: boolean;
  participants: any[];
}
