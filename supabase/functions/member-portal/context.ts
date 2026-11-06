/**
 * supabase/functions/member-portal/context.ts
 *
 * What every member-portal action receives, and the guild averages several of
 * them show beside the player's own figures.
 */

import type { EdgeLogger } from "../_shared/logger.ts";
import type { AdminClient } from "../_shared/db.ts";

export interface PlayerIdentity {
  accountId: string;
  role: string;
  guild: string | null;
  uid: string | null;
}

/** One authenticated, rate-limited, validated portal request. */
export interface PortalContext {
  admin: AdminClient;
  logger: EdgeLogger;
  json: (body: unknown, status?: number) => Response;
  identity: PlayerIdentity;
  /** The player key: the in-game UID the account claimed (never its account id, SEC2-01). */
  uid: string;
  /** The action's payload, already parsed by its schema when it has one. */
  payload: any;
}

export async function getGuildAverages(
  admin: AdminClient,
  guild: string
): Promise<{
  avg_power: number;
  member_count: number;
  overall_power?: number;
  fleet_rating?: number;
  tech_power?: number;
  flagship_power?: number;
  champion_power?: number;
  crew_power?: number;
  glory_score?: number;
}> {
  try {
    const { data: members } = await admin
      .from("guild_members")
      .select("overall_power, fleet_rating, tech_power, flagship_power, champion_power, crew_power, glory_score")
      .eq("guild", guild);

    const count = members?.length || 0;
    const avgOf = (field: string): number => {
      if (count <= 0) return 0;
      const total = members?.reduce((sum: number, m: any) => sum + (Number(m[field]) || 0), 0) || 0;
      return Math.round(total / count);
    };
    const avgPower = avgOf("overall_power");

    // The guild attendance rate used to be computed here as
    //   attended rows / all rows
    // over EVERY event_participants row of the guild: no session
    // de-duplication, no week window, Glory included (it is 100% participated
    // by construction, 6,038 rows) and rows still awaiting approval included.
    // Measured on ALPHA it produced 48.1% while the admin's Stats page said
    // 31.6% for the same guild on the same data. A number a guild leader and a
    // guild member read differently is worse than no number.
    //
    // It now comes from gm_player_stats, on exactly the rules the admin side
    // uses. The unbounded scan of event_participants goes with it -- this
    // function ran it on three separate actions.
    return {
      avg_power: avgPower,
      member_count: count,
      overall_power: avgPower,
      fleet_rating: avgOf("fleet_rating"),
      tech_power: avgOf("tech_power"),
      flagship_power: avgOf("flagship_power"),
      champion_power: avgOf("champion_power"),
      crew_power: avgOf("crew_power"),
      glory_score: avgOf("glory_score"),
    };
  } catch (_) {
    return { avg_power: 0, member_count: 0 };
  }
}
