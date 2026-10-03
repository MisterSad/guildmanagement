// Phase D4: self-serve onboarding, and the empty-guild expiry that pays for it.
//
// Self-serve creation is the feature that makes abandoned tenants accumulate,
// which is why the expiry ships with it. The expiry deletes production data on
// a schedule, so most of what is asserted below is about what it must NOT do.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { edgeSource } from './helpers/edge-source.js';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const migration = read('supabase/migrations/20260926182332_discord_onboarding.sql');
const discordFn = stripComments(edgeSource('auth-discord'));
const fnBody = (name, next) => migration.slice(
  migration.indexOf(`FUNCTION public.${name}`),
  next ? migration.indexOf(`FUNCTION public.${next}`) : undefined
);
const joinFn = fnBody('gm_discord_join_guild', 'gm_discord_create_guild');
const createFn = fnBody('gm_discord_create_guild', 'gm_expire_empty_guilds');
const expireFn = migration.slice(
  migration.indexOf('FUNCTION public.gm_expire_empty_guilds'),
  migration.indexOf('REVOKE ALL ON FUNCTION public.gm_snowflake_created_at')
);

describe('guardrails are enforced in SQL, not in the Edge Function', () => {
  it('recomputes the Discord account age from the snowflake', () => {
    // A value the Edge Function computed is a value a stale deploy could get
    // wrong; the RPC is the authority.
    expect(createFn).toContain('public.gm_snowflake_created_at(p_discord_user_id)');
    expect(createFn).toMatch(/v_min_age_days CONSTANT integer := 30/);
    expect(createFn).toContain('discord_account_too_new');
    const handler = discordFn.slice(discordFn.indexOf('async function handleOnboard'));
    expect(handler, 'the age check must not live here').not.toContain('snowflake');
  });

  it('returns NULL for an implausible snowflake rather than epoch zero', () => {
    // Epoch zero would be ~11 years old and would sail through any age check.
    const snow = fnBody('gm_snowflake_created_at', 'gm_discord_join_guild');
    expect(snow).toContain("p_snowflake !~ '^[0-9]{17,20}$'");
    expect(snow).toMatch(/RETURN NULL/);
    expect(createFn).toContain('v_created IS NULL OR');
  });

  it('caps guild creation per day', () => {
    expect(createFn).toMatch(/v_max_per_day\s+CONSTANT integer := 10/);
    expect(createFn).toContain('daily_limit_reached');
  });

  it('reuses the tag and server shapes the reviewed path already enforces', () => {
    expect(createFn).toContain("v_tag !~ '^[A-Z0-9_]{2,12}$'");
    expect(createFn).toContain("v_server !~ '^[0-9]{4}$'");
  });
});

describe('neither onboarding path creates a password', () => {
  it('writes no password column at all', () => {
    for (const [name, body] of [['join', joinFn], ['create', createFn]]) {
      expect(body, `${name} must not write a password`).not.toMatch(/password_hash|password_enc/);
    }
  });

  it('generates the account id inside the transaction', () => {
    expect(joinFn).toContain('public.gm_generate_account_id(p_discord_username)');
    expect(createFn).toContain('public.gm_generate_account_id(p_discord_username)');
  });
});

describe('joining a guild keeps the approval step', () => {
  it('lands in pending, like password self-registration always has', () => {
    // The join code is a shared secret and the UID check only proves the UID
    // is on the roster and unclaimed -- not that it belongs to the person
    // typing. Discord does not change that calculus.
    expect(joinFn).toContain("'pending'");
    expect(joinFn).toContain('uid_not_in_guild');
    expect(joinFn).toContain('uid_already_claimed');
  });

  it('uses the same join-code hash shape as gm_register_player', () => {
    // One join code has to work for both paths while both exist.
    expect(joinFn).toContain("encode(extensions.digest(upper(trim(p_join_code)), 'sha256'), 'hex')");
  });

  it('reports pending instead of minting a session that would be refused', () => {
    const handler = discordFn.slice(discordFn.indexOf('async function handleOnboard'));
    const pendingAt = handler.indexOf('state: "pending_approval"');
    const shadowAt = handler.indexOf('establishShadowSession');
    expect(pendingAt).toBeGreaterThan(-1);
    expect(pendingAt, 'the pending branch must return before any session is minted').toBeLessThan(shadowAt);
  });
});

describe('the expiry deletes production data, so what it refuses matters most', () => {
  it('never deletes a guild created before the policy existed', () => {
    // Three guilds were already memberless when this shipped. A retention
    // rule must not reach back and destroy tenants created before it.
    expect(expireFn).toContain('v_policy_start CONSTANT timestamptz');
    expect(expireFn).toContain('gu.created_at >= v_policy_start');
  });

  it('never deletes DEMO', () => {
    expect(expireFn).toMatch(/v_protected\s+CONSTANT text\[\] := ARRAY\['DEMO'\]/);
    expect(expireFn).toContain('NOT (gu.id = ANY (v_protected))');
  });

  it('never deletes a super_admin along with a tenant', () => {
    expect(expireFn).toContain("a.role IS NULL OR a.role <> 'super_admin'");
  });

  it('never deletes a guild that has members or any event history', () => {
    expect(expireFn).toContain('NOT EXISTS (SELECT 1 FROM public.guild_members m WHERE m.guild = gu.id)');
    expect(expireFn).toContain('NOT EXISTS (SELECT 1 FROM public.event_participants ep WHERE ep.guild = gu.id)');
  });

  it('warns before it destroys, and withdraws the warning if the guild revives', () => {
    // `empty_since` is the visible notice; clearing it is what makes a guild
    // that gained a member safe again without anyone intervening.
    expect(expireFn).toMatch(/SET empty_since = NULL/);
    expect(expireFn).toMatch(/SET empty_since = now\(\)/);
    expect(expireFn).toMatch(/v_mark_after\s+CONSTANT integer := 14/);
    expect(expireFn).toMatch(/v_grace\s+CONSTANT integer := 14/);
  });

  it('deletes accounts BEFORE the guild', () => {
    // Not to avoid an exception -- public.accounts has no foreign key at all,
    // and a naive delete was proven to SUCCEED against production in a
    // rolled-back transaction. The hazard is silence: accounts left pointing
    // at a guild that no longer exists.
    const accAt = expireFn.indexOf('DELETE FROM public.accounts');
    const guildAt = expireFn.indexOf('DELETE FROM public.guilds            gu WHERE gu.id = g.id');
    expect(accAt).toBeGreaterThan(-1);
    expect(guildAt).toBeGreaterThan(accAt);
  });

  it('mirrors the deletion set gm_delete_guild already uses', () => {
    // A guild removed by the cron and one removed from the admin screen must
    // leave the database in the same state.
    for (const t of ['event_status', 'shadowfront_squads', 'guild_transfers', 'guild_config', 'guild_members', 'accounts']) {
      expect(expireFn, `${t} must be cleaned up`).toContain(`DELETE FROM public.${t}`);
    }
  });

  it('records every deletion in the audit ledger', () => {
    expect(expireFn).toContain("'guild_expired'");
    expect(expireFn).toContain('INSERT INTO public.system_audit_logs');
  });

  it('runs after the DEMO reset, not alongside it', () => {
    // The repo file wraps the arguments; assert on the pair, not the layout.
    expect(migration).toMatch(/'daily-expire-empty-guilds',\s*\n?\s*'30 3 \* \* \*'/);
  });
});

describe('the onboarding action', () => {
  const handler = discordFn.slice(discordFn.indexOf('async function handleOnboard'));

  it('discriminates on mode so fields cannot cross branches', () => {
    expect(discordFn).toContain('z.discriminatedUnion("mode"');
    expect(discordFn).toMatch(/uid: z\.string\(\)\.trim\(\)\.regex\(\/\^\[0-9\]\{1,20\}\$\//);
    expect(discordFn).toMatch(/server_number: z\.string\(\)\.trim\(\)\.regex\(\/\^\[0-9\]\{4\}\$\//);
  });

  it('spends the continuation ticket, like every other path', () => {
    expect(handler).toContain('consumeTicket(admin, parsed.data.ticket, logger)');
    expect(handler).toContain('throttled(req, admin, logger, "onboard")');
  });

  it('is reachable from the dialog', () => {
    const ctrl = read('src/modules/app/auth/auth.controller.ts');
    expect(ctrl).toContain("onboardWithDiscord(ticket, 'join'");
    expect(ctrl).toContain("onboardWithDiscord(ticket, 'create'");
    expect(ctrl).toContain('Join a guild');
    expect(ctrl).toContain('Create a guild');
  });

  it('explains a pending join rather than dropping the person on a blank screen', () => {
    const ctrl = read('src/modules/app/auth/auth.controller.ts');
    expect(ctrl).toContain("resp.state === 'pending_approval'");
    // A screen of its own since 2026-10-02, not a line in an error box.
    expect(ctrl).toContain('showPendingScreen(resp.guild || null, resp.id || null)');
    const html = read('index.html');
    expect(html).toContain('id="login-pending"');
    expect(html).toContain('Waiting for approval');
  });
});

describe('least privilege', () => {
  it('keeps every new function off anon and authenticated', () => {
    const esc = (x) => x.replace(/[.()]/g, '\\$&');
    for (const f of [
      'gm_snowflake_created_at(text)',
      'gm_discord_join_guild(text, text, text, text)',
      'gm_discord_create_guild(text, text, text, text)',
      'gm_expire_empty_guilds()',
    ]) {
      expect(migration).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${esc(f)}\\s+FROM PUBLIC, anon, authenticated;`));
      expect(migration).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${esc(f)}\\s+TO service_role;`));
    }
  });

  it('reloads the PostgREST schema cache', () => {
    expect(migration.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});
