/**
 * supabase/functions/_shared/discord-channel-mode.ts
 *
 * Which mode the Discord screenshot reader runs in for one channel
 * (public.discord_channel_modes). A channel with no row is an ordinary
 * verification channel, configured per guild in `guild_config`.
 *
 * The mode is resolved here, server-side, from the channel the worker names,
 * never taken from the request: a request cannot ask for a narrower or a wider
 * mode than the one the operator configured. The row must also name the same
 * Discord server as the request, so a channel id alone cannot borrow a mode.
 */
import type { AdminClient } from "./db.ts";

export type ChannelMode = "rename_only";

export type ChannelModeLookup = { ok: true; mode: ChannelMode | null } | { ok: false };

const SNOWFLAKE = /^[0-9]{17,20}$/;

export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value);
}

export async function resolveChannelMode(
  admin: AdminClient,
  discordServerId: string,
  channelId: string
): Promise<ChannelModeLookup> {
  if (!isSnowflake(channelId) || !isSnowflake(discordServerId)) return { ok: true, mode: null };
  try {
    const { data, error } = await admin
      .from("discord_channel_modes")
      .select("mode, discord_server_id")
      .eq("channel_id", channelId)
      .maybeSingle();
    if (error) return { ok: false };
    const row = data as { mode?: string; discord_server_id?: string } | null;
    if (!row || row.discord_server_id !== discordServerId) return { ok: true, mode: null };
    return { ok: true, mode: row.mode === "rename_only" ? "rename_only" : null };
  } catch {
    return { ok: false };
  }
}
