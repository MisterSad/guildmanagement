import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "https://esm.sh/@simplewebauthn/server@10.0.1";
import { EdgeLogger } from "../_shared/logger.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { extractClientIp, checkAndRecordIpAttempt } from "../_shared/rate-limit.ts";
import { establishShadowSession } from "../_shared/shadow-session.ts";
import { canManageAccount, type Role } from "../_shared/admin-authz.ts";

// Two groups of actions:
//  - Unauthenticated (part of the login flow itself, no session yet):
//    auth-options/auth-verify (passkey login) and backup-login. Handled
//    before the identity gate below, mirroring auth-login/index.ts.
//    auth-options/auth-verify support BOTH a scoped ceremony (an id was
//    typed first — the only path that works for a non-resident/hardware
//    security key) and a fully discoverable one (no id — the browser's
//    native picker shows every passkey registered for this site across
//    every account, and auth-verify resolves which account from the
//    credential's own userHandle). Without this, someone with passkeys on
//    more than one account (e.g. a super_admin account and a separate
//    Player Portal account) would only ever see whichever account's
//    passkeys matched an id they'd already typed.
//  - Authenticated (require an already-logged-in session): register-options/
//    register-verify (enroll a new passkey), list/rename/remove (manage
//    existing ones), regenerate-backup-codes, and admin-reset-passkeys (the
//    admin escape hatch for an account that's lost every device and its
//    backup codes — same canManageAccount authorization matrix as
//    admin-accounts' reset-password).
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

function base64UrlToBytes(b64url: string): Uint8Array {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(pad));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Case-insensitive lookup matching gm_check_login's own semantics
// (WHERE LOWER(id) = LOWER(TRIM(p_id))) — needed because the passkey/backup
// login actions run before any identity is established, so they take the
// same free-text id the password login form does.
async function lookupAccountById(admin: ReturnType<typeof createClient>, rawId: unknown) {
  const trimmed = typeof rawId === "string" ? rawId.trim() : "";
  if (!trimmed) return null;
  const { data } = await admin
    .from("accounts")
    .select("id, role, guild, status, locked_until")
    .ilike("id", trimmed)
    .maybeSingle();
  return data;
}

// Accepts the code with or without its "XXXXX-XXXXX" dash, any casing, and
// stray whitespace — the hash only matches the canonical dashed form it was
// generated in, so this reconstructs that form before hashing.
function normalizeBackupCode(raw: string): string {
  const alnum = (raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (alnum.length !== 10) return alnum;
  return alnum.slice(0, 5) + "-" + alnum.slice(5, 10);
}

// Backup codes: excludes visually-ambiguous characters (0/O, 1/I/L).
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomBackupCode(): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (const b of bytes) raw += BACKUP_CODE_ALPHABET[b % BACKUP_CODE_ALPHABET.length];
  return raw.slice(0, 5) + "-" + raw.slice(5, 10);
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Replaces an account's entire backup-code set with a fresh one (one shared
 * set per account — regenerating always invalidates the prior set). Codes
 * are returned in plaintext exactly once; only their SHA-256 hash is stored.
 */
async function issueBackupCodes(
  admin: ReturnType<typeof createClient>,
  accountId: string
): Promise<string[]> {
  await admin.from("account_backup_codes").delete().eq("account_id", accountId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const codes = Array.from({ length: BACKUP_CODE_COUNT }, randomBackupCode);
    const rows = await Promise.all(
      codes.map(async (code) => ({ account_id: accountId, code_hash: await sha256Hex(code) }))
    );
    const { error } = await admin.from("account_backup_codes").insert(rows);
    if (!error) return codes;
    if (error.code !== "23505") throw error; // only retry on a hash collision
  }
  throw new Error("backup_code_generation_failed");
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

    // ── Unauthenticated actions: these ARE the login flow, so there is no
    // session yet to gate on.
    if (action === "auth-options") {
      const rawId = typeof payload?.id === "string" ? payload.id.trim() : "";
      // deno-lint-ignore no-explicit-any
      let allowCredentials: any[] | undefined = undefined;
      let challengeAccountId: string | null = null;

      if (rawId) {
        // Scoped ceremony: caller already typed an id, so only offer that
        // one account's credentials (also the only path that works for a
        // non-resident/non-discoverable authenticator, e.g. some hardware
        // security keys — see the discoverable branch below for why most
        // platform authenticators don't need this).
        const acc = await lookupAccountById(admin, rawId);
        if (!acc || acc.status !== "active") {
          // Same generic error whether the account doesn't exist or just has
          // no passkeys — avoids using this as an account-enumeration oracle.
          return json({ ok: false, error: "no_passkeys" }, 200);
        }
        const { data: creds, error: credsErr } = await admin
          .from("account_passkeys")
          .select("credential_id, transports")
          .eq("account_id", acc.id);
        if (credsErr) {
          logger.error("Failed to load passkeys for auth-options", credsErr);
          return json({ ok: false, error: "server_error" }, 500);
        }
        if (!creds || creds.length === 0) {
          return json({ ok: false, error: "no_passkeys" }, 200);
        }
        allowCredentials = creds.map((row) => {
          const transports = Array.isArray(row.transports) && row.transports.length > 0
            ? row.transports
            : undefined;
          return { id: row.credential_id as string, transports };
        });
        challengeAccountId = acc.id;
      }
      // else: fully discoverable ceremony — no id typed, no allowCredentials
      // sent, so the browser's native picker shows *every* passkey
      // registered for this site across every account (platform
      // authenticators create resident/discoverable credentials by default,
      // since registration already requests residentKey: "preferred"). The
      // account is resolved afterward in auth-verify from the credential's
      // own userHandle, not from anything the client claims here.

      purgeExpiredChallenges(admin);

      const options = await generateAuthenticationOptions({
        rpID: RP_ID,
        userVerification: "preferred",
        allowCredentials,
      });

      const { error: insErr } = await admin.from("webauthn_challenges").insert({
        account_id: challengeAccountId,
        challenge: options.challenge,
        ceremony_type: "authentication",
      });
      if (insErr) {
        logger.error("Failed to store authentication challenge", insErr);
        return json({ ok: false, error: "server_error" }, 500);
      }

      return json({ ok: true, options });
    }

    if (action === "auth-verify") {
      const credential = payload?.credential;
      if (!credential || typeof credential !== "object") {
        return json({ ok: false, error: "missing_credential" }, 400);
      }

      // Find the challenge by its own value rather than by account — this
      // is the one lookup that works identically for both the scoped and
      // the discoverable ceremony (in the discoverable case there was no
      // account to scope by yet), and it's more precise than "most recent
      // challenge for this account" ever was: challenges are single-use
      // random values, so an exact match is unambiguous.
      let clientChallenge: string;
      try {
        const clientDataJson = JSON.parse(
          new TextDecoder().decode(base64UrlToBytes(credential?.response?.clientDataJSON || ""))
        );
        clientChallenge = clientDataJson.challenge;
        if (typeof clientChallenge !== "string" || !clientChallenge) throw new Error("no challenge in clientDataJSON");
      } catch (err) {
        logger.warn("Could not decode clientDataJSON", { error: String(err) });
        return json({ ok: false, error: "verification_failed" }, 400);
      }

      const { data: challengeRows, error: chErr } = await admin
        .from("webauthn_challenges")
        .select("id, challenge, expires_at")
        .eq("challenge", clientChallenge)
        .eq("ceremony_type", "authentication")
        .limit(1);
      if (chErr) {
        logger.error("Failed to load authentication challenge", chErr);
        return json({ ok: false, error: "server_error" }, 500);
      }
      const challengeRow = challengeRows?.[0];
      if (!challengeRow || new Date(challengeRow.expires_at).getTime() < Date.now()) {
        return json({ ok: false, error: "challenge_expired" }, 400);
      }
      // Single-use, consumed before verifying regardless of outcome.
      await admin.from("webauthn_challenges").delete().eq("id", challengeRow.id);

      // Resolve the account from the credential's own userHandle — every
      // passkey is registered with userID set to the account id's raw
      // bytes (see register-options), so this works for the discoverable
      // ceremony without the client ever claiming an identity. Falls back
      // to the client-supplied id only for the rare non-resident
      // credential whose authenticator omitted userHandle.
      let targetId: string | null = null;
      const userHandle = credential?.response?.userHandle;
      if (typeof userHandle === "string" && userHandle) {
        try {
          targetId = new TextDecoder().decode(base64UrlToBytes(userHandle));
        } catch { /* fall through to client-supplied id */ }
      }
      if (!targetId) {
        targetId = typeof payload?.id === "string" ? payload.id.trim() : "";
      }

      const acc = await lookupAccountById(admin, targetId);
      if (!acc || acc.status !== "active") {
        return json({ ok: false, error: "invalid_credentials" }, 200);
      }
      if (acc.locked_until && new Date(acc.locked_until).getTime() > Date.now()) {
        logger.warn("Locked account attempted passkey sign-in", { id: acc.id });
        return json({ ok: false, error: "account_locked" }, 200);
      }

      const { data: pkRow, error: pkErr } = await admin
        .from("account_passkeys")
        .select("id, credential_id, public_key, sign_count, transports")
        .eq("account_id", acc.id)
        .eq("credential_id", credential.id)
        .maybeSingle();
      if (pkErr) {
        logger.error("Failed to load passkey for verification", pkErr);
        return json({ ok: false, error: "server_error" }, 500);
      }
      if (!pkRow) {
        return json({ ok: false, error: "invalid_credentials" }, 200);
      }

      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response: credential,
          expectedChallenge: challengeRow.challenge,
          expectedOrigin: ORIGIN,
          expectedRPID: RP_ID,
          authenticator: {
            credentialID: pkRow.credential_id,
            credentialPublicKey: base64UrlToBytes(pkRow.public_key),
            counter: pkRow.sign_count,
            transports: Array.isArray(pkRow.transports) && pkRow.transports.length > 0
              ? pkRow.transports
              : undefined,
          },
        });
      } catch (err) {
        logger.warn("Authentication verification threw", { error: String(err) });
        return json({ ok: false, error: "verification_failed" }, 400);
      }

      if (!verification.verified) {
        return json({ ok: false, error: "verification_failed" }, 400);
      }

      // newCounter guards against a cloned/replayed authenticator (the
      // library itself rejects the response if newCounter <= the stored
      // counter passed in above); persist it so the next login re-checks
      // against this one, not the original registration value.
      await admin
        .from("account_passkeys")
        .update({ sign_count: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
        .eq("id", pkRow.id);

      // A successful passkey sign-in proves account control just like a
      // correct password would — reset the same password-lockout state.
      await admin
        .from("accounts")
        .update({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
        .eq("id", acc.id);

      const anonForVerify = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const shadowResult = await establishShadowSession(admin, anonForVerify, acc.id, acc.role || "member", logger);
      if (!shadowResult.ok) {
        return json({ ok: false, error: shadowResult.error }, shadowResult.status);
      }

      logger.info("User signed in via passkey", { accountId: acc.id, role: acc.role });

      return json({
        ok: true,
        role: acc.role,
        id: acc.id,
        has_passkey: true,
        access_token: shadowResult.session.access_token,
        refresh_token: shadowResult.session.refresh_token,
        expires_at: shadowResult.session.expires_at,
      });
    }

    if (action === "backup-login") {
      const code = normalizeBackupCode(typeof payload?.code === "string" ? payload.code : "");
      if (!code || code.length !== 11) {
        return json({ ok: false, error: "invalid_code" }, 200);
      }

      const acc = await lookupAccountById(admin, payload?.id);
      if (!acc || acc.status !== "active") {
        return json({ ok: false, error: "invalid_credentials" }, 200);
      }
      if (acc.locked_until && new Date(acc.locked_until).getTime() > Date.now()) {
        logger.warn("Locked account attempted backup-code sign-in", { id: acc.id });
        return json({ ok: false, error: "account_locked" }, 200);
      }

      const codeHash = await sha256Hex(code);
      const { data: codeRow, error: codeErr } = await admin
        .from("account_backup_codes")
        .select("id")
        .eq("account_id", acc.id)
        .eq("code_hash", codeHash)
        .is("used_at", null)
        .maybeSingle();
      if (codeErr) {
        logger.error("Failed to look up backup code", codeErr);
        return json({ ok: false, error: "server_error" }, 500);
      }
      if (!codeRow) {
        return json({ ok: false, error: "invalid_code" }, 200);
      }

      // Single-use.
      await admin.from("account_backup_codes").update({ used_at: new Date().toISOString() }).eq("id", codeRow.id);
      await admin
        .from("accounts")
        .update({ failed_login_count: 0, locked_until: null, last_login_at: new Date().toISOString() })
        .eq("id", acc.id);

      const { count: remaining } = await admin
        .from("account_backup_codes")
        .select("id", { count: "exact", head: true })
        .eq("account_id", acc.id)
        .is("used_at", null);

      const anonForBackup = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
      const shadowResult = await establishShadowSession(admin, anonForBackup, acc.id, acc.role || "member", logger);
      if (!shadowResult.ok) {
        return json({ ok: false, error: shadowResult.error }, shadowResult.status);
      }

      logger.info("User signed in via backup code", { accountId: acc.id, role: acc.role, remaining });

      return json({
        ok: true,
        role: acc.role,
        id: acc.id,
        has_passkey: true,
        backup_codes_remaining: remaining ?? 0,
        access_token: shadowResult.session.access_token,
        refresh_token: shadowResult.session.refresh_token,
        expires_at: shadowResult.session.expires_at,
      });
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

      const { count: totalPasskeys } = await admin
        .from("account_passkeys")
        .select("id", { count: "exact", head: true })
        .eq("account_id", identity.accountId);

      // Backup codes are generated once, at the account's first passkey —
      // not re-issued for a 2nd/3rd device, since one shared set covers the
      // whole account. Registration still succeeds even if this fails; the
      // user can get a set afterward via regenerate-backup-codes.
      let backupCodes: string[] | undefined;
      if (totalPasskeys === 1) {
        try {
          backupCodes = await issueBackupCodes(admin, identity.accountId);
        } catch (err) {
          logger.error("Failed to issue backup codes after first passkey enrollment", err);
        }
      }

      logger.info("Passkey registered", {
        accountId: identity.accountId,
        passkeyId: inserted.id,
        firstPasskey: totalPasskeys === 1,
      });
      return json({ ok: true, passkey: inserted, backupCodes });
    }

    if (action === "list") {
      const { data: passkeys, error: pkErr } = await admin
        .from("account_passkeys")
        .select("id, device_label, created_at, last_used_at, transports")
        .eq("account_id", identity.accountId)
        .order("created_at", { ascending: true });
      if (pkErr) {
        logger.error("Failed to list passkeys", pkErr);
        return json({ ok: false, error: "server_error" }, 500);
      }

      const { count: backupCodesRemaining } = await admin
        .from("account_backup_codes")
        .select("id", { count: "exact", head: true })
        .eq("account_id", identity.accountId)
        .is("used_at", null);

      return json({ ok: true, passkeys: passkeys || [], backupCodesRemaining: backupCodesRemaining ?? 0 });
    }

    if (action === "rename") {
      const id = typeof payload?.id === "string" ? payload.id : "";
      const rawLabel = typeof payload?.device_label === "string" ? payload.device_label.trim() : "";
      if (!id || !rawLabel) return json({ ok: false, error: "missing_fields" }, 400);
      const deviceLabel = rawLabel.slice(0, 100);

      const { data: updated, error: updErr } = await admin
        .from("account_passkeys")
        .update({ device_label: deviceLabel })
        .eq("id", id)
        .eq("account_id", identity.accountId)
        .select("id, device_label")
        .maybeSingle();
      if (updErr) {
        logger.error("Failed to rename passkey", updErr);
        return json({ ok: false, error: "server_error" }, 500);
      }
      if (!updated) return json({ ok: false, error: "not_found" }, 404);

      return json({ ok: true, passkey: updated });
    }

    if (action === "remove") {
      const id = typeof payload?.id === "string" ? payload.id : "";
      if (!id) return json({ ok: false, error: "missing_fields" }, 400);

      const { data: deleted, error: delErr } = await admin
        .from("account_passkeys")
        .delete()
        .eq("id", id)
        .eq("account_id", identity.accountId)
        .select("id")
        .maybeSingle();
      if (delErr) {
        logger.error("Failed to remove passkey", delErr);
        return json({ ok: false, error: "server_error" }, 500);
      }
      if (!deleted) return json({ ok: false, error: "not_found" }, 404);

      logger.info("Passkey removed", { accountId: identity.accountId, passkeyId: id });
      return json({ ok: true });
    }

    if (action === "regenerate-backup-codes") {
      try {
        const codes = await issueBackupCodes(admin, identity.accountId);
        logger.info("Backup codes regenerated", { accountId: identity.accountId });
        return json({ ok: true, backupCodes: codes });
      } catch (err) {
        logger.error("Failed to regenerate backup codes", err);
        return json({ ok: false, error: "server_error" }, 500);
      }
    }

    // Admin escape hatch for a fully-locked-out account (lost every device
    // and the backup codes): revokes every passkey/backup code so the
    // account falls back to password-only, exactly the same authorization
    // bar as admin-accounts' reset-password (same canManageAccount matrix:
    // a guild_admin can only reach accounts in their own guild, a
    // server_admin only their own server, super_admin can reach anyone —
    // never the other way up the hierarchy).
    if (action === "admin-reset-passkeys") {
      const targetId = typeof payload?.id === "string" ? payload.id.trim() : "";
      if (!targetId) return json({ ok: false, error: "missing_fields" }, 400);

      const { data: targetAcc } = await admin
        .from("accounts")
        .select("id, role, guild, server_number")
        .ilike("id", targetId)
        .maybeSingle();
      if (!targetAcc) return json({ ok: false, error: "not_found" }, 404);

      const { data: callerAcc } = await admin
        .from("accounts")
        .select("server_number")
        .eq("id", identity.accountId)
        .maybeSingle();
      let callerServerNumber = callerAcc?.server_number ?? null;
      if (!callerServerNumber && identity.guild) {
        const { data: g } = await admin.from("guilds").select("server_number").eq("id", identity.guild).maybeSingle();
        if (g?.server_number) callerServerNumber = g.server_number;
      }

      let targetServerNumber = targetAcc.server_number ?? null;
      if (!targetServerNumber && targetAcc.guild) {
        const { data: g } = await admin.from("guilds").select("server_number").eq("id", targetAcc.guild).maybeSingle();
        if (g?.server_number) targetServerNumber = g.server_number;
      }

      const callerCtx = { role: identity.role as Role, guild: identity.guild, serverNumber: callerServerNumber };
      const targetCtx = { role: (targetAcc.role || "member") as Role, guild: targetAcc.guild, serverNumber: targetServerNumber };

      if (!canManageAccount(callerCtx, targetCtx)) {
        logger.warn("Forbidden attempt to reset target account passkeys", {
          callerId: identity.accountId,
          callerRole: identity.role,
          targetId: targetAcc.id,
        });
        return json({ ok: false, error: "forbidden" }, 403);
      }

      const [pkRes, bcRes, chRes] = await Promise.all([
        admin.from("account_passkeys").delete().eq("account_id", targetAcc.id),
        admin.from("account_backup_codes").delete().eq("account_id", targetAcc.id),
        admin.from("webauthn_challenges").delete().eq("account_id", targetAcc.id),
      ]);
      const failure = pkRes.error || bcRes.error || chRes.error;
      if (failure) {
        logger.error("Failed to reset target account passkeys", failure, { targetId: targetAcc.id });
        return json({ ok: false, error: "server_error" }, 500);
      }

      logger.info("Admin reset target account passkeys", { callerId: identity.accountId, targetId: targetAcc.id });
      return json({ ok: true });
    }

    return json({ ok: false, error: "unknown_action" }, 400);
  } catch (err) {
    logger.error("Unhandled error in auth-passkey", err);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
