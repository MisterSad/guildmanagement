// Semantic aliases over the generated schema (database.generated.ts).
// Regenerate the generated file with `generate_typescript_types` (Supabase MCP)
// or `supabase gen types typescript` whenever migrations change; this file
// only re-derives friendlier names from it, so a renamed/dropped column or
// table fails the build here instead of drifting silently.

import type { Database } from './database.generated';

export type { Database, Json } from './database.generated';

type Tables = Database['public']['Tables'];

// Not derivable from generated types: `role` is a free-text column backed by
// a CHECK constraint, not a Postgres enum, so codegen only sees `string`.
export type AccountRole = 'super_admin' | 'server_admin' | 'guild_admin' | 'member';

export type GuildAccount = Tables['accounts']['Row'];
export type GuildMember = Tables['guild_members']['Row'];
export type PlayerMetricsHistory = Tables['player_metrics_history']['Row'];
export type EventStatus = Tables['event_status']['Row'];
export type EventParticipant = Tables['event_participants']['Row'];
export type EventDailyScore = Tables['event_daily_scores']['Row'];
export type EventChestTier = Tables['event_chest_tiers']['Row'];
export type WarOpponent = Tables['war_opponents']['Row'];
export type WarSession = Tables['war_sessions']['Row'];
export type SystemAuditLog = Tables['system_audit_logs']['Row'];
export type Ticket = Tables['tickets']['Row'];

// `E2eeMessage` / `E2eeConversation` were removed here: the Leader Hall E2EE
// tables were dropped by 20260913000000_drop_leader_hall_e2ee.sql and neither
// alias had a single consumer left. They only survived because
// database.generated.ts had gone stale and still described the dropped tables --
// regenerating it turned them into the build failure this file's header promises.

// SvS / GvG granular scoring domain types (free-text columns behind CHECK
// constraints, so codegen only exposes `string` — narrowed here).
export type WarOpponentKind = 'server' | 'guild';
export type WarDayResult = 'won' | 'lost' | null;

/** A threshold tier of the parametrizable chest grid (one row of the grid). */
export interface ChestTier {
  day: number;
  tier: number;
  min_score: number;
  chests: number;
}

/** Frozen opponent identity stored on a war session. */
export interface WarOpponentSnapshot {
  kind?: WarOpponentKind;
  name?: string;
  server_number?: string | null;
  guild_ref?: string | null;
}

