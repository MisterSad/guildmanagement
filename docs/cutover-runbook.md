# Runbook : bascule multi-tenant (Chantier 1)

> Concerne : `supabase/migrations_staged/20990101000000_multitenant.sql`
> et `supabase/functions_staged/{auth-login,admin-accounts,event-reminders}`.
> Référence : saas_strategy.md §5. **Rien de tout cela n'est appliqué en prod.**

## Pourquoi c'est séparé

La migration, les fonctions v2 et quelques ajustements frontend forment **une
release atomique** : un frontend actuel contre un schéma migré (ou l'inverse)
casse l'application. D'où `migrations_staged/` et `functions_staged/`,
invisibles pour `supabase db push` et `functions deploy`.

## Prérequis (avant toute bascule)

- [ ] **Frontend**, petits ajustements à livrer dans la même release :
  - `app.js` : la liste des comptes ne reçoit plus `password` : retirer les
    boutons œil/copier, ajouter « Régénérer » (= action `create` sur un id
    existant, nouveau mot de passe affiché une seule fois).
  - Affichage du nom de guilde (depuis `guilds` via `select name`) dans la
    sidebar (`gm_brand_sub`), facultatif mais prêt côté RLS (`guild_self_read`).
  - Aucune autre requête ne change : le `guild_id` est posé par trigger à
    l'INSERT et filtré par RLS au SELECT.
  - Déjà livré (commit de consolidation) : la suppression de session
    d'historique est masquée pour les R4 (history.js), pour rester cohérente
    avec les policies DELETE R5-only de `event_status`/`event_participants`.
    Sans ce gate, un R4 obtiendrait une suppression partielle silencieuse.
  - **Inscription R5 par e-mail** (saas_strategy.md §6.1) : passer
    `GMT_CONFIG.R5_EMAIL_AUTH` à `true` dans `app/config.js`, déployer la
    fonction `bootstrap-r5`, et côté Supabase Auth : activer signup e-mail +
    confirmations, régler le **SMTP Resend**, et mettre Site URL +
    redirect URLs sur `…/app/` (voir `docs/email-setup.md`). Le login par
    identifiant des R4 reste inchangé (auto-routage : e-mail → Auth natif,
    identifiant → `auth-login`).
- [ ] **Staging** : projet Supabase secondaire provisionné via
  `supabase db push` (baseline + hardening) puis la migration staged ;
  secrets Vault + env recréés (cf. supabase/README.md).
- [ ] **Tests d'isolation** sur staging : créer une 2ᵉ guilde de test
  (insert `guilds` + compte), vérifier table par table et RPC par RPC
  qu'aucune donnée ne traverse ; vérifier que `read_only` bloque l'écriture
  mais pas la lecture.
- [ ] Répéter la migration sur un **clone des données prod** (dump/restore)
  et chronométrer (volumes actuels : < 10 s attendu).

## Bascule production (fenêtre calme, hors créneaux de rappels : éviter
du vendredi soir au samedi UTC)

1. **Backup** : vérifier le dernier backup/PITR Supabase + `pg_dump` manuel.
2. Annoncer ~15 min d'indisponibilité d'écriture aux R4.
3. Déplacer la migration : `git mv supabase/migrations_staged/*.sql supabase/migrations/`
   (renommer le préfixe `20990101000000` par un timestamp réel) puis `supabase db push`.
4. Déployer les fonctions : déplacer `functions_staged/*` vers `functions/` puis
   `supabase functions deploy auth-login admin-accounts event-reminders`.
5. Déployer le frontend (merge, déploiement Vercel automatique).
6. **Forcer la reconnexion** : les JWT existants n'ont pas le claim
   `guild_id`. Le plus simple : laisser les sessions expirer (1 h) ou
   invalider les refresh tokens (Dashboard > Auth) ; l'utilisateur se
   reconnecte et obtient le claim.
7. **Smoke tests prod** (compte R5 + compte R4) :
   - login puis overview (horloges OK), membres listés (133), stats semaine ;
   - démarrer/terminer un événement de test + populate ;
   - config sauvegardée ; webhook Discord testé ;
   - push : réabonnement propre (les abonnements existants ont été rattachés
     à la guilde RAD par la migration) ;
   - `node tools/i18n-check.js` et advisors Supabase (0 erreur attendu).
8. Surveiller le cron : `select * from notification_locks order by created_at desc`
   après le premier créneau de rappel.

## Rollback

- Avant l'étape 3 : rien à faire.
- Après l'étape 3 : restaurer le backup (PITR au timestamp pré-migration),
  redéployer les fonctions v1 (`supabase/functions/`) et le frontend
  précédent. Les locks/notifications émis entre-temps sont sans conséquence.

## Après bascule

- [ ] Supprimer les dossiers `*_staged/` (devenus la version courante).
- [ ] Mettre à jour `supabase/migrations/20260612000100_baseline.sql` n'est
  PAS nécessaire (le baseline reste le point d'origine ; la migration
  multi-tenant s'applique par-dessus).
- [ ] Chantiers suivants : P2 Auth R5 e-mail (saas_strategy.md §6.1),
  P5 facturation (la colonne `subscription_status` est déjà en place,
  gating RLS opérationnel via `guild_is_writable`).
