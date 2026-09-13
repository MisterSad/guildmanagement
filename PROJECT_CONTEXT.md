# Contexte Projet & SSOT - FGF Guild Management

## 1. Stack Technique Réelle
- **Runtime & Build :** Node.js 20 LTS, Vite 8.2 (build via `scripts/build.js` + minification esbuild).
- **Frontend :** SPA TypeScript/ESM (`/src/main.ts`), pont legacy `window.GM_*` assemblé dans `/src/core/gm-bridge.ts`. Le monolithe `app.js` (7 431 lignes) a été **supprimé** au cutover final Strangler et le Service Worker legacy racine a été migré sous `/src/sw/service-worker.ts` (parseur pur dans `/src/sw/push-payload.ts`), compilé vers `dist/sw.js` (racine de `dist/`, scope `/`) par esbuild dans `scripts/build.js`. La racine du projet ne contient plus aucun script applicatif : uniquement des configs d'outillage (`playwright.config.js`, `vitest.config.js`).
- **Base de données :** Supabase PostgreSQL (42 tables persistantes actives avec RLS hermétique — y compris les 4 tables de guerre `war_opponents`/`war_sessions`/`event_daily_scores`/`event_chest_tiers` — sur 45 `CREATE TABLE` historiques, helpers SECURITY DEFINER avec search_path vide, résolution de rôles stricte via table `accounts`).
- **Edge Functions (16 live) :** Deno / TypeScript dans `supabase/functions/` — 8 publiques sans JWT (`verify_jwt = false` : `auth-login`, `auth-passkey`, `player-register`, `guild-request`, `event-reminders`, `gm-stripe-webhook`, `discord-bot-interactions`, `discord-profile-verification`) et 8 sécurisées par JWT (`verify_jwt = true` : `member-portal`, `admin-accounts`, `ocr-guild-members`, `discord-webhook-proxy`, `gm-create-order`, `gm-order-status`, `guild-data-export`, `tickets`).
- **Authentification & Crypto :** WebAuthn (Passkeys RP_ID `guildmanagement.vercel.app`), Discord OAuth2/Ed25519.
- **Tests :** Vitest (101 suites, 1 152 tests, 100 % passants — état vérifié au 2026-09-13 après la mission SvS/GvG Granular War Management), Playwright (E2E sur port 4173), syntax-check racine et type-check TypeScript.
- **Hébergement :** Vercel (frontend statique + headers de sécurité dans `vercel.json`), Supabase Cloud (PostgreSQL, Auth, Edge Functions).

## 2. Règles d'Or & Standards d'Ingénierie
- **Stratégie de Modularisation (Strangler) :** Tout nouveau code est écrit sous forme de module TypeScript/ESM dans `/src/`. Interdiction stricte de créer de nouveaux fichiers `.js` à la racine ou d'ajouter de nouvelles variables globales sur `window.GM_*`.
- **Porte Qualité CI :** Aucun commit sans que `npm run type-check`, `npm test` (1 152 tests verts, 101 suites) et `scripts/build.js` ne soient au vert.
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

## 4. Clôture Mission — SvS/GvG Granular War Management (2026-09-13)

Évolution majeure des modules SvS & GvG livrée en 3 lots (`feat(war)`). **Migration SQL déployable exclusivement via `supabase db push`** : `supabase/migrations/20260914090000_war_daily_scores_and_chest_tiers.sql`.

### Données (migration 20260914090000)
- **4 nouvelles tables tenanted** (RLS `FORCE`, policies `gm_can_read_guild_data` / `check_user_guild_write_access AND is_subscription_active`) :
  - `war_opponents` — catalogue d'adversaires par guilde (`kind server|guild`, `name`, `UNIQUE(guild, kind, name)`, jamais de FK cross-tenant : un adversaire créé à la volée n'est jamais un tenant).
  - `war_sessions` — méta persistante de session de guerre (adversaire figé `opponent_snapshot`, résultats `day1_result..day6_result won|lost`, grille de coffres figée `chest_tiers_snapshot`, `UNIQUE(guild, event_name, session_id)`).
  - `event_daily_scores` — scores granuleux par joueur/jour (Day 1..6 + `chests_unlocked`, FK cascade vers `war_sessions` et `guild_members`).
  - `event_chest_tiers` — grille paramétrable des paliers de coffres (PK `(guild, event_name, day, tier)`).
- **9 RPCs** `SECURITY DEFINER search_path=''` : `gm_get_chest_tiers`, `gm_save_chest_tiers`, `gm_upsert_war_session`, `gm_get_war_session`, `gm_list_war_sessions`, `gm_upsert_daily_scores`, `gm_get_daily_scores`, `gm_delete_war_session`, `gm_list_opponent_candidates` + helper déterministe `gm_chests_for_score(p_tiers, p_score)`.
- `gm_list_event_sessions` étendu avec la colonne booléenne `granular` (EXISTS sur `war_sessions`) — rétrocompatible, mêmes colonnes + 1.

### Garantie de rétrocompatibilité
- `score_prep` (somme Day 1-5) et `score_pvp` (Day 6) de `event_participants` restent **dérivés transactionnellement** par `gm_upsert_daily_scores` sur les sessions granulaires (`score = NULL`, `participated=1` si total>0) ; les scores passés et les sessions legacy restent intacts (aucun ALTER destructif, aucun backfill).

### Frontend
- **EventsView** : bandeau de guerre (adversaire sélectable/créable + toggles W/L Day 1-6) et tableau granulaire (colonnes Day 1..Day 6 + total coffres calculé client via `resolveChestsForScore`, sauvegarde par lot debouncée 700ms `gm_upsert_daily_scores`).
- **Guild Settings** : carte « SvS/GvG — Chest Tiers » (`src/modules/events/chest-settings.ts`, onglets SvS/GvG, paliers ajoutables/éditables, enregistrement atomique).
- **History** : cartes de session avec `vs <adversaire> · wW/lL`, modale granulaire 6 jours (routée sur `gm_upsert_daily_scores`).
- **OCR** : gate `syncWarOcrGate` — boutons OCR agrégés legacy `svs_prep/svs_pvp/gvg_prep/gvg_pvp` désactivés avec tooltip quand une session granulaire est active.
- **Scoring** : `src/core/scoring/chests.ts` (`resolveChestsForScore`, miroir TS 1:1 de `gm_chests_for_score`, + `defaultChestGrid`) ; wrappers RPC typés dans `events.service.ts` ; i18n `war_*` (551 clés).

### État des tests (fin de mission, 2026-09-13)
- `npm run type-check` : **0 erreur**.
- `npm test` : **1 152 tests réussis / 101 suites** (+7 depuis 1 145) — scoring coffres (11 tests), mode granulaire EventsView (6 tests), golden i18n 551.
- `npm run build` : production stable, `version.json` V3.18.0.
- **Déploiement requis** : `supabase db push` (migration 20260914090000) puis push frontend (Vercel) — le push git seul n'applique pas le SQL.