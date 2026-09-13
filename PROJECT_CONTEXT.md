# Contexte Projet & SSOT - FGF Guild Management

## 1. Stack Technique Réelle
- **Runtime & Build :** Node.js 20 LTS, Vite 8.2 (build via `scripts/build.js` + minification esbuild).
- **Frontend :** SPA TypeScript/ESM (`/src/main.ts`), pont legacy `window.GM_*` assemblé dans `/src/core/gm-bridge.ts`. Le monolithe `app.js` (7 431 lignes) a été **supprimé** au cutover final Strangler et le Service Worker legacy racine a été migré sous `/src/sw/service-worker.ts` (parseur pur dans `/src/sw/push-payload.ts`), compilé vers `dist/sw.js` (racine de `dist/`, scope `/`) par esbuild dans `scripts/build.js`. La racine du projet ne contient plus aucun script applicatif : uniquement des configs d'outillage (`playwright.config.js`, `vitest.config.js`).
- **Base de données :** Supabase PostgreSQL (38 tables persistantes actives avec RLS hermétique sur 41 `CREATE TABLE` historiques, helpers SECURITY DEFINER avec search_path vide, résolution de rôles stricte via table `accounts`).
- **Edge Functions (16 live) :** Deno / TypeScript dans `supabase/functions/` — 8 publiques sans JWT (`verify_jwt = false` : `auth-login`, `auth-passkey`, `player-register`, `guild-request`, `event-reminders`, `gm-stripe-webhook`, `discord-bot-interactions`, `discord-profile-verification`) et 8 sécurisées par JWT (`verify_jwt = true` : `member-portal`, `admin-accounts`, `ocr-guild-members`, `discord-webhook-proxy`, `gm-create-order`, `gm-order-status`, `guild-data-export`, `tickets`).
- **Authentification & Crypto :** WebAuthn (Passkeys RP_ID `guildmanagement.vercel.app`), Discord OAuth2/Ed25519.
- **Tests :** Vitest (100 suites, 1 133 tests, 100 % passants — état vérifié au 2026-09-13 après la mission de remédiation Phases 1-3), Playwright (E2E sur port 4173), syntax-check racine et type-check TypeScript.
- **Hébergement :** Vercel (frontend statique + headers de sécurité dans `vercel.json`), Supabase Cloud (PostgreSQL, Auth, Edge Functions).

## 2. Règles d'Or & Standards d'Ingénierie
- **Stratégie de Modularisation (Strangler) :** Tout nouveau code est écrit sous forme de module TypeScript/ESM dans `/src/`. Interdiction stricte de créer de nouveaux fichiers `.js` à la racine ou d'ajouter de nouvelles variables globales sur `window.GM_*`.
- **Porte Qualité CI :** Aucun commit sans que `npm run type-check`, `npm test` (1 133 tests verts, 100 suites) et `scripts/build.js` ne soient au vert.
- **Sécurité RLS :** 100 % des tables doivent avoir `ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY`. Les rôles sont lus exclusivement dans la table `accounts` (aucun fallback `user_metadata`).
- **Logos & Tiers :** Utiliser exclusivement le package `simple-icons` pour tout logo officiel tiers (Discord, Google, Apple, etc.). Ne jamais inventer de SVG à la main.

## 3. Clôture Mission de Remédiation — Phases 1-3 (2026-09-13)

Mission d'audit global terminée et **déployée en production le 2026-09-13** (3 commits sur `main` : `perf(db)`, `sec(auth)`, `perf(frontend)`). Vercel build production `Ready` (`version.json` V3.17.1).

### Phase 1 — Résilience PostgreSQL & RPC (`perf(db)`)
- Indexation ciblée (`event_status (start_at) WHERE is_active`, `push_subscriptions (guild)`, `login_throttle (window_start)`, `guild_config (updated_at) WHERE key LIKE 'sent_%'`, `accounts (locked_until) WHERE locked_until IS NOT NULL`) et suppression de l'index redondant `idx_login_throttle_ip_time`.
- Timeouts stricts sur `gm_check_login` (`lock_timeout=2s`, `statement_timeout=5s`) et `gm_invoke_event_reminders` (`lock_timeout=1s`, `statement_timeout=3s`).
- RPC atomique `public.gm_check_ip_throttle` (`SUM` + `INSERT … ON CONFLICT (ip, window_start) DO UPDATE`, `service_role` uniquement) → élimination des violations `login_throttle_pkey` et purge synchrone supprimée au profit d'un job `pg_cron` (`login-throttle-retention`).
- Wrapper `gm_invoke_event_reminders` gardé : appel `net.http_post` uniquement si des événements actifs sont dans `[now()-5min, now()+35min]` ou qu'une fenêtre hebdomadaire GvG/SvS/Calamity est ouverte.

### Phase 2 — Sécurité Rôles & RLS (`sec(auth)`)
- Contrainte `accounts_role_check` stricte : `super_admin`, `server_admin`, `guild_admin`, `member` (défaut `member`). **Abandon définitif des rôles virtuels/in-game** (`R5`, `R4`, `admin`) — plus aucun alias d'élévation.
- Helpers exacts sans alias : `is_super_admin()`, `is_server_admin()`, `gm_can_read_guilds()` — résolution exclusivement via `public.accounts` (`auth_user_id` + `status='active'`).
- Époch d'invalidation de session `accounts.session_version` + `public.gm_session_is_valid()` (claim JWT `app_metadata.session_version`), bumpée sur reset de mot de passe / changement de rôle / suspension (admin-accounts + shadow-session).
- RLS `player_absences` corrigée : self-read via `a.uid = player_absences.uid` (plus de dépendance au `app_metadata.account_id`).

### Phase 3 — Résilience Frontend & Roster (`perf(frontend)`)
- Taxonomie d'erreurs réseau unifiée (`src/core/api/fetch-errors.ts`) : `offline` / `gateway` (502/503/504) / `rate_limited` (429) / `unauthorized` (401/jwt_expired) / `server` / `unknown`, toasts classés + bannière de réessai inline.
- Invalidation de session centralisée (`supabase.ts`) : purge du storage GoTrue (`sb-*`/`supabase.*`) + événement `gm:session-expired` → reconnexion.
- Cycle `AbortController` sur la navigation entre onglets (`router.ts`) : annulation du batch précédent, déduplication des clics redondants, `AbortSignal` transmis à `fetchGuildMembers`.
- Roster : délégation d'événements DOM liée une seule fois, mémoïsation de `calculateRallyScore`, tri unique sur la Tactical Force Matrix, **overall_power max précalculé O(1)** (`getMaxOverallPower()`), skeleton de chargement initial sans écraser les données en cache.

### État des tests (au 2026-09-13)
- `npm run type-check` : **0 erreur**.
- `npm test` : **1 133 tests réussis / 100 suites** (+40 tests depuis 1 093/97).
- `npm run build` : production stable, Service Worker compilé, `version.json` V3.17.1.
- Migrations/Edge déployables (le push frontend seul n'applique pas SQL/Edge) : `supabase db push` puis `supabase functions deploy` (auth-login, auth-passkey, admin-accounts, member-portal, player-register, event-reminders, admin-reset-passkeys).