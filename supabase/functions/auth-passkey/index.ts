import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
} from "https://esm.sh/@simplewebauthn/server@10.0.1";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";

// Phase A scope: register-options + register-verify only. Passkey/backup-code
// login (auth-options/auth-verify/backup-login) and the admin reset escape
// hatch are separate, later phases of the same feature.
//
// rpID/origin MUST be the real production host — WebAuthn's rpID has to be
// the exact domain (or a registrable suffix of it) the browser is actually
// on, so this only works from https://guildmanagement.vercel.app, not from
// localhost or a per-PR Vercel preview subdomain. See AGENTS.md / ARCHITECTURE.md.
const RP_NAME = "FGF Guild Management Tool";
const RP_ID = "guildmanagement.vercel.app";
const ORIGIN = "https://guildmanagement.vercel.app";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function makeJson(req: Request) {
  return (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...getCorsHeaders(req), "Content-Type": "application/json" },
    });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface Identity {
  accountId: string;
  role: string;
  guild: string | null;
}

/**
 * Resolves identity cryptographically from the JWT via accounts.auth_user_id
 * — same pattern as member-portal's getIdentity(), but scoped to the
 * canonical account id only (passkeys are per-account, not per-player-uid,
 * so admin accounts without a player uid can enroll one too).
 */
async function getIdentity(
  req: Request,
  admin: ReturnType<typeof createClient>
): Promise<Identity | null> {
  const authHeader = req.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/i);
  if (!match) return null;

  const jwt = match[1].trim();
  const anonClient = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data: { user }, error } = await anonClient.auth.getUser(jwt);
  if (error || !user) return null;

  const { data: acc } = await admin
    .from("accounts")
    .select("id, role, guild, status")
    .eq("auth_user_id", user.id)
    .maybeSingle();

  if (!acc || acc.status !== "active") return null;

  return {
    accountId: acc.id as string,
    role: (acc.role || "member") as string,
    guild: (acc.guild || null) as string | null,
  };
}

let lastChallengePurge = 0;
function purgeExpiredChallenges(admin: ReturnType<typeof createClient>): void {
  const now = Date.now();
  if (now - lastChallengePurge < 600_000) return;
  lastChallengePurge = now;
  admin
    .from("webauthn_challenges")
    .delete()
    .lt("expires_at", new Date().toISOString())
    .then(() => {})
    .catch(() => {});
}

Deno.serve(async (req: Request) => {
  const json = makeJson(req);
  const logger = new EdgeLogger("auth-passkey", req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: getCorsHeaders(req) });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  try {
    let action = "";
    // deno-lint-ignore no-explicit-any
    let payload: any = {};
    try {
      const body = await req.json();
      action = (body?.action ?? "").toString();
      payload = body?.payload ?? {};
    } catch (err) {
      logger.error("Failed to parse request JSON", err);
      return json({ ok: false, error: "bad_request" }, 400);
    }

    if (!action) return json({ ok: false, error: "missing_action" }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    const clientIp = extractClientIp(req.headers);
    const throttle = await checkAndRecordIpAttempt(admin, clientIp, { limit: 30, windowMs: 300_000 });
    if (!throttle.allowed) {
      logger.warn("IP rate limit exceeded on auth-passkey", { ip: clientIp, action });
      return json({ ok: false, error: "too_many_attempts" }, 429);
    }

    const identity = await getIdentity(req, admin);
    if (!identity) {
      logger.warn("Unauthorized attempt to access auth-passkey", { action });
      return json({ ok: false, error: "unauthorized" }, 401);
    }
    logger.setContext({ tenantId: identity.guild, userId: identity.accountId });

    if (action === "register-options") {
      purgeExpiredChallenges(admin);

      const { data: existing, error: existingErr } = await admin
        .from("account_passkeys")
        .select("credential_id, transports")
        .eq("account_id", identity.accountId);
      if (existingErr) {
        logger.error("Failed to load existing passkeys", existingErr);
        return json({ ok: false, error: "server_error" }, 500);
      }

      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: RP_ID,
        userName: identity.accountId,
        userID: new TextEncoder().encode(identity.accountId),
        attestationType: "none",
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "preferred",
        },
        excludeCredentials: (existing || []).map((row) => {
          const transports = Array.isArray(row.transports) && row.transports.length > 0
            ? row.transports
            : undefined;
          return { id: row.credential_id as string, transports };
        }),
      });

      const { error: insErr } = await admin.from("webauthn_challenges").insert({
        account_id: identity.accountId,
        challenge: options.challenge,
        ceremony_type: "registration",
      });
      if (insErr) {
        logger.error("Failed to store registration challenge", insErr);
        return json({ ok: false, error: "server_error" }, 500);
      }

      return json({ ok: true, options });
    }

    if (action === "register-verify") {
      const credential = payload?.credential;
      if (!credential || typeof credential !== "object") {
        return json({ ok: false, error: "missing_credential" }, 400);
      }

      const rawLabel = typeof payload?.device_label === "string" ? payload.device_label.trim() : "";
      const deviceLabel = (rawLabel || "Unknown device").slice(0, 100);

      const { data: challengeRows, error: chErr } = await admin
        .from("webauthn_challenges")
        .select("id, challenge, expires_at")
        .eq("account_id", identity.accountId)
        .eq("ceremony_type", "registration")
        .order("created_at", { ascending: false })
        .limit(1);
      if (chErr) {
        logger.error("Failed to load registration challenge", chErr);
        return json({ ok: false, error: "server_error" }, 500);
      }

      const challengeRow = challengeRows?.[0];
      if (!challengeRow || new Date(challengeRow.expires_at).getTime() < Date.now()) {
        logger.warn("No pending registration challenge", { accountId: identity.accountId });
        return json({ ok: false, error: "challenge_expired" }, 400);
      }

      // Single-use: consume the challenge before verifying so a retried
      // request can't replay it regardless of the verification outcome.
      await admin.from("webauthn_challenges").delete().eq("id", challengeRow.id);

      let verification;
      try {
        verification = await verifyRegistrationResponse({
          response: credential,
          expectedChallenge: challengeRow.challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
        });
      } catch (err) {
        logger.warn("Registration verification threw", { error: String(err) });
        return json({ ok: false, error: "verification_failed" }, 400);
      }

      if (!verification.verified || !verification.registrationInfo) {
        return json({ ok: false, error: "verification_failed" }, 400);
      }

      const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
      const transports = Array.isArray(credential?.response?.transports)
        ? credential.response.transports
        : [];

      const { data: inserted, error: insErr } = await admin
        .from("account_passkeys")
        .insert({
          account_id: identity.accountId,
          credential_id: credentialID,
          public_key: bytesToBase64Url(credentialPublicKey),
          sign_count: counter,
          transports,
          device_label: deviceLabel,
        })
        .select("id, device_label, created_at")
        .single();

      if (insErr) {
        if (insErr.code === "23505") {
          return json({ ok: false, error: "already_registered" }, 409);
        }
        logger.error("Failed to store new passkey", insErr);
        return json({ ok: false, error: "server_error" }, 500);
      }

      logger.info("Passkey registered", { accountId: identity.accountId, passkeyId: inserted.id });
      return json({ ok: true, passkey: inserted });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (err) {
    logger.error("Unhandled error in auth-passkey", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
