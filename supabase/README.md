# Supabase — exploitation & source de vérité

Ce dossier est la **source de vérité** du backend (saas_strategy.md §14.1).
Production : projet `vgweufzwmfwplusskmuf`.

## Layout

```
config.toml                 Config CLI locale
functions/
  auth-login/               Login compte → session Supabase (claims app_role/account_id)
  admin-accounts/           CRUD comptes R4/R5 (R5 only, vérifié via JWT)
  event-reminders/          Rappels Discord + Web Push (tick cron chaque minute)
migrations/
  20260612000100_baseline.sql              Snapshot prod du 12/06/2026 (fresh envs only)
  20260612000200_security_hardening_p0.sql Durcissement P0 (appliqué en prod le 12/06/2026)
migrations_staged/
  …                          Migrations multi-tenant NON appliquées (voir docs/cutover-runbook.md)
```

⚠️ `migrations_staged/` est volontairement hors de `migrations/` pour qu'un
`supabase db push` ne les applique pas par accident. Elles seront déplacées
dans `migrations/` au moment du cutover multi-tenant.

## Sur un projet existant (prod)

Le baseline décrit un état déjà présent — le marquer comme appliqué :

```sh
supabase link --project-ref vgweufzwmfwplusskmuf
supabase migration repair --status applied 20260612000100
supabase migration repair --status applied 20260612000200   # déjà appliqué via MCP le 12/06/2026
```

## Sur un projet neuf (staging/dev)

```sh
supabase link --project-ref <staging-ref>
supabase db push                      # applique baseline + hardening
supabase functions deploy auth-login admin-accounts event-reminders
```

Puis recréer les dépendances hors-SQL :

1. **Vault secrets** (Dashboard → Project Settings → Vault) :
   `gm_accounts_key`, `vapid_public_key`, `vapid_private_key`, `vapid_subject`, `push_cron_secret`.
2. **Env des fonctions Edge** (Dashboard → Edge Functions → Secrets) :
   `CRON_SECRET` (= `push_cron_secret`), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
3. **Auth** : activer la protection « leaked passwords » (Dashboard → Auth → Providers → Password).
4. Le job pg_cron `event-reminders-tick` est créé par le baseline — adapter l'URL au projet.

## Notes d'exploitation

- **Cron des rappels** : job pg_cron `event-reminders-tick` (chaque minute) →
  `net.http_post` vers la fonction `event-reminders` avec le header `x-cron-secret`
  (valeur lue dans Vault). La fonction a `verify_jwt = false` (config.toml) et
  valide ce secret elle-même.
- **pg_net reste dans `public`** : dépendance active du job cron — warning advisor
  accepté (cf. 20260612000200, en-tête).
- **Mots de passe des comptes** : chiffrés `pgp_sym_encrypt` avec la clé Vault
  `gm_accounts_key` (réversibles, restitués au R5 via `gm_admin_list`).
  Le passage en hash non réversible est prévu au chantier Auth (saas_strategy.md §6).
