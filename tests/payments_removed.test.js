// Phase 1: the payment surface is gone, permanently.
//
// The owner's decision is that the platform is free with no subscription and no
// donation path. That makes every assertion here a *product* invariant, not a
// refactor detail: if any of these fails, a money-taking surface has come back.
//
// Two findings shaped this phase and are pinned below:
//
//  1. The roadmap proposed deleting `subscriptions.controller.ts` outright. That
//     would have destroyed two live features, because the tab was mis-named:
//     it is the only place a guild's `server_number` is assigned (cross-server
//     transfers depend on it) and the only caller of `gm_delete_guild`. The file
//     was renamed to `guilds.controller.ts` and stripped, not deleted.
//
//  2. `gm_reset_demo_tenant_data` wrote three of the dropped `guilds` columns.
//     Dropping them without repairing it would have broken the nightly 03:00
//     DEMO cron silently -- the exact failure the Web Push removal already hit
//     once (20260926120100 / 20260926120200).

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(rootDir, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(rootDir, p));
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** For `#`-commented files: shell scripts and TOML. */
const stripHashComments = (s) => s.replace(/^\s*#.*$/gm, '');

const MIGRATION = 'supabase/migrations/20260926180000_drop_payments.sql';

describe('no payment code ships', () => {
  it('has no payment Edge Function and no Stripe helper', () => {
    for (const p of [
      'supabase/functions/gm-create-order',
      'supabase/functions/gm-order-status',
      'supabase/functions/gm-stripe-webhook',
      'supabase/functions/gm-revolut-webhook',
      'supabase/functions/_shared/stripe.ts',
      'supabase/functions/_shared/revolut.ts',
      'src/modules/app/admin/subscriptions.controller.ts',
    ]) {
      expect(exists(p), `${p} must not exist`).toBe(false);
    }
  });

  it('declares no payment function in config.toml or the deploy hook', () => {
    // Comments are stripped first. Both files legitimately NAME these slugs in
    // prose explaining that they were removed -- the hook's comment records that
    // its hardcoded list had gone stale precisely because it still carried them
    // -- and a raw search flags correct documentation as a regression. This has
    // now bitten in five separate suites; strip, then assert.
    const config = stripHashComments(read('supabase/config.toml'));
    const hook = stripHashComments(read('scripts/hooks/pre-push'));
    for (const slug of ['gm-create-order', 'gm-order-status', 'gm-stripe-webhook', 'gm-revolut-webhook']) {
      expect(config, `config.toml still declares ${slug}`).not.toContain(slug);
      expect(hook, `the pre-push hook still deploys ${slug}`).not.toContain(slug);
    }
  });

  it('leaves no payment reference in the client', () => {
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(rootDir, dir), { withFileTypes: true })) {
        const rel = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        // database.generated.ts mirrors the live schema and is regenerated
        // after the migration lands; it is not hand-authored code.
        else if (e.name.endsWith('.ts') && !rel.endsWith('database.generated.ts')) files.push(rel);
      }
    };
    walk('src');

    for (const f of files) {
      const code = stripComments(read(f));
      for (const token of [
        'gm_payments', 'gm_apply_donation', 'gm_apply_subscription_payment',
        'subscription_type', 'subscription_end', 'payments_disabled', 'plan_key',
        'isPaymentsDisabled', 'isGuildSubscriptionExpired', 'stripe', 'Stripe',
      ]) {
        expect(code, `${f} still references ${token}`).not.toContain(token);
      }
    }
  });

  it('keeps no read-only subscription lock in the shell or the stylesheet', () => {
    const shell = stripComments(read('src/modules/shell/views/ShellView.ts'));
    expect(shell).not.toContain('guild-read-only');
    expect(shell).not.toContain('guild-warning-banner');
    expect(shell).not.toContain('checkSubscriptionStatus');
    // The 30s sidebar/topbar rebuild existed only to tick the expiry countdown.
    expect(shell).not.toContain('setInterval');
    expect(read('styles.css')).not.toContain('guild-read-only');
    expect(read('shell.css')).not.toContain('gm-sub-card-pill');
  });
});

describe('the guild admin tab kept what was actually live', () => {
  const ctrl = read('src/modules/app/admin/guilds.controller.ts');

  it('still assigns server numbers and still deletes guilds', () => {
    expect(ctrl).toContain('guild-server-number');
    expect(ctrl).toContain("update({ server_number:");
    expect(ctrl, 'gm_delete_guild has no other caller').toContain('gm_delete_guild');
  });

  it('no longer edits a subscription', () => {
    const code = stripComments(ctrl);
    for (const token of ['guild-sub-type', 'guild-sub-end', 'Unlimited', 'Premium', 'Lifetime', 'countdown']) {
      expect(code, `guilds.controller still carries ${token}`).not.toContain(token);
    }
  });

  it('is reachable from the router under its own name', () => {
    const router = read('src/modules/app/router.ts');
    // Phase 7: an imported reference now, not a string looked up on `window`.
    expect(router).toContain('renderGuildsList()');
    expect(router).not.toContain('renderGuildsSubscriptionList');
  });
});

describe('the migration drops the schema and repairs its dependents', () => {
  const sql = read(MIGRATION);

  it('drops the ledger, both RPCs, all four columns and both constraints', () => {
    expect(sql).toMatch(/DROP TABLE IF EXISTS public\.gm_payments/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.gm_apply_subscription_payment/);
    expect(sql).toMatch(/DROP FUNCTION IF EXISTS public\.gm_apply_donation/);
    for (const col of ['subscription_type', 'subscription_end', 'plan_key', 'payments_disabled']) {
      expect(sql, `${col} must be dropped`).toMatch(new RegExp(`DROP COLUMN IF EXISTS ${col}`));
    }
    for (const c of ['check_subscription_end_premium', 'guilds_subscription_type_check']) {
      expect(sql, `${c} must be dropped`).toContain(`DROP CONSTRAINT IF EXISTS ${c}`);
    }
  });

  it('repairs gm_reset_demo_tenant_data BEFORE the columns it writes are dropped', () => {
    const repairAt = sql.indexOf('gm_reset_demo_tenant_data');
    const dropAt = sql.indexOf('DROP COLUMN IF EXISTS subscription_type');
    expect(repairAt).toBeGreaterThan(-1);
    expect(repairAt, 'the cron repair must precede the column drop').toBeLessThan(dropAt);
  });

  it('fails loudly instead of silently half-repairing the cron', () => {
    // The push removal shipped a repair that passed its own guard while leaving
    // a second reference behind. This one asserts on every dropped name, and
    // refuses to run at all if the live function has drifted from what it edits.
    expect(sql).toContain('does not match the expected text');
    const post = sql.slice(sql.indexOf('Post-condition'));
    for (const name of ['subscription_type', 'subscription_end', 'payments_disabled', 'plan_key', 'gm_payments']) {
      expect(post, `the post-condition must assert on ${name}`).toContain(name);
    }
  });

  it('keeps is_subscription_active, which 44 RLS policies still invoke', () => {
    // Neutralised to `SELECT true`. Dropping it means rewriting every write
    // policy -- a separate lot, not a payment-removal side effect.
    expect(sql).not.toMatch(/DROP FUNCTION[^\n]*is_subscription_active/);
  });

  it('reloads the PostgREST schema cache', () => {
    expect(sql.toLowerCase()).toContain("notify pgrst, 'reload schema'");
  });
});

describe('the terms page no longer sells anything', () => {
  const terms = read('terms.html');

  it('drops Stripe as a processor and the PCI-DSS claim', () => {
    for (const token of ['Stripe', 'PCI-DSS', 'Revolut', 'access pass', 'Conditions of Sale']) {
      expect(terms, `terms.html still mentions ${token}`).not.toContain(token);
    }
  });

  it('states plainly that there is no payment surface', () => {
    // The section was renumbered and retitled when the Terms were rewritten in
    // plain English. What matters is the statement, not the heading.
    expect(terms).toMatch(/IT IS FREE, AND IT STAYS FREE/);
    expect(terms).toMatch(/No checkout, no subscription, no donation button, no stored card/);
  });

  it('no longer caps liability at an amount that is always zero', () => {
    // §7.3 used to cap liability at "the total amount actually paid by the User
    // ... for the specific access pass", which was never anything.
    // Section 9 in the rewritten Terms ("WHEN SOMETHING GOES WRONG").
    const clause = terms.slice(terms.indexOf('WHEN SOMETHING GOES WRONG'));
    expect(clause.slice(0, 2000)).not.toContain('total amount actually paid');
    expect(clause.slice(0, 2000)).toMatch(/no cap calculated on sums paid can apply/);
  });
});
