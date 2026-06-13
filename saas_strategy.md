# Guild Management Tool : Stratégie SaaS & plan d'exécution

> **Statut** : draft de travail · **Date** : 12 juin 2026
> **Base** : audit complet du code (`main`) + inspection du projet Supabase de production (schéma, RLS, fonctions Edge, advisors sécurité).
> **Objectif** : transformer l'outil interne « RAD Management Tool » en SaaS multi-guildes **« Guild Management Tool »**, abonnement **9,99 €/mois par guilde**, sans branding (logo générique limité au favicon et aux icônes d'écran d'accueil), **anglais par défaut**, français en seconde langue, architecture i18n extensible à d'autres langues.

---

## Table des matières

1. [Résumé exécutif](#1-résumé-exécutif)
2. [État des lieux (audit du 12/06/2026)](#2-état-des-lieux)
3. [Vision produit & positionnement](#3-vision-produit--positionnement)
4. [Chantier 0 : Sécurité immédiate (pré-SaaS)](#4-chantier-0--sécurité-immédiate)
5. [Chantier 1 : Multi-tenancy](#5-chantier-1--multi-tenancy)
6. [Chantier 2 : Authentification & rôles](#6-chantier-2--authentification--rôles)
7. [Chantier 3 : Internationalisation (EN défaut, FR, extensible)](#7-chantier-3--internationalisation)
8. [Chantier 4 : Facturation & abonnement](#8-chantier-4--facturation--abonnement)
9. [Chantier 5 : Légal & conformité](#9-chantier-5--légal--conformité)
10. [Chantier 6 : Dé-spécifisation produit (configurabilité)](#10-chantier-6--dé-spécifisation-produit)
11. [Chantier 7 : Rebranding « Guild Management Tool »](#11-chantier-7--rebranding)
12. [Chantier 8 : Landing page](#12-chantier-8--landing-page)
13. [Chantier 9 : Onboarding self-service](#13-chantier-9--onboarding-self-service)
14. [Chantier 10 : Industrialisation & exploitation](#14-chantier-10--industrialisation--exploitation)
15. [Économie du projet](#15-économie-du-projet)
16. [Roadmap & estimations](#16-roadmap--estimations)
17. [KPIs de pilotage](#17-kpis-de-pilotage)
18. [Risques & parades](#18-risques--parades)
- [Annexe A : Inventaire exhaustif du branding à remplacer](#annexe-a)
- [Annexe B : Schéma SQL cible (draft)](#annexe-b)
- [Annexe C : Checklist de lancement](#annexe-c)

---

## 1. Résumé exécutif

L'outil actuel est une PWA vanilla JS (~11 300 lignes, sans framework ni build) adossée à un projet Supabase unique. Il couvre déjà un périmètre fonctionnel riche et réellement utilisé en production (133 membres, ~7 700 participations enregistrées) : suivi d'événements (SvS, GvG, Defend Trade Route, Arms Race, Shadowfront avec squads et réservistes), tracker de Gloire, classements pondérés configurables, sanctions, historique, rappels Discord + Web Push automatisés.

**Le rebranding est la partie triviale (~1 jour).** Les vrais chantiers, par ordre de criticité :

| # | Chantier | Poids | Pourquoi |
|---|----------|-------|----------|
| 0 | Sécurité immédiate | 1 à 2 j | Faille critique RLS en prod aujourd'hui (voir §4) |
| 1 | Multi-tenancy | 2 à 3 sem | Aucune table n'a de `guild_id` ; tout suppose UNE guilde |
| 2 | Auth & rôles | 1 sem | Mots de passe réversibles, pas de reset, rôles non vérifiés côté serveur |
| 3 | i18n extensible | 3 à 4 j | EN par défaut, registre de langues, fichiers de locale séparés |
| 4 | Facturation 9,99 € | 1 sem | Merchant of Record recommandé (TVA UE B2C) |
| 5 | Légal & RGPD | en parallèle | CGV, confidentialité, rétractation, DPA |
| 6 | Configurabilité | 1 à 1,5 sem | Horaires de rappels codés en dur = inutilisables pour d'autres serveurs |
| 7 | Rebranding | 1 j | Inventaire précis en Annexe A |
| 8 | Landing page | 3 à 4 j | Page marketing moderne EN/FR, SEO |
| 9 | Onboarding | 3 à 4 j | Wizard de création de guilde + import CSV |
| 10 | Industrialisation | 1 sem | Migrations SQL versionnées, staging, monitoring, backups |

**Total estimé : 6 à 8 semaines équivalent temps plein** pour un produit vendable proprement.
**Point mort financier : ~4 abonnés** (coûts fixes ≈ 30 €/mois).

---

## 2. État des lieux

### 2.1 Architecture actuelle

```
┌─────────────────────────────────────────────┐
│  Frontend statique (PWA)                    │
│  index.html + 14 modules JS + 4 CSS         │
│  - i18n.js (FR/EN, ~380 clés/langue)        │
│  - sw.js (Web Push uniquement, pas de cache)│
│  - manifest.webmanifest (installable)       │
│  - cache-busting manuel ?v=N                │
│  - CDN : supabase-js, Phosphor, Google Fonts│
└──────────────────┬──────────────────────────┘
                   │ clé publishable hardcodée (rad-utils.js)
┌──────────────────▼──────────────────────────┐
│  Supabase (projet unique)                   │
│  - 11 tables (3 mortes : weekly_scores,     │
│    event_reminders_sent,                    │
│    discord_notifications_sent)              │
│  - 5 RPC Postgres (SECURITY DEFINER)        │
│  - 3 Edge Functions :                       │
│    · auth-login      (≠ pas dans le repo !) │
│    · admin-accounts  (≠ pas dans le repo !) │
│    · event-reminders (cron externe + secret)│
│  - Web Push VAPID (clé publique en dur)     │
└─────────────────────────────────────────────┘
```

### 2.2 Forces (à conserver)

- Périmètre fonctionnel complet et éprouvé en production réelle.
- i18n déjà structuré (clés `data-i18n`, fallback EN déjà en place dans `i18n.js`).
- Coefficients d'événements et webhook Discord **déjà configurables** via `guild_config` + UI ; le mécanisme à généraliser existe.
- PWA installable (icônes maskable, apple-touch-icon), Web Push opérationnel y compris iOS ≥ 16.4.
- Hygiène frontend correcte : échappement HTML systématique, validation pseudo/UID, idempotence des notifications par locks.
- Volumétrie triviale pour Postgres : le modèle single-DB multi-tenant tiendra des centaines de guildes sans effort.

### 2.3 Blocages structurels pour le SaaS

1. **Aucune isolation par guilde** : pas de `guild_id` nulle part ; `pseudo` unique globalement ; `guild_config` est un singleton.
2. **Auth inadaptée à des clients payants** : pas d'e-mail, pas de reset de mot de passe, mots de passe réversibles et affichables en clair.
3. **Horaires de jeu codés en dur** dans `event-reminders` (GvG samedi UTC fixe, SvS samedi 14:00 UTC, Calamity 16 rounds mar./mer.) : faux pour toute guilde d'un autre serveur/fuseau.
4. **2 des 3 fonctions Edge absentes du repo** ; `supabase/migrations` vide : le schéma n'existe nulle part en source.
5. Pas de staging, pas de monitoring, pas de facturation, pas de pages légales, pas de landing.

### 2.4 Failles de sécurité constatées (advisors Supabase, 12/06/2026)

| Sévérité | Constat | Impact |
|----------|---------|--------|
| **Critique** | `guild_config` : **RLS désactivé** | N'importe qui avec la clé publishable (publique par design) peut lire/écrire la config : vol/remplacement du webhook Discord, sabotage des coefficients et des locks de notifications |
| Élevé | Policies `USING (true)` pour `authenticated` sur toutes les tables métier | Tout utilisateur connecté (R4 inclus) peut tout lire/écrire/supprimer via l'API REST, indépendamment de l'UI |
| Élevé | RPC `SECURITY DEFINER` exécutables par `anon` : `save_push_subscription`, `list_event_sessions`, `check_and_send_discord_reminders` | Spam de `push_subscriptions`, lecture de l'historique sans login, déclenchement des rappels |
| Moyen | `accounts.password` (colonne texte) coexiste avec `password_enc` ; mots de passe restituables en clair | Inacceptable pour un produit payant |
| Moyen | `search_path` mutable sur 2 fonctions ; extension `pg_net` dans `public` ; protection « leaked passwords » désactivée | Durcissement standard |

---

## 3. Vision produit & positionnement

### 3.1 Proposition de valeur

> **« Run your guild like a pro. »** : l'outil de pilotage tout-en-un pour les chefs de guilde (R5) : suivi de participation aux événements, compositions d'équipes, classements pondérés équitables, rappels automatiques Discord & push. Installe-le comme une app, partage l'accès à tes officiers, et arrête de gérer ta guilde dans un tableur.

### 3.2 Cible

- **Acheteur** : le R5 (chef de guilde) : un seul payeur par guilde.
- **Utilisateurs** : R5 + officiers R4 (comptes générés par le R5, illimités).
- **Marché V1** : les guildes de *Foundation: Galactic Frontier* (même jeu, autres serveurs). L'outil reste mono-jeu en V1 ; la généralisation multi-jeux (templates d'événements) est explicitement **hors périmètre V1** mais le modèle de données doit ne pas l'interdire.

### 3.3 Offre

- **Un seul plan : 9,99 €/mois par guilde** (TTC, affichage obligatoire en B2C). Pas de plan gratuit permanent.
- **Essai gratuit 14 jours sans carte bancaire** (réduit la friction, adapté à la cible gaming).
- Annulation en self-service à tout moment ; à l'expiration : **mode lecture seule 30 jours**, puis suppression des données après préavis (jamais de suppression immédiate).

### 3.4 Nom & branding

- Nom produit : **Guild Management Tool** (descriptif, volontairement générique).
- **Aucun logo dans l'UI** : texte seul + icônes de police neutres (`ph-shield-star` déjà utilisée).
- Logo générique (écusson/bouclier abstrait) **uniquement** : favicon (onglet), icônes manifest (Android/écran d'accueil), apple-touch-icon (iOS). Voir §11.

---

## 4. Chantier 0 : Sécurité immédiate

**À faire avant tout le reste, même sans projet SaaS** (l'instance actuelle est vulnérable) :

- [ ] Activer RLS sur `guild_config` + policy `authenticated` (lecture) et restreindre l'écriture (le service_role des fonctions Edge n'est pas affecté) :
  ```sql
  ALTER TABLE public.guild_config ENABLE ROW LEVEL SECURITY;
  CREATE POLICY gc_read  ON public.guild_config FOR SELECT TO authenticated USING (true);
  CREATE POLICY gc_write ON public.guild_config FOR ALL    TO authenticated
    USING (auth.jwt() -> 'app_metadata' ->> 'app_role' = 'R5')
    WITH CHECK (auth.jwt() -> 'app_metadata' ->> 'app_role' = 'R5');
  ```
- [ ] `REVOKE EXECUTE` à `anon` sur `save_push_subscription`, `list_event_sessions`, `check_and_send_discord_reminders` (et à `authenticated` sur cette dernière si elle est legacy, la supprimer).
- [ ] Fixer `search_path` (`SET search_path = ''`) sur les fonctions signalées ; sortir `pg_net` du schéma `public`.
- [ ] Supprimer la colonne `accounts.password` (texte clair legacy) après vérification que seul `password_enc` est utilisé.
- [ ] **Rapatrier dans le repo** : sources de `auth-login` et `admin-accounts` + dump du schéma en migrations SQL (`supabase db pull`). Le repo doit devenir la source de vérité.
- [ ] Activer la protection « leaked password » de Supabase Auth.
- [ ] Rotation du webhook Discord actuel (considéré comme compromis tant que `guild_config` était ouvert en lecture anonyme).

---

## 5. Chantier 1 : Multi-tenancy

**Architecture retenue : single database + RLS par tenant** (vs un projet Supabase par client : ingérable et ruineux à 9,99 €/mois). Le `guild_id` vit dans le JWT, les policies filtrent, le frontend ne change presque pas ses requêtes.

### 5.1 Modèle de données

- [ ] Table `guilds` : `id uuid PK`, `name`, `slug`, `game_server`, `created_at`, `owner_account_id`, champs d'abonnement (`subscription_status` : `trialing | active | past_due | read_only | canceled`, `trial_ends_at`, `provider_customer_id`, `provider_subscription_id`).
- [ ] Ajouter `guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE` sur : `accounts`, `guild_members`, `event_status`, `event_participants`, `shadowfront_squads`, `sanctions`, `guild_config`, `push_subscriptions`.
- [ ] Refondre les unicités : `UNIQUE (guild_id, pseudo)` sur `guild_members` ; `UNIQUE (guild_id, event_name)` sur `event_status` ; `guild_config` passe en PK `(guild_id, key)` ; `accounts` reçoit `UNIQUE (guild_id, id)` (l'identifiant de login devient `slug/identifiant` ou l'unicité reste globale, à trancher ; recommandation : **identifiant global unique** pour garder un écran de login sans champ guilde).
- [ ] Sortir les **locks de notifications** de `guild_config` vers une table dédiée `notification_locks (guild_id, lock_key, status, created_at)` avec TTL/purge, car le mélange config/état actuel pollue la config.
- [ ] Supprimer les tables mortes après vérification : `weekly_scores`, `event_reminders_sent`, `discord_notifications_sent`.
- [ ] Schéma complet en [Annexe B](#annexe-b).

### 5.2 RLS & JWT

- [ ] `auth-login` injecte `guild_id` + `app_role` dans `app_metadata` (le mécanisme existe déjà pour `app_role`, il suffit de l'étendre).
- [ ] Policy type sur **chaque** table métier :
  ```sql
  CREATE POLICY tenant_isolation ON public.guild_members
    FOR ALL TO authenticated
    USING  (guild_id = (auth.jwt() -> 'app_metadata' ->> 'guild_id')::uuid)
    WITH CHECK (guild_id = (auth.jwt() -> 'app_metadata' ->> 'guild_id')::uuid);
  ```
- [ ] Policies différenciées par rôle là où c'est pertinent (suppression d'historique, config : R5 uniquement, voir §6.3).
- [ ] `DEFAULT` du `guild_id` via trigger ou `auth.jwt()` pour éviter de modifier chaque `INSERT` côté client.

### 5.3 RPC & fonctions Edge

- [ ] Adapter les 5 RPC (`populate_event_participants`, `list_event_weeks`, `list_event_sessions`, `save_push_subscription`, + purge éventuelle) : filtrage `guild_id` depuis le JWT, jamais en paramètre client.
- [ ] `event-reminders` : boucler sur les guildes **actives** (abonnement valide), lire le webhook Discord *de la guilde*, pousser **uniquement aux abonnés push de la guilde**, namespacer les locks par `guild_id`. Attention : aujourd'hui un rappel partirait chez tous les clients à la fois.
- [ ] `admin-accounts` : scoper création/liste/suppression au `guild_id` du R5 appelant.

### 5.4 Migration des données existantes

- [ ] Créer la guilde RAD comme tenant n°1 ; `UPDATE ... SET guild_id = <rad>` sur toutes les tables ; basculer les clés `guild_config`.
- [ ] Script de migration répétable + test sur staging avant prod.

### 5.5 Impact frontend

- Si RLS est bien fait, la majorité des requêtes `supabase.from(...)` fonctionnent telles quelles (le filtre est serveur).
- [ ] Repasser sur chaque module pour les vérifications d'unicité locales (dupliqués pseudo/UID testés côté client dans `app.js`).
- [ ] Namespacer les clés `localStorage` par guilde (`gmt_<guildId>_*`) pour éviter les fuites de préférences/config sur appareil partagé.
- [ ] Afficher le **nom de la guilde du client** dans la topbar/sidebar (remplace « Foundation Galactic Frontier »).

---

## 6. Chantier 2 : Authentification & rôles

### 6.1 Compte R5 (le client payant)

- [ ] Inscription e-mail + mot de passe (Supabase Auth natif) avec vérification d'e-mail.
- [ ] **Réinitialisation de mot de passe** (inexistante aujourd'hui, bloquant absolu pour un produit payant).
- [ ] Page « Mon compte » : e-mail, mot de passe, langue, suppression de compte (RGPD).

### 6.2 Comptes R4 (officiers)

- Conserver le modèle « identifiant + mot de passe générés par le R5 » (bon fit pour la cible), **mais** :
- [ ] Hash non réversible (bcrypt/argon2 dans la fonction Edge) ; suppression de `password_enc`/`gotrue_secret_enc` réversibles.
- [ ] Le bouton « œil » (mot de passe restituable) disparaît, remplacé par **« Régénérer le mot de passe »** (affiché une seule fois à la création/régénération).
- [ ] Quota raisonnable de comptes R4 par guilde (ex. 20) pour borner les abus.

### 6.3 Rôles côté serveur

- [ ] Matrice de permissions appliquée **en RLS/Edge**, plus seulement en UI :

| Action | R5 | R4 |
|---|---|---|
| Config guilde (coefficients, webhook, horaires) | ✅ | ❌ |
| Gestion comptes R4 | ✅ | ❌ |
| Facturation / abonnement | ✅ | ❌ |
| Suppression de sessions d'historique | ✅ | ❌ (aujourd'hui possible !) |
| Membres, événements, scores, squads, sanctions | ✅ | ✅ |
| Consultation stats | ✅ | ✅ |

- [ ] Rate limiting sur `auth-login` (aucun frein au brute-force actuellement) + verrouillage progressif.

---

## 7. Chantier 3 : Internationalisation

**Exigences** : anglais par défaut, français disponible, et une architecture où **ajouter une langue = ajouter un fichier**, sans toucher au code.

### 7.1 État actuel (précis)

- `i18n.js` : un seul fichier, objet `TRANSLATIONS = { fr: {...}, en: {...} }`, ~380 clés par langue, API `t() / setLang() / applyTranslations()` sur attributs `data-i18n`, `data-i18n-placeholder`, `data-i18n-title`.
- ✅ Le défaut code est **déjà** `'en'` (`localStorage 'rad_lang' || 'en'`) et le fallback des clés manquantes est déjà EN.
- ❌ Mais l'« ambiance » par défaut est française : `<html lang="fr">`, `manifest "lang": "fr"`, textes statiques du HTML en français (flash de français avant `applyTranslations()`), bouton FR actif par défaut sur l'écran de login, dates formatées en dur `'fr-FR'` à plusieurs endroits (`app.js`, `formatWeek`), `formatNumber` utilise l'espace (style FR) comme séparateur de milliers quel que soit la langue.
- ❌ Sélecteurs de langue **codés en dur** (boutons FR/EN) à 3 endroits : login (HTML), topbar (HTML), sidebar (`shell.js:253-268`).

### 7.2 Architecture cible

```
locales/
  en.js          ← langue source (référence, toujours complète)
  fr.js
  de.js          ← exemple d'ajout futur
  index.js       ← registre des langues disponibles
i18n.js          ← moteur : registre + chargement + fallback + formats
```

> **Écart d'implémentation (12/06/2026)** : fichiers de locale en `.js`
> (objet enregistré sur `window.GMT_LOCALES`) plutôt qu'en `.json` : sur un
> site statique sans build, le chargement par balise `<script>` est
> synchrone et déterministe (pas de course fetch/render au boot), tout en
> gardant la propriété clé : *ajouter une langue = un fichier + une entrée
> de registre*. Conversion JSON triviale si un bundler arrive un jour.

**Registre** (`locales/index.js`), la seule déclaration d'une langue :

```json
[
  { "code": "en", "label": "English",  "flag": "🇬🇧" },
  { "code": "fr", "label": "Français", "flag": "🇫🇷" }
]
```

**Principes :**

1. **`en.json` = source de vérité.** Toute nouvelle clé y naît ; les autres langues retombent sur EN tant qu'elles ne sont pas traduites (comportement de fallback déjà en place, à conserver).
2. **Un fichier JSON par locale**, chargé à la demande (`fetch` + cache). EN embarqué/préchargé pour éliminer tout flash de contenu non traduit.
3. **Codes BCP-47** (`en`, `fr`, `de`, `pt-BR`…) pour permettre les variantes régionales plus tard.
4. **Détection de langue** à la première visite : `localStorage`, puis `navigator.languages` (premier match avec le registre), sinon `en`. Persistance : clé `localStorage` unique (renommée `gmt_lang`, avec migration de l'ancienne `rad_lang`).
5. **Sélecteur de langue généré depuis le registre** (dropdown, plus une paire de boutons en dur) : un seul composant monté aux 3 emplacements actuels. Ajout d'une langue = zéro modification de l'UI.
6. **`<html lang>` mis à jour dynamiquement** au switch (accessibilité, lecteurs d'écran) ; `manifest "lang": "en"`.
7. **Tous les textes statiques du HTML passent en anglais** (valeurs par défaut avant traduction), ce qui supprime le flash FR et aligne le défaut.
8. **Dates & nombres via `Intl`** avec table de correspondance (`en` donne `en-GB`, `fr` donne `fr-FR`…) : remplacer les `'fr-FR'` en dur et `formatNumber` par `Intl.NumberFormat(locale)`. Les heures d'événements restent affichées **en UTC** (convention du jeu, à conserver : c'est un choix produit, pas un bug).
9. **Pluriels** : `Intl.PluralRules` pour les rares clés concernées (compteurs) ; convention de clés `key_one` / `key_other`.
10. **Pas de framework i18n externe** : le moteur actuel (~60 lignes) suffit, il s'agit de le restructurer, pas de le remplacer.

### 7.3 Process documenté « ajouter une langue »

1. Dupliquer `locales/en.js` en `locales/xx.js`, traduire.
2. Ajouter une entrée dans `locales/index.json`.
3. Vérifier avec le script `tools/i18n-check.js` (à créer : détecte clés manquantes/orphelines par rapport à `en.json`).
4. C'est tout : le sélecteur, le fallback et la détection prennent la langue en compte automatiquement.

- [ ] Option future : externaliser la traduction communautaire (Crowdin/Weblate ou simplement PR GitHub depuis le Discord de support ; la cible gaming traduit volontiers).
- [ ] Langues candidates post-V1, par taille de marché du jeu : **de, es, pt-BR, it, tr, ko, ja**. (RTL type arabe : non prévu V1 ; noter que le CSS actuel n'est pas RTL-ready, à traiter le jour venu.)

### 7.4 Périmètres i18n distincts

| Périmètre | Mécanisme |
|---|---|
| **App** | `locales/*.json` + moteur runtime (ci-dessus) |
| **Landing page** | Pages statiques **par langue** (`/` EN, `/fr/`) avec `hreflang`, car le SEO exige du contenu indexable, pas du JS runtime (voir §12) |
| **Notifications Discord** | Restent **EN uniquement** en V1 (lingua franca des serveurs de jeu) ; configurable par guilde post-V1 |
| **Notifications push** | Titre/corps générés côté serveur : EN en V1 ; clé `notification_lang` par guilde post-V1 |
| **E-mails transactionnels** (vérification, reset, facturation) | Templates EN + FR dès la V1 (e-mails Supabase Auth personnalisables) |
| **Pages légales** | EN + FR (la version FR fait foi pour les CGV si société française, à valider juridiquement) |

---

## 8. Chantier 4 : Facturation & abonnement

### 8.1 Choix du prestataire de paiement

| Option | Avantages | Inconvénients | Verdict |
|---|---|---|---|
| **Merchant of Record** (Paddle, Lemon Squeezy) | Il est le vendeur légal : **TVA UE gérée**, factures conformes, SCA, litiges | ~5 % + frais fixes ; moins de contrôle | ✅ **Recommandé** pour un solo à 9,99 € B2C |
| Stripe Billing | Standard, frais plus bas (~1,5 à 2,9 %) | **Toi** = redevable de la TVA de chaque pays UE, d'où l'immatriculation **OSS**, facturation conforme, déclarations trimestrielles | Pertinent seulement si volume important ou aversion aux MoR |

**Décision proposée : Paddle ou Lemon Squeezy en V1.** Migration Stripe possible plus tard si le volume le justifie.

### 8.2 Intégration technique

- [x] **Prestataire retenu : Paddle (Merchant of Record).** Intégration livrée mais inerte (placeholders config + table `guilds` staged), prête à brancher une fois le domaine + compte validés. Runbook : `docs/paddle-setup.md`.
- [x] Fonction Edge `billing-webhook` (staged) : vérifie la signature Paddle (HMAC-SHA256 `ts:rawBody`, tolérance anti-rejeu) et met à jour `guilds.subscription_status` + `provider_*`/`management_url`/`trial_ends_at`.
- [x] Checkout hébergé Paddle.js (overlay, `custom_data.guild_id`) ; portail client via `management_url` fourni par le webhook. Aucun scope PCI côté app.
- [x] Page « Abonnement » dans l'app (`app/billing.js`) : statut, essai restant, bandeau impayé/lecture seule, bouton S’abonner/Gérer. Dégradation propre en prod (table `guilds` absente) et tant que Paddle non configuré.

### 8.3 Cycle de vie & gating

```
signup -> trialing (14 j, sans CB)
       -> active        (paiement OK)
       -> past_due      (échec paiement : relances PSP, accès complet 7 j)
       -> read_only     (lecture seule 30 j, les données restent visibles)
       -> canceled      (export proposé, purge après préavis 60 j)
```

- [ ] **Gating par RLS, pas par UI** : quand `subscription_status ∈ {read_only, canceled}`, les policies n'autorisent que `SELECT`. Astuce robuste : une seule fonction SQL `guild_is_writable(guild_id)` référencée par toutes les policies d'écriture.
- [ ] Bandeau d'état dans l'app (essai restant, paiement échoué, lecture seule) + e-mails de relance (J-3 fin d'essai, échec paiement).

---

## 9. Chantier 5 : Légal & conformité

- [ ] **Statut juridique** : micro-entreprise suffisante au démarrage (plafond confortable vs objectif de revenus) ; mention SIRET dans les mentions légales. Avec un MoR, c'est lui qui encaisse la TVA ; tes revenus sont des reversements.
- [ ] **Documents** (EN + FR) : CGV/CGU, politique de confidentialité, mentions légales, politique cookies (actuellement aucun tracker tiers, donc pas de bannière nécessaire ; **à préserver** en choisissant une analytics sans cookies, cf. §12.4).
- [ ] **Droit de rétractation 14 jours** (B2C UE) : case de renonciation explicite pour exécution immédiate au checkout (les MoR la gèrent nativement).
- [ ] **RGPD** :
  - Registre des traitements (pseudos de joueurs, e-mails R5, données de participation).
  - DPA signés : Supabase (région **UE** du projet à vérifier/choisir), PSP, hébergeur statique.
  - Droits des personnes : export des données de guilde (CSV/JSON) + **suppression de tenant** en self-service (cascade DB déjà cohérente grâce aux FK `ON DELETE CASCADE`).
  - Durées de conservation documentées (purge à `canceled` + 60 j).
  - Attention : les pseudos/UID de joueurs sont des données personnelles de **tiers** (les membres ne sont pas tes clients) : le R5 est responsable de son usage, ton rôle est celui de sous-traitant ; le préciser dans les CGU.

---

## 10. Chantier 6 : Dé-spécifisation produit

Tout ce qui est vrai pour la guilde RAD mais faux pour les autres :

- [x] **Horaires de rappels par guilde** (le plus critique) : table `guild_event_schedules (guild_id, kind, label, day_utc, time_utc, reminder_offsets[], requires_event, enabled)` + UI de configuration avec **templates pré-remplis** (les horaires actuels deviennent le template par défaut). `event-reminders` devient un moteur générique qui lit la table. Couvre GvG (créneaux War Prism/War Fortress), SvS (garnison + bataille), Calamity (16 rounds), et les rappels d'événements planifiés (déjà génériques via `start_at`). **Fait** : table + seeds dans la migration staged ; moteur `event-reminders` v2 staged ; éditeur R5 `app/reminders.js` (CRUD + template par défaut). La table étant staged, l'éditeur **se dégrade proprement** en prod (avis « activé avec la mise à jour multi-tenant », vérifié : table absente de la prod) et pilotera l'horaire réel après la bascule.
- [ ] **Horloges de l'overview** : remplacer les 5 membres codés en dur (`overview.js` : Natalie, HawkTuah, Phantom, Vaylah, BroKen + offsets) par un champ `timezone` optionnel sur `guild_members` (l'UI affiche ceux qui en ont un).
- [x] **Paramètres par guilde** (étendre `guild_config`, mécanisme existant) : limites Shadowfront (20 participants + 10 réservistes), seuils de catégories (80/50/20 %), poids de la formule de score (α=6 participation / β=4 performance, bonus Gloire 20 pts, bonus régularité 15 pts @ 80 %), seuil d'alerte récidiviste sanctions (3). **Fait** : tous exposés dans la section « Paramètres avancés » de la config R5, lus via `guild_config` avec défauts égaux aux valeurs d'origine (effet sur la prod actuelle, zéro changement tant que non édités). Câblés dans `stats.js` (poids `W`), `shadowfront.js` (limites + seuils), `sanctions.js` (récidive).
- [ ] **Événements activables/désactivables par guilde** (toutes ne jouent pas tout) : table `guild_events_enabled` ou clé de config ; les onglets/nav se construisent dynamiquement (impact `shell.js` NAV_ITEMS/EVENT_TABS, `index.html` panneaux).
- [ ] Conserver les **noms d'événements du jeu** (SvS, GvG, Shadowfront, DTR, Arms Race, Glory) comme vocabulaire produit V1, puisque c'est le même jeu pour tous les clients. Le renommage libre par guilde est un piège (casse stats/historique) : ne pas l'offrir en V1.

---

## 11. Chantier 7 : Rebranding

### 11.1 Principe

- Nom : **« Guild Management Tool »** partout où « RAD MANAGEMENT (TOOL) » apparaît.
- **Aucun logo dans l'UI** (login et sidebar affichent aujourd'hui une image, à remplacer par texte ou icône de police).
- Logo générique (écusson abstrait, lisible en 16×16 et en maskable) **uniquement** dans : `favicon.png`, `icon-192/512(+maskable).png` (manifest, Android), `apple-touch-icon.png` (iOS).
- Inventaire exhaustif fichier par fichier : **[Annexe A](#annexe-a)**.

### 11.2 À produire

- [ ] 1 logo générique SVG source, décliné en PNG (16/32/180/192/512 + maskable avec safe zone 80 %).
- [ ] Mise à jour `manifest.webmanifest` (name « Guild Management Tool », short_name « Guild Tool », description EN, lang `en`).
- [ ] Régénérer ou supprimer les sets natifs `android/` et `apple-devices/` (vérifier s'ils servent à un wrapper TWA/Capacitor ; sinon les retirer du repo).
- [ ] Renommages internes cosmétiques (renommer `window.RAD*` en `window.GMT*` et les clés `localStorage` `rad_*` en `gmt_*`, avec migration) : **non bloquants**, à faire opportunément pendant le chantier multi-tenant.

---

## 12. Chantier 8 : Landing page

### 12.1 Objectifs

1. Expliquer ce que fait l'outil en < 10 secondes (un R5 doit se reconnaître immédiatement).
2. Convertir vers l'essai gratuit (CTA unique : **Start free trial**).
3. SEO sur les requêtes type *« guild management tool »*, *« guild event tracker »*, *« [nom du jeu] guild tracker »*.
4. Crédibiliser : captures d'écran réelles (données de démo anonymisées), pas de stock photos.

### 12.2 Architecture & URLs

```
/            -> landing EN (défaut)
/fr/         -> landing FR (hreflang en/fr, x-default = EN)
/app/        -> l'application PWA (manifest scope/start_url = /app/)
/legal/...   -> CGU, confidentialité, mentions (EN + FR)
/pricing     -> ancre ou page dédiée
```

- Landing **à la racine**, app déplacée sous `/app/` (un seul déploiement statique, un seul domaine). Alternative : `app.domaine.tld`, à trancher au moment du choix du domaine ; la racine `/app/` est plus simple (un seul certificat, un seul projet d'hébergement). Attention aux impacts : `manifest start_url/scope`, chemins d'icônes ; les PWA déjà installées (la tienne) devront être réinstallées.
  > **Écart d'implémentation (12/06/2026)** : `sw.js` reste à la **racine**
  > (scope `/`) au lieu de `/app/sw.js`, ce qui préserve les enregistrements
  > service worker existants et les 11 abonnements push actifs (un
  > changement de chemin de SW les aurait orphelinés). Les clics de
  > notification ouvrent `/app/`.
- [ ] Acheter le domaine (ex. `guildmanagementtool.app` ou `.io`) + e-mail de support associé.

### 12.3 Structure de page (sections, copy EN draft)

1. **Nav sticky** : wordmark texte « Guild Management Tool » · Features · Pricing · FAQ · sélecteur de langue · bouton **Log in** + CTA **Start free trial**.
2. **Hero** : titre *« Run your guild like a pro »* ; sous-titre *« Track event participation, build squads, rank your members fairly, and never miss a battle, with automatic Discord & push reminders. »* ; CTA primaire *Start your 14-day free trial* (+ mention *No credit card required*) ; visuel : capture du dashboard (dark) dans un cadre device.
3. **Bandeau preuve** : *« Built by an R5, for R5s, battle-tested on a 130-member guild »* + 3 chiffres (events tracked, reminders sent, members managed).
4. **Features** (grille 6, icônes Phosphor) :
   - *Event tracking* : SvS, GvG, Shadowfront, Defend Trade Route, Arms Race: start a session, tick participation, enter scores.
   - *Squad builder* : Shadowfront compositions with participants & reserves, smart suggestions based on attendance history.
   - *Fair leaderboards* : weighted weekly rankings with configurable coefficients, reserve credit, glory progression and consistency bonuses.
   - *Glory tracker* : weekly glory per member with automatic evolution.
   - *Discord & push reminders* : automatic alerts before every battle, on your schedule, in your timezone.
   - *Sanctions log* : keep track of no-shows and repeat offenders.
5. **How it works** (3 étapes) : *Create your guild*, *Import your roster (CSV)*, *Invite your officers*.
6. **App install** : *« Works like an app »* : PWA installable iOS/Android, push notifications, no app store needed.
7. **Pricing** (carte unique) : 9,99 €/month per guild · unlimited members & officers · all features · cancel anytime · 14-day free trial.
8. **FAQ** (6 à 8 questions) : Which game is it for? · Do my members need accounts? (non, seuls R5/R4 se connectent) · Can I cancel anytime? · What happens to my data if I stop paying? (read-only 30 j, export, purge) · Is my data safe? (isolation par guilde, hébergement UE) · What languages are supported? (EN/FR, more coming) · Can I export my data?
9. **CTA final** + **Footer** : liens légaux, contact, sélecteur de langue, *« Not affiliated with the game publisher »* (**mention importante** : marques du jeu = propriété de l'éditeur ; rester descriptif, ne pas utiliser logos/assets du jeu).

### 12.4 Implémentation

- [ ] HTML/CSS statique pur, **réutilise `tokens.css`** (cohérence visuelle app/landing), même esthétique dark glassmorphism, Phosphor icons. Pas de framework.
- [ ] Performance : Lighthouse ≥ 90 mobile, images WebP/AVIF lazy, fonts en `font-display: swap` (idéalement auto-hébergées, ce qui supprime aussi la dépendance Google Fonts côté RGPD).
- [ ] SEO : balises OG/Twitter, sitemap.xml, robots.txt, `hreflang`, données structurées `SoftwareApplication` (prix, note plus tard).
- [ ] Captures d'écran : générer un **tenant de démo** avec pseudos fictifs (servira aussi aux tests et au support).
- [ ] Analytics **sans cookies** (Plausible/Umami self-host léger), donc pas de bannière de consentement, page conversion mesurable.
- [ ] i18n landing : fichiers HTML par langue générés (copie maintenue à la main en V1 pour 2 langues ; script de génération si > 3 langues).

---

## 13. Chantier 9 : Onboarding self-service

Parcours cible (du clic « Start free trial » à la valeur) :

1. **Signup** e-mail + mot de passe, puis vérification e-mail.
2. **Wizard de création de guilde** (3 écrans max) :
   - Nom de la guilde (+ serveur/fuseau de référence pour l'affichage des heures) ;
   - Événements joués (cases à cocher, tout coché par défaut) + **horaires depuis templates** (pré-remplis, modifiables plus tard) ;
   - Webhook Discord (optionnel, avec lien d'aide « comment créer un webhook »).
3. **Import des membres** : CSV/coller une liste (pseudo[, UID]) avec aperçu et validation (*à construire, n'existe pas*) ; saisie manuelle possible.
4. **Invitation des R4** : génération des comptes (mécanisme existant, sécurisé cf. §6.2).
5. **Checklist de démarrage** dans l'overview (3 items : membres importés, webhook testé, premier événement lancé), qui disparaît une fois complétée.

- [ ] E-mails du cycle d'essai : bienvenue (J0), astuce (J3), rappel fin d'essai (J-3), dernier jour (J14). **Prestataire retenu : Resend** (fonction Edge `send-email` livrée, gated par `x-email-secret`), `Reply-To` = `fgfguildmanagementtool@proton.me` (boîte support Proton). FROM de prod = domaine vérifié sur Resend ; SMTP Resend pour les e-mails Auth Supabase. Voir `docs/email-setup.md`.

---

## 14. Chantier 10 : Industrialisation & exploitation

### 14.1 Code & environnements

- [ ] **Repo = source de vérité** : fonctions Edge complètes (`auth-login`, `admin-accounts` manquantes !), migrations SQL versionnées dans `supabase/migrations/` (actuellement vide), seed du tenant de démo.
- [ ] **Staging** : second projet Supabase (ou Supabase Branching) + déploiement préprod du statique. Ne plus jamais développer contre la base des clients.
- [x] Validation gratuite sans service CI : hook git `pre-push` (`.githooks/pre-push`) + hook SessionStart, qui lancent `node tools/check.js` (syntaxe JS, `i18n-check`, intégrité des références d'assets). **GitHub Actions volontairement écarté** (facturation). Le déploiement auto (statique + `supabase db push` + `functions deploy`) reste à brancher — Vercel gère déjà le statique sur push ; les migrations/fonctions Supabase se déploieront via un script de release, pas via Actions.
- [ ] Remplacer le cache-busting manuel `?v=N` par un micro-build avec hash des assets, le système actuel étant une source d'erreurs humaines récurrente.
- [ ] Config par environnement : URL/clé Supabase et clé VAPID sorties du code (`config.js` généré au déploiement) ; actuellement hardcodées dans `rad-utils.js`/`push.js`.

### 14.2 Exploitation

- [ ] **Monitoring du cron `event-reminders`** (le service le plus critique : s'il meurt un vendredi soir, 100 % des clients ratent leur SvS) : heartbeat (healthchecks.io/cron-job.org) + alerte e-mail/Discord en cas d'échec ou d'absence d'exécution.
- [ ] Sentry (ou équivalent léger) sur le frontend + logs des fonctions Edge surveillés.
- [ ] Uptime monitoring du domaine ; page de statut minimaliste (instatus/upptime gratuit).
- [ ] **Backups** : PITR Supabase (plan Pro) + export hebdomadaire externe testé (une restauration vérifiée > dix sauvegardes supposées).
- [ ] **Support** : e-mail `fgfguildmanagementtool@proton.me` (boîte Proton, réception immédiate, déjà en contact sur la landing/légal) + **serveur Discord de support** (culturellement idéal pour la cible ; canal #announcements pour les maintenances). Docs : 8 à 10 articles courts avec captures (créer sa guilde, importer, webhook, horaires, comptes R4, facturation, export, suppression).

---

## 15. Économie du projet

### 15.1 Coûts fixes mensuels (V1)

| Poste | €/mois |
|---|---|
| Supabase Pro (obligatoire : pas de pause projet, PITR, support) | ~23 € |
| Hébergement statique (Vercel/Cloudflare Pages) | 0 € |
| Domaine (~12 €/an) | ~1 € |
| E-mail transactionnel (free tier) | 0 € |
| Monitoring/statut (free tiers) | 0 € |
| **Total** | **~25 à 30 €** |

Frais variables : MoR ~5 % + ~0,50 €/transaction, soit **~8,9 € nets par abonné**.

### 15.2 Point mort & projections

- **Break-even : 4 abonnés.**
- 10 guildes ≈ 89 €/mois · 50 ≈ 445 €/mois · 100 ≈ 890 €/mois (avant impôts/cotisations micro-entreprise ~22 % BNC).
- La volumétrie DB reste négligeable (≈ 60 k lignes/an pour 100 guildes au rythme actuel de RAD).

### 15.3 Validation avant d'industrialiser (recommandé)

Phase « concierge » : proposer l'outil à 2 à 3 R5 connus en échange de feedback (copies manuelles du projet Supabase, faisable à la main à cette échelle). Si personne ne paierait 9,99 €, le chantier multi-tenant aura été évité ; si ça mord, il devient un investissement sûr. Cette phase peut tourner **en parallèle** des chantiers 0 et 2.

---

## 16. Roadmap & estimations

| Phase | Contenu | Durée | Jalon livrable |
|-------|---------|-------|-----------------|
| **P0** | Sécurité immédiate (§4) + repo source de vérité | 1 à 2 j | Prod actuelle sécurisée |
| **P1** | Multi-tenancy complet (§5) + migration RAD | 2 à 3 sem | 2 guildes de test isolées sur staging |
| **P2** | Auth R5 e-mail + reset + hash R4 + rôles serveur (§6) | 1 sem | Signup/login/reset fonctionnels |
| **P3** | i18n cible (§7) : EN défaut, locales JSON, sélecteur dynamique | 3 à 4 j | `de.json` de test ajouté sans toucher au code |
| **P4** | Configurabilité (§10) : horaires par guilde, paramètres, événements activables | 1 à 1,5 sem | Une guilde fictive avec planning différent reçoit les bons rappels |
| **P5** | Facturation (§8) + cycle de vie + gating RLS | 1 sem | Paiement test bout-en-bout, lecture seule vérifiée |
| **P6** | Rebranding (§11) + landing (§12) + onboarding (§13) + légal (§9) | 1,5 sem | Site public + wizard + docs légales |
| **P7** | Industrialisation (§14) : staging/CI/monitoring/backups/support | 1 sem (étalée) | Checklist de lancement (Annexe C) verte |
| **Lancement** | Bêta fermée 3 à 5 guildes (2 sem), puis ouverture | - | - |

**Total : 6 à 8 semaines ETP.** Ordre conçu pour que chaque phase soit utile même si la suivante glisse.

---

## 17. KPIs de pilotage

- **Acquisition** : taux de passage des visiteurs de la landing à l'inscription d'essai (cible > 5 %), source (Discord communautaires, Reddit du jeu, bouche-à-oreille).
- **Activation** : % d'essais qui importent ≥ 10 membres ET lancent ≥ 1 événement la première semaine (le vrai prédicteur de conversion).
- **Conversion de l'essai vers le payant** (cible 25 à 40 % sur cette cible de niche).
- **Rétention/churn mensuel** (cible < 5 % ; attention au churn saisonnier lié à la vie du jeu).
- **Santé technique** : taux de succès du cron reminders (cible 100 %), uptime, erreurs Sentry.
- **Support** : tickets/guilde/mois, délai de première réponse.

---

## 18. Risques & parades

| Risque | Probabilité | Impact | Parade |
|---|---|---|---|
| Dépendance à un seul jeu (déclin, fermeture, refonte des événements) | Moyenne | Élevé | Modèle de données ne verrouillant pas le multi-jeux ; veille sur le jeu ; diversification post-V1 |
| Réaction de l'éditeur du jeu (marques, ToS) | Faible | Moyen | Aucun asset du jeu, mention « not affiliated », noms d'événements descriptifs |
| Fuite inter-tenants (bug RLS) | Faible si testé | Critique | Tests automatisés d'isolation (2 tenants de test, suite qui vérifie chaque table/RPC) avant tout déploiement |
| Panne du cron de rappels | Moyenne | Élevé (cœur de la valeur) | Heartbeat + alerte + double scheduler (§14.2) |
| Un seul mainteneur (bus factor) | - | Élevé | Repo = source de vérité, docs d'exploitation, infra simple |
| Concurrence (tableurs, bots Discord gratuits) | Moyenne | Moyen | Positionnement « tout-en-un installable » ; l'essai gratuit fait la démonstration |
| Churn d'impayés mal géré, avec perte de données client | Faible | Élevé | Lecture seule 30 j + export + purge à 60 j seulement |

---

<a name="annexe-a"></a>
## Annexe A : Inventaire exhaustif du branding à remplacer

| Fichier | Emplacement | Contenu actuel | Action |
|---|---|---|---|
| `index.html` | `<title>` | « RAD MANAGEMENT TOOL » | « Guild Management Tool » |
| `index.html` | `<meta description>` | « …for Foundation Galactic Frontier » | Description générique EN |
| `index.html` | `<html lang>` | `fr` | `en` (puis dynamique, §7.2) |
| `index.html` | `apple-mobile-web-app-title` | « RAD MGMT » | « Guild Tool » |
| `index.html` | login : `.gm-avatar-xl` | `<img apple-touch-icon>` (logo **dans l'UI**) | Supprimer l'image au profit d'une icône de police neutre |
| `index.html` | login : titre/sous-titre | « RAD MANAGEMENT » / « Foundation Galactic Frontier » | Nom produit / **nom de la guilde du client** |
| `index.html` | topbar ×2 : `<h2>` | « RAD MANAGEMENT TOOL » | Nom produit |
| `index.html` | member view | « …espace membre de **RAD Management** » | Variable guilde |
| `index.html` | textes statiques | défauts en français | défauts en anglais (§7.2) |
| `manifest.webmanifest` | name/short_name/description/lang | « RAD Management Tool » / « RAD MGMT » / fr | Nom produit / « Guild Tool » / `en` |
| `i18n.js` | `login_title`, `login_subtitle`, `gm_brand`, `gm_brand_sub`, `members_subtitle`, `gm_overview_sub`, `gm_overview_sub_real` (FR+EN) | « RAD MANAGEMENT » / « Foundation Galactic Frontier » | Nom produit / nom de guilde dynamique |
| `sw.js` | titre par défaut des notifications | « RAD Management » | Nom produit |
| `rad-utils.js` | footer embeds Discord + `embedDesc` | « RAD Management Tool » | Nom produit (visible par **tous les Discord clients**) |
| `supabase/functions/event-reminders/index.ts` | footers embeds ×4 + `embedDesc` | idem | idem |
| `shell.js` | brand sidebar (`apple-touch-icon.png` + libellés) | logo **dans l'UI** + « RAD MANAGEMENT » | Texte seul / icône police |
| `overview.js` | horloges membres en dur | 5 pseudos + fuseaux de la guilde RAD | Données par guilde (§10) |
| Icônes racine | `favicon.png`, `icon-192/512(+maskable).png`, `apple-touch-icon.png` | logo RAD | **Logo générique** (seuls emplacements où un logo subsiste) |
| `android/`, `apple-devices/` | sets d'icônes natives complets | logo RAD | Régénérer ou supprimer si aucun wrapper ne les consomme |
| Interne (non visible) | `window.RAD*`, `localStorage rad_*`, commentaires | préfixes « rad » | Renommage opportuniste avec migration des clés |

---

<a name="annexe-b"></a>
## Annexe B : Schéma SQL cible (draft)

```sql
-- Tenants
CREATE TABLE guilds (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                      text NOT NULL,
  slug                      text UNIQUE NOT NULL,
  game_server               text,
  display_timezone          text DEFAULT 'UTC',
  subscription_status       text NOT NULL DEFAULT 'trialing'
    CHECK (subscription_status IN ('trialing','active','past_due','read_only','canceled')),
  trial_ends_at             timestamptz,
  provider_customer_id      text,
  provider_subscription_id  text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

-- guild_id sur toutes les tables métier (exemple)
ALTER TABLE guild_members      ADD COLUMN guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE;
ALTER TABLE guild_members      DROP CONSTRAINT guild_members_pseudo_key,
                               ADD CONSTRAINT guild_members_guild_pseudo_key UNIQUE (guild_id, pseudo);
-- idem : accounts, event_status (UNIQUE guild_id+event_name), event_participants,
--        shadowfront_squads, sanctions, push_subscriptions

-- Config par guilde
ALTER TABLE guild_config ADD COLUMN guild_id uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE;
ALTER TABLE guild_config DROP CONSTRAINT guild_config_pkey,
                         ADD PRIMARY KEY (guild_id, key);

-- Locks de notifications (sortis de guild_config)
CREATE TABLE notification_locks (
  guild_id   uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  lock_key   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('sending','sent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, lock_key)
);

-- Horaires de rappels par guilde (remplace le hardcodé d'event-reminders)
CREATE TABLE guild_event_schedules (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id         uuid NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  event_key        text NOT NULL,          -- 'gvg_war_prism', 'svs_battle', 'calamity_round', ...
  day_utc          smallint NOT NULL CHECK (day_utc BETWEEN 0 AND 6),
  time_utc         time NOT NULL,
  reminder_offsets integer[] NOT NULL DEFAULT '{30,15,5,0}',
  label            text,
  enabled          boolean NOT NULL DEFAULT true
);

-- Gating d'écriture par abonnement (référencée par toutes les policies d'écriture)
CREATE OR REPLACE FUNCTION guild_is_writable(g uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.guilds
    WHERE id = g AND subscription_status IN ('trialing','active','past_due')
  );
$$;

-- Policy type (à décliner sur chaque table)
CREATE POLICY tenant_select ON guild_members FOR SELECT TO authenticated
  USING (guild_id = (auth.jwt() -> 'app_metadata' ->> 'guild_id')::uuid);
CREATE POLICY tenant_write ON guild_members FOR INSERT TO authenticated
  WITH CHECK (
    guild_id = (auth.jwt() -> 'app_metadata' ->> 'guild_id')::uuid
    AND guild_is_writable(guild_id)
  );
-- + UPDATE/DELETE, + restrictions R5-only (config, comptes, suppression d'historique)

-- À supprimer après vérification : weekly_scores, event_reminders_sent,
-- discord_notifications_sent, accounts.password (texte clair)
```

---

<a name="annexe-c"></a>
## Annexe C : Checklist de lancement

**Sécurité / données**
- [ ] Tests d'isolation inter-tenants verts (chaque table + chaque RPC, 2 tenants de test)
- [ ] Advisors Supabase : zéro erreur, warnings justifiés par écrit
- [ ] Restauration de backup testée sur staging
- [ ] Rate limiting login vérifié ; leaked-password protection active
- [ ] Export + suppression de tenant fonctionnels (RGPD)

**Produit**
- [ ] Parcours complet : signup, wizard, import CSV, événement, rappel Discord+push reçu, leaderboard
- [ ] essai, paiement test, annulation, lecture seule, réactivation
- [ ] PWA installée et push reçus sur Android **et** iOS (≥ 16.4)
- [ ] FR/EN vérifiés écran par écran ; `i18n-check` au vert ; langue par défaut EN constatée sur navigateur vierge
- [ ] Tenant de démo peuplé (captures landing + support)

**Public**
- [ ] Landing EN/FR en ligne, Lighthouse ≥ 90 mobile, OG/sitemap/hreflang
- [ ] CGV/CGU/confidentialité/mentions publiées (EN+FR) ; case rétractation au checkout
- [ ] E-mails transactionnels testés (vérification, reset, fin d'essai, échec de paiement)
- [ ] support@ opérationnel + Discord de support ouvert ; docs (8 à 10 articles) publiées
- [ ] Monitoring : heartbeat cron, uptime, Sentry, page de statut

**Exploitation**
- [ ] `main` protégé ; déploiement reproductible depuis le repo seul (migrations + fonctions + statique)
- [ ] Staging isolé de la prod ; guilde RAD migrée et validée par ses utilisateurs réels
- [ ] Procédure d'incident écrite (qui est prévenu, comment rollback)
