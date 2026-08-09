# Changelog

Toutes les modifications notables de ce projet sont documentées ici.

Le CHANGELOG.md est réécrit et mis à jour à **chaque** modification : une
partie **New** (fonctionnalités) et une partie **Fixed** (corrections).
`DISCORD_CHANGELOG.md` contient la même information au format prêt à coller
sur Discord, limitée aux toutes dernières heures.

---

## New

- **Stats > page Engagement refondue** : les tuiles et graphiques sont désormais clairs. La page affiche : membres actifs cette semaine, taux moyen de participation sur 8 semaines, membres inactifs (2+ semaines), semaines avec données ; une tendance hebdomadaire (membres distincts ayant participé à au moins un événement, calculée avec la clé de scoring partagée : Arms A+B et Shadowfront comptent une fois par semaine) ; une répartition par type d'événement (SvS, GvG, Shadowfront, Arms Race, DTR) ; une liste des inactifs triée par durée d'absence avec dernière semaine d'activité et puissance.
- **Onglets Stats persistés** : le mode Stats sélectionné (Guild Health, Engagement, Roster, Operations) est mémorisé et restauré après un rechargement de page. Les sélecteurs de période/semaine sont masqués sur les onglets KPI pour éviter de revenir au classement global.
- **Sandbox multi-tenant durcie** (tous les tenants) :
  - `guildsList` chargée depuis la table `guilds` au lieu d'une liste codée en dur obsolète.
  - Defaults de colonnes `'ALPHA'` supprimés sur 6 tables : une insertion sans guilde échoue désormais au lieu d'atterrir silencieusement dans ALPHA.
  - `accounts.guild` obligatoire pour tout rôle sauf `super_admin` ; `join_code_hash` unique globalement ; grants de `gm_cross_guild_ranking` restreints.
  - DTR utilise un seul nom d'événement (`Defend Trade Route`) ; l'insertion `player_name_history` fournit la guilde.
- **Participation comptée selon les règles du jeu** (tous les tenants) : une clé de scoring partagée (`gm_event_scoring_key` / `window.GM.eventScoringKey`) régit tous les calculs. Arms Race (Stage A + B) et Shadowfront (Squad 1 + 2) comptent **une fois par semaine** ; SvS et GvG une fois par semaine ; chaque événement DTR compte séparément. Appliqué au leaderboard des stats, au classement inter-guildes, aux KPI du portail joueur et aux badges de participation.
- **Semaines Shadowfront dérivées de la date de combat** : le client et `gm_sync_shadowfront_participants` utilisent la date choisie par l'admin (`start_at`), en repli sur la date encodée dans l'ID de session. Les lignes incohérentes existantes ont été corrigées pour tous les tenants (un joueur ne peut être que dans un squad par semaine ; doublons fusionnés).
- **IDs de session lisibles et déterministes** (tous les tenants) : chaque événement porte un ID lisible et triable chronologiquement (`SVS-2026-W32`, `ARA-20260809`, `SF1-20260802`...). Relancer un événement pour la même date réutilise la session au lieu de créer un doublon fantôme. L'historique est trié du plus récent au plus ancien.
- **Badges de gamification** dans le Player Portal : rangs, ancienneté, puissance, participation, Gloire. Paliers recalibrés (ancienneté jusqu'à 2 ans, puissance jusqu'à 300M, participation jusqu'à 1500, Gloire jusqu'à 50M/semaine). La première déclaration de Gloire ne compte jamais.
- **Onglet "My Info" du portail** : puissance, Gloire en libre-service, fuseau horaire, demande de transfert. Dashboard de KPI personnels (rang puissance, percentile, Gloire, assiduité, ancienneté).
- **Paiements Stripe** : remplacement de l'ancien processeur par un checkout Stripe hébergé (création de commande, statut, webhook). Nouveaux tarifs (1M 7,99 € / 3M 19,99 € / 6M 34,99 € / 12M 59,99 €), abonnement Lifetime retiré, tuiles d'abonnement pleine largeur avec liste des moyens de paiement.
- **Join codes permanents par guilde** : un seul code par guilde, affiché en lecture seule avec copie, sans régénération. `join_code_hash` unique globalement.
- **Page de connexion statique** (sans animation 3D) avec bouton Discord communautaire et mention "Developed by HawkEye #1058".
- **Badge d'accès Portal sur les tuiles de membres** : une pastille "Portal" indique les joueurs dont le compte a été validé.
- **Tenant DEMO fictif** (serveur #0000, 200 joueurs, 4 semaines d'événements) pour captures d'écran et démos, régénérable via `scripts/generate_demo_data.py`.
- **CI GitHub Actions** (vitest + `deno check` sur les edge functions) et **`scripts/bump_cache_busters.py`** (bump automatique des `?v=`).

---

## Fixed

- **Stats : rechargement / changement de période ne ramène plus à "Weekly Global"** : le mode Stats est persisté et restauré, et les sélecteurs période/semaine sont masqués sur les onglets KPI.
- **Historique vide après la refonte des IDs** : la RPC `gm_list_event_sessions` sélectionnait `ep.session_id` avec un `GROUP BY` sur `coalesce(...)`, rejeté par PostgreSQL. La RPC sélectionne désormais l'expression `coalesce` aliasée `session_id` (nouvel OID), ce qui restaure la page pour tous les tenants.
- **Tri de l'historique** : les sessions sont toujours triées du plus récent au plus ancien (le tri ne s'exécutait que dans un cas particulier).
- **Dates d'historique avec offset `+00`** : Postgres sérialise `timestamptz` en `+00`, rejeté par `new Date()`. Les helpers de date normalisent l'offset.
- **Approve / Approve All bloqués sur "..."** : les handlers appelaient `showToast()` sans préfixe (indéfini dans le scope), ce qui interrompait le `catch` avant de restaurer le bouton. Utilisation de `window.GM.showToast` + rechargement des participants après approbation.
- **Événements actifs affichant des joueurs d'autres guildes** : avec les IDs déterministes partagés (ex. `GVG-2026-W32`), les requêtes filtrant seulement par `event_name` + `session_id` chargeaient les participants de toutes les guildes. Toutes les lectures/écritures sur `event_participants`, `event_status`, `shadowfront_squads`, `shadowfront_signups` filtrent désormais par la guilde active, et `gm_populate_event_participants` prend un `p_guild` explicite vérifié contre l'appelant. Aucune donnée cross-tenant (vérifié).
- **Fin d'un squad Shadowfront réinitialise son UI** : la composition et la disponibilité d'un squad terminé ne sont plus affichées ; un nouveau Start crée une session neuve, sans toucher à l'autre squad ni à l'historique.
- **Approbation des scores vraiment fiable** : la RPC `gm_approve_participant_submission` résout la session côté serveur et lève `is_pending`.
- **Shadowfront : participants jamais synchronisés + historique perdu à la fin** : la synchronisation passe par la base (`gm_sync_shadowfront_participants`), et terminer un squad conserve la session pour l'historique.
- **Historique : nom des squads et dates** : "Shadowfront Squad One/Two" affiché proprement, date de combat choisie à la création, pas de doublons.
- **Coverage fuseau horaire** : le ratio ne compte que les membres de la guilde active.
- **Refraîchissement de page garde l'onglet actif** : les paramètres `?checkout=` sont purgés de l'URL après le retour Stripe.
- **Auto-inscription des nouveaux membres** dans les événements actifs via RPC (au lieu d'upserts client qui échouaient sur l'index partiel).
- **Dialog UID dupliqué** : `gm_find_player_by_uid` + `gm_admin_request_transfer` pour les transferts, RLS sur `guild_transfers` durcie.
- **Règle Gloire (première déclaration exclue)** appliquée partout : badges, KPI portail, leaderboard, classement inter-guildes. Les scores nuls/vides ne comptent jamais.
- **Badges : zéro/vide exclu et paliers recalibrés** pour éviter des déblocages immédiats.

---

## Historique des versions

- **2026-08-09** — engagement Stats refondu, onglets persistés, sandbox durcie, scoring par règles du jeu, semaines Shadowfront corrigées, IDs de session lisibles, DTR unifié.
- **2026-08-08** — tenancy hardening, approbation des scores, scoping guilde, historique réparé, join codes permanents, DEMO tenant.
- **2026-08-07** — badges/portail, paiements Stripe, page de connexion, subscription, corrections Shadowfront/historique/approbation.
- **2026-08-06** — IDs de session déterministes, session IDs lisibles, login statique, plan tarifaire, auto-enroll, transferts.
- **2026-08-05** — badges (initial), onglets KPI Stats, divers fixes.
