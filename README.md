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
                        member-portal, event-reminders
supabase/migrations/    SQL migrations (roles, RLS policies, functions)
tests/                  Vitest unit tests
```

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
