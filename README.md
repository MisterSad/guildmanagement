# Guild Management Tool

All-in-one guild management for mobile-game guild leaders: event participation
tracking, squad building, weighted leaderboards, sanctions, and automatic
Discord + Web Push reminders. Installable PWA, English/French (more languages
pluggable), Supabase backend.

The full product strategy and execution plan lives in
[`saas_strategy.md`](./saas_strategy.md).

## Layout

```
index.html, fr/, landing.css   Marketing landing (EN at /, FR at /fr/)
legal/                         Terms & privacy (draft)
app/                           The PWA (no build step, vanilla JS)
  index.html                   App shell
  *.js                         Feature modules (events, stats, shadowfront, …)
  config.js                    Per-environment public config (Supabase + VAPID)
  locales/                     i18n: index.js registry + en.js (reference) + fr.js
  *.css                        Design system
sw.js, *.png, manifest         Service worker + icons (web root, PWA scope /app/)
supabase/                      Backend source of truth
  migrations/                  Applied SQL (baseline + P0 hardening)
  migrations_staged/           Multi-tenant migration (NOT applied — see runbook)
  functions/                   Live edge functions
  functions_staged/            Multi-tenant v2 edge functions (NOT deployed)
tools/                         check.js (validator) + i18n-check.js
docs/cutover-runbook.md        Multi-tenant cutover procedure
```

## Development

No build, no npm dependencies — just static files served from the repo root.
Node is used only for validation tooling.

Validate before pushing (also runs in CI and at session start):

```sh
node tools/check.js        # JS syntax + i18n coverage + asset-reference integrity
node tools/i18n-check.js   # i18n only (used by check.js)
```

Cache-busting is manual via `?v=N` query strings on asset references; bump the
number when you change a file. `tools/check.js` fails if any referenced asset is
missing, which catches the common "renamed a file, forgot the reference" slip.
(Replacing this with content-hash stamping is a future item, saas_strategy.md
§14.1.)

### Adding a language

1. Copy `app/locales/en.js` to `app/locales/<code>.js` and translate the values.
2. Add one entry to `app/locales/index.js` (BCP-47 code, label, flag, Intl locale).
3. `node tools/i18n-check.js` to confirm coverage.

English is the reference locale and the fallback for any missing key.

## Validation (free, no CI service)

Validation runs through git hooks and the session hook — no GitHub Actions,
no paid CI:

- `.githooks/pre-push` runs `node tools/check.js` and **blocks the push** if it
  fails. Enable per clone with `git config core.hooksPath .githooks` (bypass a
  single push with `git push --no-verify`).
- `.claude/hooks/session-start.sh` enables that hooks path and runs the
  validator at the start of each Claude Code on the web session.
- Or just run `node tools/check.js` manually anytime.

## Backend & deploy

See [`supabase/README.md`](./supabase/README.md) for the Supabase project,
secrets, edge functions and the pg_cron reminder job. The static site deploys to
Vercel from the repo root; the app is served under `/app/`.
