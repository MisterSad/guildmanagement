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
export type SystemAuditLog = Tables['system_audit_logs']['Row'];
export type Ticket = Tables['tickets']['Row'];
export type DiplomaticTreaty = Tables['diplomatic_treaties']['Row'];
export type GmPayment = Tables['gm_payments']['Row'];
export type E2eeMessage = Tables['e2ee_messages']['Row'];
export type E2eeConversation = Tables['e2ee_conversations']['Row'];

// Not a table — `guilds.subscription_type`/`subscription_end` describe this,
// kept as a convenience shape for subscription UI code.
export interface GuildSubscription {
  guild: string;
  type: 'Free' | 'Premium' | 'Unlimited' | 'Lifetime';
  end?: string | null;
  server_number?: number | null;
}
