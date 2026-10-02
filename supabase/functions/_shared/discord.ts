/**
 * supabase/functions/_shared/discord.ts
 *
 * Shared helpers for the Discord bot integration (slash commands only --
 * no Gateway connection). The endpoint it serves is intentionally public
 * (verify_jwt: false, Discord calls it without a
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
  MESSAGE_COMPONENT: 3,
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
 * How far a Discord interaction timestamp may be from our clock.
 *
 * Matches the tolerance the (now removed) Stripe webhook verifier used, and
 * Discord's own guidance.
 */
export const DISCORD_TIMESTAMP_TOLERANCE_S = 300;

/**
 * Verifies a Discord interaction request signature.
 * Signed message is `timestamp + rawBody` (UTF-8), per Discord's spec.
 *
 * FINDING B3, now closed: the signature was verified but the timestamp was
 * never checked for freshness, so a single captured interaction stayed valid
 * forever — its signature covers the timestamp, so replaying both together
 * verified perfectly. Anything outside the tolerance is now refused before the
 * cryptography runs.
 */
export async function verifyDiscordSignature(
  publicKeyHex: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > DISCORD_TIMESTAMP_TOLERANCE_S) {
    return false;
  }
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
