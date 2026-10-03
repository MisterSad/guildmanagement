// Phase D2: the wiring of Discord sign-in that unit tests cannot reach.
//
// The pure computations live in tests/discord_oauth.test.js. What is asserted
// here is the contract between the pieces -- the properties that, if they
// silently drifted, would turn a working sign-in into a security hole rather
// than a visible failure.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const fn = read('supabase/functions/auth-discord/index.ts');
const fnCode = stripComments(fn);
const migration = read('supabase/migrations/20260926173028_discord_oauth_state.sql');

describe('auth-discord is reachable without a session', () => {
  it('is declared verify_jwt = false, like every other pre-session endpoint', () => {
    const config = read('supabase/config.toml');
    const block = config.slice(config.indexOf('[functions.auth-discord]'));
    expect(block.slice(0, 120)).toMatch(/verify_jwt\s*=\s*false/);
  });

  it('is deployed: the CI deploy enumerates every function directory', () => {
    expect(read('supabase/functions/auth-discord/index.ts').length).toBeGreaterThan(0);
    expect(read('scripts/deploy-edge-functions.sh')).toContain('find "${FUNCTIONS_DIR}" -mindepth 1 -maxdepth 1 -type d');
  });

  it('fails closed when the OAuth secrets are missing', () => {
    // Never redirect anywhere while we cannot trust our own configuration.
    expect(fnCode).toContain('not_configured');
    const guard = fnCode.slice(fnCode.indexOf('if (!configured())'), fnCode.indexOf('const admin ='));
    expect(guard).toContain('503');
    expect(guard).not.toContain('redirect(');
  });
});

describe('the code exchange cannot be replayed or hijacked', () => {
  it('consumes the state through the atomic RPC, never a select-then-delete', () => {
    expect(fnCode).toContain("rpc(\"gm_consume_discord_oauth_state\"");
    // A read followed by a delete would race; DELETE ... RETURNING cannot.
    expect(migration).toMatch(/DELETE FROM public\.discord_oauth_states[\s\S]{0,200}RETURNING/);
    expect(fnCode).not.toMatch(/from\("discord_oauth_states"\)[\s\S]{0,80}\.select\(/);
  });

  it('consumes the ticket the same way', () => {
    expect(fnCode).toContain("rpc(\"gm_consume_discord_auth_ticket\"");
    expect(migration).toMatch(/DELETE FROM public\.discord_auth_tickets[\s\S]{0,200}RETURNING/);
  });

  it('sends the PKCE verifier only to Discord, and only from the stored row', () => {
    expect(fnCode).toContain('code_verifier: stateRow.code_verifier');
    // The verifier must never ride in the authorize URL, which is what the
    // browser sees -- only its S256 challenge may.
    const shared = stripComments(read('supabase/functions/_shared/discord-oauth.ts'));
    const authorize = shared.slice(shared.indexOf('export function buildAuthorizeUrl'));
    expect(authorize).toContain('code_challenge_method: "S256"');
    expect(authorize).not.toContain('code_verifier');
  });

  it('holds no Discord token at rest', () => {
    // The access token is revoked on every exit path out of the identity read.
    expect(fnCode).toContain('DISCORD_REVOKE_URL');
    expect(fnCode).toMatch(/finally\s*{[\s\S]*DISCORD_REVOKE_URL/);
    // And no column anywhere stores one.
    expect(migration).not.toMatch(/access_token|refresh_token/);
  });
});

describe('the callback cannot become an open redirect', () => {
  it('trusts the origin stored at /start, never one supplied to the callback', () => {
    const cb = fnCode.slice(fnCode.indexOf('async function handleCallback'), fnCode.indexOf('async function handleRedeem'));
    expect(cb).toContain('isAllowedOrigin(stateRow.origin)');
    // The callback must not read an origin out of its own query string.
    expect(cb).not.toMatch(/searchParams\.get\("origin"\)/);
  });

  it('validates the origin at /start before it is ever persisted', () => {
    const start = fnCode.slice(fnCode.indexOf('async function handleStart'), fnCode.indexOf('async function handleCallback'));
    expect(start).toContain('resolveOrigin(');
    expect(fnCode).toMatch(/function resolveOrigin[\s\S]{0,200}isAllowedOrigin\(raw\)/);
  });
});

describe('the ticket is not a bearer token', () => {
  it('carries no session, only a Discord identity', () => {
    const create = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS public.discord_auth_tickets'));
    const columns = create.slice(0, create.indexOf(');'));
    expect(columns).toContain('discord_user_id');
    for (const forbidden of ['access_token', 'refresh_token', 'role', 'account_id']) {
      expect(columns, `a ticket must not carry ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('is short-lived, and shorter than the state it follows', () => {
    const stateTtl = Number(/STATE_TTL_MS = (\d+)/.exec(fnCode.replace(/\s*\*\s*/g, '*'))?.[1] ?? NaN);
    expect(fnCode).toMatch(/STATE_TTL_MS\s*=\s*10 \* 60_000/);
    expect(fnCode).toMatch(/TICKET_TTL_MS\s*=\s*2 \* 60_000/);
    expect(Number.isNaN(stateTtl) || stateTtl > 0).toBe(true);
  });
});

describe('the redeem path enforces account state', () => {
  it('refuses a non-active account rather than merely reporting its status', () => {
    // Finding M14: `_shared/auth.ts` returned `status` and only one of seven
    // functions actually enforced it.
    const redeem = fnCode.slice(fnCode.indexOf('async function handleRedeem'));
    expect(redeem).toContain('acc.status !== "active"');
    expect(redeem).toContain('pending_approval');
  });

  it('mints the session through establishShadowSession, not by hand', () => {
    expect(fnCode).toContain('establishShadowSession(admin, anon, accountId, acc.role, logger)');
  });

  it('reports an unlinked Discord account as a state, not an error', () => {
    // D3 (claim) and D4 (onboarding) hang off this exact branch.
    expect(fnCode).toContain('state: "unlinked"');
  });
});

describe('deny-all and least privilege on the new objects', () => {
  it('enables and forces RLS with no policy at all', () => {
    for (const t of ['discord_oauth_states', 'discord_auth_tickets']) {
      expect(migration).toContain(`ALTER TABLE public.${t}  ENABLE ROW LEVEL SECURITY;`);
      expect(migration).toContain(`ALTER TABLE public.${t}  FORCE  ROW LEVEL SECURITY;`);
      expect(migration).toContain(`COMMENT ON TABLE public.${t}`);
    }
    expect(migration).not.toMatch(/CREATE POLICY/);
  });

  it('revokes the new functions from PUBLIC, anon and authenticated', () => {
    // Finding M15: a bare grant to PUBLIC is what made a maintenance function
    // callable by anyone holding the publishable key.
    const esc = (x) => x.replace(/[.()]/g, '\\$&');
    for (const f of ['gm_consume_discord_oauth_state(text)', 'gm_consume_discord_auth_ticket(text)', 'gm_purge_discord_ephemera()']) {
      expect(migration, `${f} must be revoked`)
        .toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(f)}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration, `${f} must be granted to service_role`)
        .toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(f)}\\s+TO service_role;`));
    }
  });

  it('schedules the purge that discord_link_codes never had', () => {
    expect(migration).toContain('hourly-discord-ephemera-purge');
    expect(migration).toContain('DELETE FROM public.discord_link_codes WHERE expires_at <= now();');
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('client wiring', () => {
  const session = stripComments(read('src/core/auth/session.ts'));
  const controller = stripComments(read('src/modules/app/auth/auth.controller.ts'));
  const main = stripComments(read('src/main.ts'));

  it('navigates the whole page rather than opening a popup', () => {
    // vercel.json sets Cross-Origin-Opener-Policy: same-origin, which severs
    // window.opener -- a popup + postMessage handshake would never fire.
    const start = session.slice(session.indexOf('export function loginWithDiscord'));
    expect(start).toContain('window.location.assign');
    expect(start).not.toContain('window.open');
    expect(read('vercel.json')).toContain('same-origin');
  });

  it('runs the callback BEFORE restoreSession', () => {
    const at = main.indexOf('handleDiscordCallback()');
    const restore = main.indexOf('restoreSession().then');
    expect(at).toBeGreaterThan(-1);
    expect(restore).toBeGreaterThan(-1);
    expect(at, 'the ticket must be spent before the ordinary restore').toBeLessThan(restore);
  });

  it('strips the ticket from the URL before redeeming it', () => {
    const h = controller.slice(controller.indexOf('export async function handleDiscordCallback'));
    const strip = h.indexOf('replaceState');
    const redeem = h.indexOf('redeemDiscordTicket(ticket)');
    expect(strip).toBeGreaterThan(-1);
    expect(redeem).toBeGreaterThan(-1);
    expect(strip, 'strip first, act second').toBeLessThan(redeem);
  });

  it('installs every minted session through one helper', () => {
    // Backup code and Discord converge on applySessionResponse, so they cannot
    // drift apart (the M11 lesson on duplicated boundaries). Passkeys are gone.
    expect(session).toContain('export async function applySessionResponse');
    expect(session).not.toMatch(/Passkey/);
    expect(session).toMatch(/return applySessionResponse\(data, \{ state: 'session' \}\)/);
  });

  it('exposes the button and its label', () => {
    expect(read('index.html')).toContain('id="login-discord-btn"');
    expect(controller).toContain("wireOnce(el('login-discord-btn')");
    expect(read('src/core/i18n/i18n.dictionary.ts')).toContain('login_btn_discord');
  });
});
