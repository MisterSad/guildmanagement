/**
 * supabase/functions/_shared/discord.ts
 *
 * Shared helpers for the Discord bot integration (slash commands only --
 * no Gateway connection). Mirrors _shared/stripe.ts's shape: the endpoint
 * is intentionally public (verify_jwt: false, Discord calls it without a
 * Supabase JWT), authenticated instead by verifying every request's
 * Ed25519 signature against DISCORD_PUBLIC_KEY.
 *
 * Env vars (set as Supabase Edge Function secrets):
 *   DISCORD_PUBLIC_KEY    -- hex-encoded Ed25519 public key from the
 *                            Discord Developer Portal (General Information)
 *   DISCORD_APPLICATION_ID
 *   DISCORD_BOT_TOKEN     -- only needed for outbound calls (command
 *                            registration, follow-up messages), not for
 *                            verifying inbound interactions
 */

// Discord interaction/response type constants (Discord Interactions API).
export const InteractionType = {
  PING: 1,
  APPLICATION_COMMAND: 2,
} as const;

export const InteractionResponseType = {
  PONG: 1,
  CHANNEL_MESSAGE_WITH_SOURCE: 4,
  DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE: 5,
} as const;

export const EPHEMERAL_FLAG = 1 << 6; // 64

export function discordPublicKeyHex(): string | undefined {
  return Deno.env.get("DISCORD_PUBLIC_KEY") || undefined;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Verifies a Discord interaction request signature.
 * Signed message is `timestamp + rawBody` (UTF-8), per Discord's spec.
 */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string
): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      hexToBytes(publicKeyHex),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const message = new TextEncoder().encode(timestamp + rawBody);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signatureHex), message);
  } catch (_err) {
    return false;
  }
}

export function discordJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
