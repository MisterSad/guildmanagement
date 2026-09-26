# ADR-015: Permanently Free — No Payment Surface of Any Kind

- **Status**: Accepted
- **Date**: 2026-09-26
- **Authors**: Owner decision, executed in Phase 1

---

## 1. Context

The platform was built as a paid multi-tenant SaaS and still described itself as one long after it had stopped being one.

Measured before deciding:

- `public.is_subscription_active()` had been a literal `SELECT true` since `20260824000000_free_app_and_donations.sql`. The client-side gate `isGuildSubscriptionExpired()` was `return false`.
- `gm_payments` held **22 rows, every one `pending`, none `paid`**. No money was ever collected, so no accounting-retention obligation attached to the table.
- **Nothing in `src/` or `index.html` called** `gm-create-order` or `gm-order-status`.
- Two payment-adjacent Edge Functions were **live with no source in this repository**: `gm-revolut-webhook` (ACTIVE, `verify_jwt = false`, i.e. public) and `webauthn-spike`. See ADR-017.
- The Revolut price list (`1m` 699 / `3m` 1699 / `6m` 2799 / `lifetime` 8900) differed from the Stripe one (999 / 2499 / 4499, **no lifetime**), and the README documented the *Revolut* list — the flow that had already been removed.

So the payment surface was simultaneously dead in the product, alive on the platform, and mis-documented in three places.

## 2. Decision

The application is **free for every guild, permanently**. There is no subscription, no donation, no contribution mechanism, no checkout, and no payment data held or transmitted anywhere.

Executed:

1. Deleted the Edge Functions `gm-create-order`, `gm-order-status`, `gm-stripe-webhook` and `_shared/stripe.ts`, plus the two orphans `gm-revolut-webhook` and `webauthn-spike`, from both the platform and (where they existed) the repository.
2. Deleted `src/modules/app/admin/subscriptions.controller.ts` and its tab, `isGuildSubscriptionExpired()` and its call sites, and the associated i18n keys and markup.
3. Dropped `gm_apply_subscription_payment`, `gm_apply_donation` and the `gm_payments` table.
4. Rewrote `terms.html` §4 to state plainly that no payment surface exists and that the withdrawn "Buy Me a Coffee" feature has been removed in full.

## 3. Consequences & Invariants

- **No feature may ever be gated on payment**, and no code may reintroduce a checkout, a price, or a payment-provider SDK. A guild's access depends only on its account status and role.
- **`public.is_subscription_active()` deliberately survives** as `SELECT true`. It is referenced by roughly 44 RLS clauses; dropping it means rewriting every one of them, which is the single riskiest change left in the audit backlog and is tracked separately. Its survival is *not* evidence that payments exist — read this ADR before concluding otherwise.
- **The whitepaper and the README must not describe plans, tiers or prices.** They did for weeks after the feature was gone.
- Verification: `grep -ri "stripe\|revolut\|subscription_type\|checkout" src/ index.html` returns nothing load-bearing, and `gm_payments` does not exist in `pg_class`.
