# Contexte Projet & SSOT - FGF Guild Management

> **Superseded for migrations (2026-10-03):** the `supabase db push` instructions in
> the entries below are historical, and running them now would replay applied
> migrations. Follow `supabase/migrations/README.md`: apply with the MCP
> `apply_migration`, then rename the file to the version production recorded.

## 1. Stack Technique Réelle
- **Runtime & Build :** Node.js 20 LTS, Vite 8.2 (build via `scripts/build.js` + minification esbuild).
- **Frontend :** SPA TypeScript/ESM (`/src/main.ts`), pont legacy `window.GM_*` assemblé dans `/src/core/gm-bridge.ts`. Le monolithe `app.js` (7 431 lignes) a été **supprimé** au cutover final Strangler et le Service Worker legacy racine a été migré sous `/src/sw/service-worker.ts` (parseur pur dans `/src/sw/push-payload.ts`), compilé vers `dist/sw.js` (racine de `dist/`, scope `/`) par esbuild dans `scripts/build.js`. La racine du projet ne contient plus aucun script applicatif : uniquement des configs d'outillage (`playwright.config.js`, `vitest.config.js`).
- **Design System UI/UX (shadcn-like) :** primitives canoniques `cn()` (clsx + tailwind-merge, conflits last-wins) et `cva`/`VariantProps` (class-variance-authority) dans `src/core/utils/`, couche sémantique de tokens `theme.css` à la racine (alias 1:1 sur le socle M3 de `tokens.css`, dark-only), bibliothèque modulaire `src/components/ui/` — Switch, Checkbox, Input, Badge, Table, Dialog, Tooltip + `types.ts`. Zéro Tailwind/PostCSS/Vite ajouté : primitives portées, tokens par CSS variables.
- **Base de données :** Supabase PostgreSQL (42 tables persistantes actives avec RLS hermétique — y compris les 4 tables de guerre `war_opponents`/`war_sessions`/`event_daily_scores`/`event_chest_tiers` — sur 45 `CREATE TABLE` historiques, helpers SECURITY DEFINER avec search_path vide, résolution de rôles stricte via table `accounts`).
- **Edge Functions (14 live) :** Deno / TypeScript dans `supabase/functions/` — 7 déclarées publiques (`verify_jwt = false` : `auth-login`, `auth-passkey`, `player-register`, `guild-request`, `event-reminders`, `discord-bot-interactions`, `discord-profile-verification`) et 7 déclarées sous JWT (`verify_jwt = true` : `member-portal`, `admin-accounts`, `ocr-guild-members`, `discord-webhook-proxy`, `guild-data-export`, `tickets`, `migration-summary`). Attention : `admin-accounts` est **déployée** en `verify_jwt = false` alors que `config.toml` la déclare `true` (finding M1 — le handler revérifie le JWT lui-même, mais la barrière plateforme est perdue). Les fonctions de paiement (`gm-create-order`, `gm-order-status`, `gm-stripe-webhook`) et les deux fonctions orphelines sans source au dépôt (`gm-revolut-webhook`, `webauthn-spike`) ont été supprimées le 2026-09-26 (Phase 1) ; le déployé et le dépôt coïncident désormais exactement.
- **Authentification & Crypto :** WebAuthn (Passkeys RP_ID `guildmanagement.vercel.app`), Discord OAuth2/Ed25519.
- **Tests :** Vitest (111 suites, 1 323 tests, 100 % passants — état vérifié au 2026-09-13 avec la réconciliation Day 0 / OCR hybride), Playwright (E2E sur port 4173), syntax-check racine et type-check TypeScript.
- **Hébergement :** Vercel (frontend statique + headers de sécurité dans `vercel.json`), Supabase Cloud (PostgreSQL, Auth, Edge Functions).

## 2. Règles d'Or & Standards d'Ingénierie
- **Stratégie de Modularisation (Strangler) :** Tout nouveau code est écrit sous forme de module TypeScript/ESM dans `/src/`. Interdiction stricte de créer de nouveaux fichiers `.js` à la racine ou d'ajouter de nouvelles variables globales sur `window.GM_*`.
- **Porte Qualité CI :** Aucun commit sans que `npm run type-check`, `npm test` (1 323 tests verts, 111 suites) et `scripts/build.js` ne soient au vert.
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
- Époque d'invalidation de session `accounts.session_version` + `public.gm_session_is_valid()` (claim JWT `app_metadata.session_version`), bumpée sur reset de mot de passe / changement de rôle / suspension (admin-accounts + shadow-session). **Réellement appliquée depuis `20260926185133` (C1)** : le contrôle est replié dans les six helpers RLS (77 références de policy) et dans `_shared/session-epoch.ts` pour les Edge Functions. Tolérant à l'absence de claim (jeton légataire) mais refusant un claim périmé — un contrôle strict aurait coupé 122 des 171 comptes au déploiement.
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
- `npm test` : **1 162 tests réussis / 102 suites** (+10 depuis 1 152) — scoring coffres (11 tests), mode granulaire EventsView (7 tests), golden i18n 551, gardes statiques plafond de score (7 tests).
- `npm run build` : production stable, `version.json` V3.18.0.
- **Déploiement requis** : `supabase db push` (migrations 20260914090000 + 20260914100000) puis push frontend (Vercel) — le push git seul n'applique pas le SQL.

## 5. Clôture Mission — Relèvement du plafond de score/gloire à 9 999 999 999 (2026-09-13)

Le plafond de tracking des scores d'événements et de gloire passe de 500 000 000 à **9 999 999 999** (migration `supabase/migrations/20260914100000_raise_event_score_limit_to_9999999999.sql`, `feat(scores)`).

### Données (migration 20260914100000)
- **Colonnes élargies en BIGINT** (INT4 plafonne à ~2.147B < 9.99B) :
  - `event_participants.score` / `score_prep` / `score_pvp` ;
  - `event_daily_scores.score` (grille granulaire Day 1-6) ;
  - `weekly_scores.glory_score`.
  - (`guild_members.glory_score` et `player_metrics_history.glory_score` étaient déjà en BIGINT.) Aucun CHECK de borne haute à modifier.
- **RPC `gm_upsert_daily_scores`** re-définie : borne par jour `<= 9 999 999 999`, sommes dérivées D1-5/D6 en `::bigint` (le cast `::integer` aurait débordé).
- **RPC `gm_upsert_player_glory`** re-définie : paramètre `p_glory bigint` (les 2 overloads `integer` supprimés), cap `LEAST(9999999999, …)`, suppression du cast d'écriture `::integer`.

### Validation & propagation
- **Constante SSOT** `supabase/functions/_shared/player-actions.ts` : `MAX_ALLOWED_EVENT_SCORE = 9_999_999_999` — propagée aux schémas Zod et `parseSafeScore` de `member-portal` et `discord-bot-interactions` (aucun doublon). Types TS inchangés (`number` sûr jusqu'à 9.99B).
- EventsView/HistoryView : aucune borne client-side à adapter (le batch granulaire transmet les valeurs telles quelles au RPC).
- Tests : gardes statiques `tests/score_limit.test.js` (cols BIGINT, bornes, zéro résiduel 500M sous `supabase/functions/` et `src/`), schémas Zod `portal_matrix` (acceptation 500 000 001 → 9 999 999 999, rejet 10 000 000 000), EventsView granulaire (score 9 999 999 999 transmis tel quel).

### État des tests (fin de mission, 2026-09-13)
- `npm run type-check` : **0 erreur**.
- `npm test` : **1 162 tests réussis / 102 suites** (+1 suite `score_limit` et +10 tests).
- `npm run build` : production stable, `version.json` V3.18.0.
- **Déploiement requis** : `supabase db push` (migration 20260914100000) + redéploiement des Edge Functions `member-portal`, `discord-bot-interactions` et `ocr-guild-members` (constante partagée).

## 6. Clôture Mission — Fiabilisation des Notifications & Rappels Discord (V3.18.1, 2026-09-13)

Audit complet du système de notifications/reminders Discord (diagnostic des fantômes quotidiens et des rappels jamais émis) suivi de la remédiation **P0 + P1** livrée en un commit `fix(reminders)`, version bump **V3.18.1** (`chore(release)`). Migration SQL déployable exclusivement via `supabase db push` : `supabase/migrations/20260914110000_fix_event_reminders_trigger_and_tz.sql` (+ redéploiement de l'Edge Function `event-reminders`).

### P0 — Notifications fantômes (partaient tous les jours alors que décochées)
- **Toggle strict** : helper unique `isToggleEnabled()` dans `supabase/functions/_shared/reminder-rules.ts` — seules `'true'`/`'1'` activent ; ligne absente/vide/`'false'`/`'0'` = **désactivé** (remplace les `config[key] === undefined || === 'true'` et `!== 'false'` par défaut-ON).
- **Écritures fiabilisées** : `setGuildConfig` ne miroite localStorage qu'après upsert réussi ; `onGuildSettingsSubmit` agrège chaque résultat d'écriture et affiche `toast_config_save_failed` au lieu d'un succès factice (échec RLS / session expirée / offline).
- **Porte globale `gvg_svs_calamity_enabled` supprimée** côté serveur — seuls les toggles d'événements font foi.
- **Webhooks isolés** : `resolveGuildWebhook` — clé de catégorie présente mais vide = catégorie coupée (silencée) ; repli sur `discord_webhook_url` uniquement si la clé spécifique n'a jamais été configurée.

### P1 — Rappels jamais émis
- **Garde cron UTC** (`gm_invoke_event_reminders`, migration 20260914110000) : `extract(dow/hour/minute FROM timezone('utc', now()))` — indépendant du timezone de session Postgres ; garde Vault `event_reminders_cron_secret` conservée avec `RAISE WARNING` explicite si le secret est absent.
- **Fenêtre SvS calendaire** : `isSvsActiveForWeek` — semaine UTC courante (start_at dans la semaine, ou session durable `war_sessions` SvS de la semaine) à la place de la fenêtre glissante 7,5 j.
- **Portail détaché de won_prep** : `portal_5`/`portal_open` gatés par `notify_svs_pvp` uniquement.
- **Noms d'événements canoniques** : `normalizeEventName`/`isStandardEventName`/`eventPrefixForName` (trim + insensible à la casse).

### État des tests (fin de mission, 2026-09-13)
- `npm run type-check` : **0 erreur**.
- `npm test` : **1 199 tests réussis / 104 suites** (+37 depuis 1 162/102 — toggles stricts, webhooks, migration SQL/TZ, cohérence SQL↔Edge, fenêtre SvS, normalisation des événements).
- `npm run build` : production stable, `version.json` V3.18.1.
- **Déploiement requis** : `supabase db push` (migration 20260914110000) + redéploiement de `event-reminders` ; puis push frontend (Vercel).

## 7. Clôture Mission — Refonte UI/UX shadcn-like P1→P3 (2026-09-13)

Cycle de modernisation complet du système UI/UX livré en 3 étapes (`feat(ui)`), 100 % frontend (aucune migration SQL, aucun changement de contrat Edge).

### Étape 1 — Primitives & tokens (fondations)
- Nouvelles deps runtime (seules) : `clsx`, `tailwind-merge`, `class-variance-authority` — aucun Tailwind/PostCSS/Vite ajouté, `scripts/build.js` intact.
- `src/core/utils/cn.ts` (helper canonique `cn()` = clsx + twMerge, résolution de conflits last-wins) et `src/core/utils/cva.ts` (re-export typé `cva` + `VariantProps` — signature **`cva(base, config)`** de la v0.7.1, base = ClassValue).
- `src/components/ui/types.ts` (`UiSize`, `UiAccent`, `UiState`).
- `theme.css` (racine, impératif build esbuild) : alias layer shadcn (`--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--ring`, `--radius-*`, …) mappé 1:1 sur le socle M3 de `tokens.css`, dark-only, chargé juste après `tokens.css` dans `index.html`.

### Étape 2 — Composants de formulaire & rétrofit Admin (P1)
- `Switch` / `Checkbox` / `Input` : inputs **natifs conservant les `id` legacy** (`byId().checked/.value`, `setChecked()`, `onGuildSettingsSubmit` inchangés), `role="switch"`, `aria-checked`, hit-slop 44 px, focus ring `var(--ring)`, recettes cva (size/accent), `Input` avec état d'erreur (`aria-invalid` + message `role="alert"`).
- Rétrofit Guild Settings : 18 toggles `notify-*` et 22 champs (`coeff-*`, `webhook-*`, `discord-role-id*`, server/tag) sur le harnais `gm-ui-*`, ids strictement stables ; CSS `gm-ui-*` dans `styles.css` (legacy `.check-toggle` conservé) ; `setChecked` synchronise désormais `aria-checked` sur les inputs `role="switch"`.

### Étape 3 — Badge & Table + vue granulaire (P2)
- `Badge` (7 tonalités dont svs/gvg/glory/danger/warning/success, styles soft/solid/outline/pill, sm/md, `renderWarStatusBadge` W/L/tie/pending) et `Table` (en-têtes sticky, alignements, états vide/chargement accessibles `role="status"`, `rowClass`/`highlight`/`rowKey`).
- Vue granulaire : statuts W/L D1-D6 en badge (bandeau + rebuils), total coffres en badge glory avec `title` valeur exacte, grilles sticky `gm-ui-table-el`/`gm-ui-table-sticky`, formatage compact `formatCompactNumber` (K/M/B, borné à 9 999 999 999, arrondi à la baisse) avec valeur exacte en tooltip. Logique métier **intacte** : `resolveChestsForScore` et RPC `gm_upsert_daily_scores`/`gm_upsert_war_session` inchangés (gardes de tests).

### Étape 4 — Dialog & Tooltip + consolidation (P3)
- `Dialog` : `role="dialog"` + `aria-modal="true"` + `aria-labelledby/describedby`, focus trap Tab bidirectionnel, fermeture Échap / backdrop / X, hooks `onConfirm`/`onCancel`/`onClose`, tone default/danger, tailles sm/md/lg/full, zone `footer` dédiée (isolation danger-zone, auto-wire `data-dialog-close`/`data-dialog-confirm`).
- `Tooltip` : singleton `#gm-ui-tooltip-root` (`role="tooltip"`), déclaratif `data-tooltip` (+`-pos`/`-delay`) via `initTooltips()`, programmatique `bindTooltip`, déclencheurs souris ET clavier (focusin/focusout), `aria-describedby`.
- Rétrofits : modale session historique → `Dialog` (surface `history-modal*` et plomb de sécurité « delete en pied de modale » conservés), boutons OCR granularisés désactivés → `data-tooltip` (attribut `title` conservé).

### État des tests (fin de mission, 2026-09-13)
- `npm run type-check` : **0 erreur**.
- `npm test` : **1 279 tests réussis / 108 suites** (+80 depuis 1 199/104 — 13 primitives/tokens, 20 composants P1 + renforts, 26 composants P2 + intégration granulaire, 21 P3 Dialog/Tooltip + rétrofits history/events/ocr).
- `npm run build` : production stable, `version.json` V3.18.1, `dist/theme.css` généré.

## 8. Clôture Mission — Réconciliation des scores de guerre Day 0 (2026-09-13)

Réconciliation entre la saisie granulaire (D1..D5) et la saisie globale (« Day 1 to 5 total ») des scores de préparation SvS/GvG, livrée en 3 lots (`feat(war)`), avec OCR hybride (total D1-5 + journalier). **Migration SQL déployable via `supabase db push`** : `supabase/migrations/20260915100000_war_aggregate_day0.sql` (+ redéploiement Edge `member-portal` et `ocr-guild-members`).

### Lot 1 — Modèle & calculs (migration en base)
- **Pseudo-jour `day = 0`** : `event_daily_scores.day` et `event_chest_tiers.day` élargis en `CHECK (day BETWEEN 0 AND 6)` — 0 = total cumulé D1-5, 1..6 = jours. `gm_save_chest_tiers` accepte le bucket day 0 (accumulateur `v_last_agg` dédié, les arrays Postgres étant 1-indexés).
- **Convergence transactionnelle** dans `gm_upsert_daily_scores` (zéro double-comptage) : passage 1 de validation + lexique d'intention par pseudo ; batch touchant `day = 0` ⇒ DELETE des lignes D1..5 (agrégat gagne en cas de mix, day 6 jamais touché) ; batch `day ∈ [1..5]` ⇒ DELETE du day 0. Dérivation cache : `score_prep = SUM(day IN (0..5))`, `score_pvp = day 6`, `score = NULL`, `participated` si prep+pvp > 0.
- **Coffres agrégés** : tranche `day = 0` de la grille figée, avec repli déterministe sur la tranche `day = 1` (miroir TS/SQL strict `aggregateTierSlice`).
- **Garde `member-portal`** : toute soumission `score_prep` ciblant une session possédant une ligne `war_sessions` est rejetée (`granular_session_use_daily`).
- **Miroir TS** (`src/core/scoring/chests.ts`) : constantes `WAR_AGGREGATE_DAY = 0`, `PREP_DAYS = [1..5]` et fonctions canoniques pures `prepTotal(playerScores)` (priorité à la somme réelle D1..5, repli day 0), `aggregateTierSlice(grid)` et `resolvePrepChests(grid, dailyScoresMap, aggregateScore)` (parité SQL 1:1) ; `defaultChestGrid()` inclut un bloc day 0 cumulatif.

### Lot 2 — Commutateur de mode & grilles
- **EventsView** : `war.mode: 'detailed' | 'aggregate'` persisté dans `guild_config` (`war_prep_mode:SvS|GvG`, défaut `detailed`) ; segmented control dans le bandeau ; vue « Cumul » = colonnes `Total D1–D5` (`data-day="0"`) + `Day 6` + Coffres ; totaux du bandeau via `prepTotal(P) + day6` (plus de double comptage) ; conversion destructive D0→D1..5 **confirmée par Dialog** (annuler ⇒ revert des inputs + aucun write, confirmer ⇒ RPC + toast `war_toast_total_replaced_days`) ; conversion inverse silencieuse + toast `war_toast_days_replaced_total` ; debounce 700 ms préservé.
- **History** : joueur agrégé rendu en cellule `colspan=5` « Total D1–D5 » (input day 0 en admin) + Day 6, coffres via `resolvePrepChests`.
- **Chest Settings** : bloc day 0 « Day 1–5 (Total) » (DAYS = 0..6, en-tête `war_day_total_prep`, validations élargies).
- i18n : +7 clés `war_*` (golden 552 → **559**).

### Lot 3 — OCR hybride
- **Réactivation OCR agrégé** : `syncWarOcrGate` supprimé définitivement (EventsView + ocr.controller) — boutons toujours cliquables ; `svs_prep`/`gvg_prep` écrivent désormais `day = 0`.
- **OCR journalier** : métriques `svs_day`/`gvg_day` (`dayRange: [1, 5]`) avec sélecteur de jour dans la modale (`#ocr-day-buttons`) ; `scanDay` validé côté Edge par `MetadataSchema.scanDay: z.number().int().min(1).max(6).optional()` (jamais d'interpolation de chaîne brute) et substitué dans le prompt via `.replace("{day}", String(scanDay))` ; `taskMetadata.scan_day`.
- **Routage des commits** (tous via `EventsService.upsertDailyScores` → `gm_upsert_daily_scores`, jamais d'écriture directe `score_prep`) : `svs_prep/gvg_prep → day 0`, `svs_day/gvg_day → day = scanDay`, `svs_pvp/gvg_pvp → day 6`, flush par lots ≤ 100 ; `dtr` reste sur le chemin legacy `event_participants` (non-régression).

### État des tests (fin de mission, 2026-09-13)
- `npm run type-check` : **0 erreur**.
- `npm test` : **1 323 tests réussis / 111 suites** (+44 depuis 1 279/108 — Lot 1 `war_aggregate_day0` : 23 ; Lot 2 `war_ui_aggregate_mode` : 9 ; Lot 3 `war_ocr_granular` : 12, + ajustements gate/OCR). Golden i18n 559.
- `npm run build` : production stable, `version.json` V3.18.1.
- **Déploiement requis** : `supabase db push` (migration 20260915100000) + redéploiement de `member-portal` et `ocr-guild-members` ; puis push frontend (Vercel).