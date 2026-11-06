# Contexte Projet & SSOT - FGF Guild Management

> **Ce fichier est un résumé de travail, pas la référence.** Les règles sont dans
> `AGENTS.md`, l'architecture dans `ARCHITECTURE.md`, les décisions dans `docs/adr/`,
> l'historique des livraisons dans `CHANGELOG.md`. En cas de désaccord, ce sont eux
> qui font foi, et la production avant eux : mesurer avant d'écrire.
> Réécrit le 2026-10-04 ; les journaux de mission du 2026-09-13 qu'il contenait
> sont résumés au §3 et détaillés dans `CHANGELOG.md`.

## 1. Stack technique réelle (vérifiée le 2026-10-04)
- **Runtime & build :** Node.js 24 (`package.json` `engines`, `.nvmrc`, CI), TypeScript 7.0, Vite 8.2 ; `scripts/build.js` orchestre le build et refuse un JS d'entrée au-delà de 450 KB.
- **Frontend :** modules TypeScript/ESM dans `src/`, point d'entrée unique `src/main.ts`, sans framework UI. Les modules s'appellent par import typé ; le client (`setDbClient` / `getClient`, `src/core/api/supabase.ts`) et l'état (`src/core/state/app-state.ts`, seul écrivain, `patchAppState()`) sont des modules. Le pont `window.GM_*` et `src/core/gm-bridge.ts` ont été supprimés (M4c) : la seule globale est `window.GM_E2E`, gelée, cinq points d'entrée pour la suite e2e (`tests/gm_bridge_contract.test.js`). Les vues d'onglet sont des chunks chargés à la demande (`src/modules/app/lazy-views.ts`) et l'admin un chunk unique derrière `loadAdmin()` (`src/modules/app/admin-loader.ts`).
- **UI :** `cn()` (clsx seul) et `cva` dans `src/core/utils/` ; tokens `tokens.css` + `theme.css` ; composants `src/components/ui/` : `Badge`, `BaseComponent`, `Dialog` (`openDialog` / `adoptDialog`, une pile commune), `Toast`, `Tooltip`. Icônes : `@phosphor-icons/web`, sous-ensemble servi localement (aucun CDN). Polices auto-hébergées (`fonts.css`).
- **Service worker :** `src/sw/service-worker.ts` est une pierre tombale qui se désinscrit ; elle doit continuer d'être servie (ADR-016). Pas de PWA, pas de push, pas d'offline.
- **Base de données :** Supabase Postgres 17. Mesuré en production le 2026-11-06 : 39 tables `public`, toutes en RLS + FORCE RLS, 79 policies, 62 guildes, ~5 033 membres, ~87 139 lignes de participation. Ces chiffres bougent chaque semaine : re-mesurer. Helpers `SECURITY DEFINER` avec `SET search_path = ''`, rôles résolus uniquement depuis `accounts` via `auth.uid()`.
- **Edge Functions :** Deno, 13 dans `supabase/functions/` (hors `_shared`, `_test`), 13 déployées (ADR-017). `verify_jwt` vient de `supabase/config.toml` : `false` pour `auth-login`, `auth-discord`, `player-register`, `guild-request`, `event-reminders`, `discord-bot-interactions`, `discord-profile-verification` ; `true` pour `member-portal`, `admin-accounts`, `guild-data-export`, `discord-webhook-proxy`, `ocr-guild-members`, `tickets`. `migration-summary` a été retirée avec le Migration Hub le 2026-11-06. `admin-accounts` est bien déployée en `true` depuis la correction du finding M1.
- **Authentification :** connexion Discord (OAuth via `auth-discord`, jamais le fournisseur Discord natif de Supabase), ID + mot de passe conservés pendant la transition. Les passkeys/WebAuthn ont été supprimées le 2026-10-03 ; les codes de secours du super_admin restent (flux Discord).
- **Tests :** Vitest (`npm test`, avec un plancher de couverture), Playwright contre le vrai bundle de `dist/`, `deno check` + `deno test` sur les fonctions, rejeu des migrations et tests SQL par rôle (`scripts/replay-migrations.sh`, `scripts/sql-tests.sh`). Pas de compteur ici : il est périmé au test suivant.
- **Hébergement :** Vercel (front statique, en-têtes de sécurité et CSP dans `vercel.json`), Supabase Cloud (Postgres, Auth, Storage, Edge Functions). Worker de vérification Discord sur Render.
- **Gratuit :** aucun paiement, abonnement ni don (ADR-015). Le stub `is_subscription_active()` (`SELECT true`) a été retiré des 45 policies et 10 fonctions qui l'appelaient, puis supprimé, le 2026-10-04.

## 2. Règles d'or
- **Modules uniquement :** tout code vit sous `src/` en TypeScript ; aucun script `.js` à la racine, rien de nouveau sur `window`.
- **Porte qualité :** `npm run type-check`, `npm test`, `npm run build`, `npx playwright test` ; avant de toucher au SQL ou à une fonction, aussi `deno check`/`deno test`, le rejeu des migrations et `scripts/sql-tests.sh` (voir `AGENTS.md`).
- **Déploiements depuis la CI uniquement.** Les Edge Functions partent du job `deploy-edge-functions` (`scripts/deploy-edge-functions.sh`), jamais avec `--no-verify-jwt`. Les migrations s'appliquent par le MCP Supabase `apply_migration`, puis le fichier est renommé à la version enregistrée par la production (`supabase/migrations/README.md`). **Ne jamais lancer `supabase db push`** : il rejouerait des migrations déjà appliquées.
- **Sécurité RLS :** toute table a `ENABLE` et `FORCE ROW LEVEL SECURITY` ; grants par colonne, pas seulement des policies ; aucun rôle lu depuis `user_metadata`.
- **Sondes en production :** jamais de requête destructive. Les écritures se testent sur une base rejouée (`scripts/replay-migrations.sh` puis `scripts/sql-tests.sh`) ; en production, uniquement dans une simulation terminée par une exception (tout est annulé). Le tenant `DEMO` a été supprimé le 2026-10-04.

## 3. Historique résumé (missions du 2026-09-13)
Détail complet dans `CHANGELOG.md` et les migrations citées. Les instructions de déploiement `supabase db push` de l'époque sont caduques.
- **Remédiation phases 1-3** (`perf(db)`, `sec(auth)`, `perf(frontend)`) : index ciblés et timeouts sur `gm_check_login` ; RPC atomique `gm_check_ip_throttle` et job `login-throttle-retention` (purge horaire des lignes de plus de 24 h) ; contrainte `accounts_role_check` limitée aux quatre rôles ; époque de session `accounts.session_version` / `gm_session_is_valid()`, réellement appliquée depuis `20260926185133` (finding C1) ; taxonomie d'erreurs réseau `src/core/api/fetch-errors.ts` ; `AbortController` par chargement d'onglet dans `router.ts`.
- **Guerre SvS/GvG granulaire** (`20260914090000_war_daily_scores_and_chest_tiers.sql`) : tables `war_opponents`, `war_sessions`, `event_daily_scores`, `event_chest_tiers` et leurs RPC ; `score_prep`/`score_pvp` restent dérivés par `gm_upsert_daily_scores`. Miroir TS dans `src/core/scoring/chests.ts`.
- **Plafond des scores à 9 999 999 999** (`20260914100000_raise_event_score_limit_to_9999999999.sql`) : colonnes en BIGINT, constante `MAX_ALLOWED_EVENT_SCORE` dans `supabase/functions/_shared/player-actions.ts`.
- **Rappels Discord fiabilisés** (`20260914110000_fix_event_reminders_trigger_and_tz.sql`) : toggles stricts (`isToggleEnabled()`), garde cron en UTC, fenêtre SvS calendaire.
- **Refonte UI shadcn-like** : primitives et tokens ; `Switch`, `Checkbox`, `Input` et `Table` ont depuis disparu de `src/components/ui/`.
- **Day 0 / OCR hybride** (`20260915100000_war_aggregate_day0.sql`) : pseudo-jour 0 = total J1-5 ; `syncWarOcrGate` supprimé ; métriques OCR `svs_day`/`gvg_day`.
