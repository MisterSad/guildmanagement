// One Discord identity, several accounts, and a chooser at sign-in.
//
// Reported live: signing in with Discord as the platform owner landed on the
// Player Portal. Nothing was broken -- the Discord identity was linked to a
// `member` account, so a member session was minted and the routing was correct.
// The gap was that `discord_account_links` had `discord_user_id` as its primary
// key, so one person who is both an administrator and a player could attach
// only one of their accounts.
//
// The owner chose to relax that key, knowing the cost. What this file pins is
// the half that must NOT be relaxed with it, plus the one function the key
// change silently breaks.

import { describe, it, expect } from 'vitest';
import { squash } from './helpers/source-text.js';
import fs from 'node:fs';
import path from 'node:path';
import { edgeSource, edgeFunctionBody } from './helpers/edge-source.js';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const stripSql = (s) => s.replace(/^\s*--.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260927001726_discord_multi_account_links.sql';
const migration = stripSql(read(MIGRATION));
const fn = edgeSource('auth-discord');
const session = read('src/core/auth/session.ts');
const ctrl = read('src/modules/app/auth/auth.controller.ts');

describe('the schema allows several accounts per identity, and no more than that', () => {
  it('keys on the PAIR, not on the Discord id alone', () => {
    expect(migration).toMatch(/PRIMARY KEY \(discord_user_id, account_id\)/);
  });

  it('keeps an account bound to exactly one Discord identity', () => {
    // The half of the old bijection that must survive: without it, two people
    // could both sign in as the same administrator.
    expect(migration).toMatch(/UNIQUE \(account_id\)/);
  });

  it('indexes the lookup that now runs on every Discord sign-in', () => {
    expect(migration).toMatch(/CREATE INDEX IF NOT EXISTS idx_discord_account_links_discord_user_id/);
  });

  it('asserts the onboarding guards survived, rather than assuming they did', () => {
    // "One guild per Discord account" used to be implied by the primary key.
    // It is really enforced by an explicit `discord_already_linked` check in
    // four functions -- so the migration verifies all four still have it.
    expect(migration).toMatch(/discord_already_linked/);
    expect(migration).toMatch(/one guild per Discord account is no longer guaranteed/);
  });
});

describe('the one function the key change would have broken', () => {
  it('rewrites gm_redeem_relink_code without ON CONFLICT (discord_user_id)', () => {
    // That clause names a column that is no longer a unique constraint, so it
    // raises at runtime. Relinking would have started failing silently for
    // everyone, and nothing else in the change would have hinted at it.
    expect(migration).toMatch(/CREATE OR REPLACE FUNCTION public\.gm_redeem_relink_code/);
    // Sliced to the FUNCTION BODY. The migration's own assertion block checks
    // for that clause by name, so a search over the whole file matches the
    // guard and reports the defect it exists to prevent. This test did exactly
    // that on its first run.
    const start = migration.indexOf('CREATE OR REPLACE FUNCTION public.gm_redeem_relink_code');
    const body = migration.slice(start, migration.indexOf('$$;', start));
    expect(body.length, 'the function body did not parse: the check would be vacuous').toBeGreaterThan(400);
    expect(body).not.toMatch(/ON CONFLICT/);
    expect(body).toMatch(/INSERT INTO public\.discord_account_links/);
    // And the guard against it coming back is still there.
    expect(migration).toMatch(/still uses ON CONFLICT \(discord_user_id\), which now raises/);
  });

  it('still detaches the account from any previous identity first', () => {
    expect(migration).toMatch(/DELETE FROM public\.discord_account_links l WHERE l\.account_id = v_acc\.id/);
  });

  it('still bumps session_version, so older sessions stop being honoured', () => {
    expect(migration).toMatch(/session_version = COALESCE\(session_version, 0\) \+ 1/);
  });
});

describe('the Edge Function resolves several links without erroring', () => {
  it('no longer calls maybeSingle() on the link lookup', () => {
    // `.maybeSingle()` ERRORS on more than one row -- it does not pick one. Left
    // in place, every multi-account sign-in would have failed outright.
    const redeem = edgeFunctionBody('auth-discord', 'handleRedeem');
    const lookup = redeem.slice(redeem.indexOf('discord_account_links'), redeem.indexOf('discord_account_links') + 300);
    expect(lookup).not.toMatch(/maybeSingle/);
    expect(lookup).toMatch(/\.eq\("discord_user_id", discordUserId\)/);
  });

  it('answers `choose` with a continuation ticket when there is more than one', () => {
    expect(fn).toMatch(/state: "choose"/);
    expect(fn).toMatch(/accounts: choices\.map/);
    expect(fn).toMatch(/issueTicket\(admin, identity, logger\)/);
  });

  it('offers only ACTIVE accounts, and signs straight in when only one is', () => {
    expect(fn).toMatch(/\.filter\(\(a: any\) => a\.status === "active"\)/);
    expect(fn).toMatch(/if \(choices\.length === 1\)/);
  });
});

describe('choosing an account is not an oracle', () => {
  const choose = fn.slice(fn.indexOf('async function handleChoose'));

  it('spends a ticket rather than trusting the caller', () => {
    expect(choose).toMatch(/consumeTicket\(admin, parsed\.data\.ticket/);
  });

  it('verifies the chosen id against THAT identity\'s links', () => {
    // Without this the endpoint would mint a session for any account id you
    // name -- a complete authentication bypass.
    expect(choose).toMatch(/\.eq\("discord_user_id", consumed\.discordUserId\)/);
    expect(choose).toMatch(/\.eq\("account_id", parsed\.data\.account_id\)/);
    expect(choose).toMatch(/account_not_linked/);
  });

  it('re-checks status at selection time, not only at listing time', () => {
    // An account can be suspended between being listed and being picked.
    const mint = fn.slice(fn.indexOf('async function mintForAccount'));
    expect(mint).toMatch(/acc\.status !== "active"/);
    expect(mint).toMatch(/pending_approval/);
  });

  it('is rate limited like every other ticket-spending action', () => {
    expect(choose).toMatch(/throttled\(req, admin, logger, "choose"\)/);
  });

  it('is registered in the action router', () => {
    expect(fn).toMatch(/case "choose":\s+return handleChoose/);
  });
});

describe('the client asks instead of guessing', () => {
  it('surfaces the choose state from the redeem response', () => {
    expect(session).toMatch(/data\.state === 'choose'/);
    expect(session).toMatch(/accounts: Array\.isArray\(data\.accounts\)/);
  });

  it('exposes chooseDiscordAccount, and the auth controller imports it', () => {
    // M4c: the GM bridge is deleted; the controller reaches it by typed import.
    expect(session).toMatch(/export async function chooseDiscordAccount/);
    expect(ctrl).toMatch(/import \{[^}]*\bchooseDiscordAccount\b[^}]*\} from '[^']*core\/auth\/session'/);
  });

  it('opens the chooser rather than picking the first account', () => {
    expect(ctrl).toMatch(/resp\.state === 'choose'/);
    expect(ctrl).toMatch(/openAccountChooser\(resp\.ticket/);
  });

  it('says where each account leads, so the choice is not a guess', () => {
    expect(ctrl).toMatch(/Command Center, every guild/);
    expect(ctrl).toMatch(/Player Portal/);
  });

  it('makes the dialog VISIBLE, which it did not', () => {
    // The bug the owner hit. `.gm-modal-overlay` is `opacity: 0` and only shows
    // with the `visible` class, so the chooser was in the DOM, fully wired, and
    // completely invisible: Discord sign-in looked broken and the continuation
    // ticket expired two minutes later. Nothing in the suite could see it,
    // because every assertion was about markup being present.
    const dlg = ctrl.slice(ctrl.indexOf('export function openAccountChooser'));
    const body = dlg.slice(0, dlg.indexOf('export function openLinkAccountDialog'));
    expect(body).toMatch(/classList\.add\('visible'\)/);
    expect(body).toMatch(/requestAnimationFrame/);
  });

  it('can be dismissed, so it is not a trap', () => {
    const dlg = ctrl.slice(ctrl.indexOf('export function openAccountChooser'));
    const body = dlg.slice(0, dlg.indexOf('export function openLinkAccountDialog'));
    expect(body).toMatch(/discord-choose-cancel/);
  });

  it('disables the buttons on the first click, because the ticket is single-use', () => {
    const dlg = ctrl.slice(ctrl.indexOf('export function openAccountChooser'));
    expect(dlg).toMatch(/disabled = true/);
  });

  it('gives a continuation ticket a human-scale lifetime', () => {
    // The callback ticket is spent by the SPA in under a second, so two minutes
    // is right for it. A continuation waits on a PERSON reading two options, or
    // typing a password into the claim form, and two minutes expired under the
    // owner mid-decision.
    const fnSrc = edgeSource('auth-discord');
    expect(fnSrc).toMatch(/const CONTINUATION_TTL_MS = 15 \* 60_000;/);
    expect(squash(fnSrc)).toMatch(/issueTicket\(\s*admin, \{ discordUserId, discordUsername, displayName, attempts: 0 \}, logger, TICKET_TTL_MS,?\s*\)/);
  });

  it('escapes every value it renders', () => {
    const dlg = ctrl.slice(ctrl.indexOf('export function openAccountChooser'), ctrl.indexOf('export function openLinkAccountDialog'));
    // Account ids and guild tags are constrained, but they still reach innerHTML.
    expect(dlg).toMatch(/escapeDialogText\(a\.id\)/);
    expect(dlg).toMatch(/escapeDialogText\(a\.guild\)/);
    expect(dlg).toMatch(/escapeDialogText\(discordUsername\)/);
  });
});

describe('a fresh sign-in lands on Overview, with its data loaded', () => {
  // Reported live: after a Discord sign-in the app opened on Accounts & Access,
  // and that tab was EMPTY until you switched away and back.
  //
  // One cause for both symptoms. `handleDiscordCallback()` resolves true, so
  // the boot path returns BEFORE it reaches `restoreSavedTab()`, and nothing
  // else activated a tab. The page showed whichever panel carried `active` in
  // the static markup, and because no tab activation had occurred,
  // `triggerTabDataLoad` never ran for it. Switching tabs ran the loader, which
  // is why coming back looked like it fixed itself.
  it('activates a tab explicitly after a successful login', () => {
    const tail = ctrl.slice(ctrl.indexOf('export async function handleSuccessfulLogin'));
    const body = tail.slice(0, tail.indexOf('\n// ── Logout'));
    expect(body.length, 'handleSuccessfulLogin not found').toBeGreaterThan(400);
    expect(body).toMatch(/shellView\.gotoItem\('overview'\)/);
  });

  it('does it AFTER the dashboard is revealed, or the panel does not exist yet', () => {
    const tail = ctrl.slice(ctrl.indexOf('export async function handleSuccessfulLogin'));
    const body = tail.slice(0, tail.indexOf('\n// ── Logout'));
    expect(body.indexOf('revealAdmin(role)')).toBeLessThan(body.indexOf("gotoItem('overview')"));
  });

  it('still restores the last tab on a session restore, which is different', () => {
    // A reload should come back where you were. Only a fresh sign-in resets to
    // Overview, so restoreSavedTab must survive.
    expect(read('src/modules/app/router.ts')).toMatch(/export function restoreSavedTab/);
    expect(read('src/main.ts')).toMatch(/restoreSavedTab\(\)/);
  });
});
