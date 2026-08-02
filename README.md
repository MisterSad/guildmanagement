# FGF Guild Management Tool

Serverless guild-management web app for **Foundation Galactic Frontier (FGF)**, a
guild of the mobile game *Whiteout Survival*. The app covers event tracking
(SvS, GvG, Shadowfront, DTR, Arms Race, Glory), member & account management,
sanctions, banned players, Discord notifications and per-guild subscription
plans.

## Stack

- **Frontend**: vanilla JavaScript (no framework), static hosting on Supabase
  Storage. 3D login scene (three.js), Phosphor icons, custom CSS design system
  (`styles.css`, `tokens.css`, `components.css`, `shell.css`).
- **Backend**: Supabase (Postgres + RLS + `SECURITY DEFINER` functions) and
  Edge Functions (Deno) for authentication and admin operations.
- **Tests**: Vitest + jsdom, run with `npm test`.

## Project layout

```
index.html              Single-page shell (all views are panels)
gm-utils.js             Shared utilities (Supabase client, roles, i18n bridge,
                        dates, escaping, toasts) — loaded first
app.js                  Core app: login/session, accounts, members, tabs
shell.js                Sidebar/topbar/bottom-nav shell around the dashboard
i18n.js                 English-only translation strings (t('key'))
events.js / shadowfront.js / armsrace.js / glory.js / history.js
stats.js / sanctions.js / overview.js / push.js
login-3d.js             three.js login background
sw.js                   Service worker
supabase/functions/     Edge Functions: auth-login, admin-accounts,
                        member-portal, event-reminders, gm-create-order,
                        gm-order-status, gm-revolut-webhook
supabase/migrations/    SQL migrations (roles, RLS policies, functions)
tests/                  Vitest unit tests
```

## Subscriptions (Revolut)

Guild admins (and the super admin, per tenant) can purchase subscription
extensions in the **Subscription** tab. Plans: 1 Month €6.99, 3 Months €16.99,
6 Months €27.99, 12 Months €47.99, Lifetime €89.00. Payments run through the
Revolut Merchant Web SDK (embedded checkout: card, Revolut Pay, Apple Pay,
Google Pay) and are confirmed server-side only:

1. `gm-create-order` creates the Revolut order (server-side, amount in cents)
   and records it in `gm_payments` (status `pending`).
2. `gm-revolut-webhook` (public, HMAC-verified) applies the extension on
   `ORDER_COMPLETED` via the idempotent `gm_apply_subscription_payment` RPC —
   time plans extend from `max(now, current end)` (stacking), the Lifetime plan
   switches the guild to `subscription_type = 'Lifetime'`.
3. `gm-order-status` lets the client confirm quickly after checkout and
   refresh the UI; the webhook remains the source of truth.

Required Supabase secrets (Dashboard → Edge Functions → Secrets):

```
REVOLUT_SECRET_KEY              # Revolut Business API key (server side)
REVOLUT_PUBLIC_KEY              # Revolut public key (pk_...), widget
REVOLUT_ENV                     # 'sandbox' | 'prod' (default: prod)
REVOLUT_WEBHOOK_SIGNING_SECRET  # HMAC secret, generated when registering the webhook
```

Register the webhook in Revolut Business (Merchant API → Webhooks) pointing to:

```
https://<project-ref>.functions.supabase.co/gm-revolut-webhook
```

deployed with `--no-verify-jwt` (the signature is verified inside the function).

## Roles & access

| Role          | Legacy | Meaning                                                       |
|---------------|--------|---------------------------------------------------------------|
| `super_admin` | R5     | Full access; writes are restricted to the ALPHA guild         |
| `guild_admin` | R4     | Admin of one guild (linked to a `guild`), subscription-gated  |
| `member`      | R1–R3  | Read-only access to guild data                                |

`super_admin` and `guild_admin` are stored on the `accounts` table and mirrored
into `auth.users.raw_app_meta_data.app_role` (edge functions use them server
side). The UI reads the role from the JWT when available, falling back to
`localStorage`.

> Note: the R1–R5 values on `guild_members.rank` are gameplay guild ranks
> (titles inside the guild) — unrelated to the account roles above and kept
> unchanged.

## Local development

The frontend is plain static files — open `index.html` or serve the folder:

```sh
python3 -m http.server 8000
```

Supabase CLI for edge functions and migrations:

```sh
supabase start                 # local stack
supabase functions serve       # serve edge functions locally
supabase db push               # apply migrations
supabase functions deploy auth-login admin-accounts member-portal event-reminders
```

## Tests

```sh
npm install
npm test           # vitest run
npm run test:watch
```

Test files cover shared utilities, i18n, leaderboard statistics computation
(global & participation modes with mocked Supabase responses) and the role
resolution rules.

> Node ≥ 22 note: on Node versions exposing an experimental global
> `localStorage`, Vitest's jsdom environment skips the DOM Storage polyfill;
> `tests/setup.js` re-injects an in-memory `localStorage` so tests are
> deterministic.

## Browser storage

All persisted state lives under `localStorage` keys prefixed `gm_`
(e.g. `gm_role`, `gm_current_guild`, `gm_guild_restriction`, `gm_user`,
`gm_active_tab`, `gm_config_*`). A one-time shim in `gm-utils.js` migrates the
legacy `rad_*` keys automatically on load.
