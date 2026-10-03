/**
 * supabase/functions/_shared/member-lookup.ts
 *
 * Player roster lookup, extracted from member-portal so a second caller
 * (discord-bot-interactions, for /myinfo) can reuse the exact same query
 * instead of duplicating it or making an internal network hop between
 * Edge Functions (which would also require faking an authenticated
 * context member-portal doesn't otherwise need).
 */
import type { AdminClient } from "./db.ts";

export interface MemberSnapshot {
  pseudo: string;
  guild: string;
  overall_power?: number;
  power_updated_at?: string;
  metrics_updated_at?: string;
  tech_power?: number;
  champion_power?: number;
  crew_power?: number;
  flagship_power?: number;
  fleet_rating?: number;
  glory_score?: number;
  role?: string;
  timezone_offset?: number | null;
  timezone?: string | null;
}

export async function getPlayer(
  admin: AdminClient,
  uid: string,
  guildContext: string | null
): Promise<MemberSnapshot | null> {
  let query = admin
    .from("guild_members")
    .select("pseudo, guild, overall_power, power_updated_at, metrics_updated_at, tech_power, champion_power, crew_power, flagship_power, fleet_rating, glory_score, role, timezone_offset, timezone")
    .eq("uid", uid);

  if (guildContext) {
    query = query.eq("guild", guildContext);
  }

  const { data: rows, error } = await query.limit(1);

  if (error || !rows || rows.length === 0) return null;
  return rows[0] as MemberSnapshot;
}
