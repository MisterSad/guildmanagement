# 🗄️ Guide Technique — Consolidation & Squash des Migrations Supabase

Ce document détaille la procédure étape par étape pour regrouper les 156 fichiers de migration SQL actuels en **4 migrations maîtresses consolidées** sur un nouvel environnement Supabase Staging/Production.

---

## 📌 RATIONNEL

Le dossier `supabase/migrations/` compte actuellement 156 migrations générées au fil des micro-correctifs et des imports de membres. Cette fragmentation :
1. Ralentit l'exécution de `supabase db push` ou de `supabase db reset`.
2. Génère des surcharges d'OID dans Postgres lors des `CREATE OR REPLACE FUNCTION` successifs.
3. Mélange les instructions DDL (schéma) et les données de test (seeds).

---

## 📂 STRUCTURE CIBLE DU SQUASH

Le dossier `supabase/migrations/` sera ramené aux 4 migrations fondamentales suivantes :

1. `20260812000001_schema_tables_and_indexes.sql` :
   - Définition de toutes les tables (`guilds`, `accounts`, `guild_members`, `event_status`, `event_participants`, `shadowfront_squads`, `banned_players`, `guild_transfers`, `push_subscriptions`, `player_absences`, `guild_config`).
   - Clés primaires, contraintes FK et index composites multi-tenants (`idx_tenant_event_participants`).

2. `20260812000002_security_rls_policies.sql` :
   - Activation de RLS sur toutes les tables tenants.
   - Politiques d'accès étanches (Permissive SELECT unique par table, Write checks via `check_user_guild_write_access` & `is_subscription_active`).

3. `20260812000003_functions_and_rpcs.sql` :
   - Ensemble des fonctions `SECURITY DEFINER` qualifiées (`public.gm_can_read_guild_data`, `public.gm_event_session_id`, `public.transfer_guild_member`, `public.gm_cross_guild_ranking`).

4. `20260812000004_triggers_and_crons.sql` :
   - Triggers de mise à jour automatique (`updated_at`).
   - Configuration `pg_cron` pour l'envoi automatique des rappels d'événements.

---

## 🛠️ PROCÉDURE DE SQUASH ÉTAPE PAR ÉTAPE

### Étape 1 : Export du Schéma Complet depuis Staging
Dans un terminal avec la CLI Supabase installée :
```bash
supabase db dump --schema public -f docs/full_schema_dump.sql
```

### Étape 2 : Nettoyage et Séparation des Données
1. Extraire toutes les instructions `INSERT INTO guild_members` / `INSERT INTO guilds` du dump pour les placer dans `supabase/seeds/dev_seed.sql`.
2. Conserver uniquement les définitions DDL `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE`.

### Étape 3 : Remplacement des Fichiers de Migration
1. Archiver l'ancien dossier de migrations : `mv supabase/migrations supabase/migrations_archive`.
2. Créer le nouveau dossier : `mkdir supabase/migrations`.
3. Répartir le DDL dans les 4 fichiers maîtres `20260812000001_...` à `20260812000004_...`.

### Étape 4 : Validation du Nouveau Schéma
Exécuter un reset local pour valider l'application propre :
```bash
supabase db reset
npm test
```
Toutes les tables, politiques RLS et 200/200 tests Vitest doivent être entièrement au vert.
