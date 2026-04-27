# PROJECT_STATE — RAD Management

> Fichier d'état maintenu par `secure-web-builder`. À lire **avant toute action** sur ce projet. À mettre à jour à chaque jalon.

**Dernière mise à jour** : 2026-04-27 — Phase 0 (scaffold initial)

---

## 1. Vue d'ensemble

- **Nom** : RAD Management — outil d'opérations pour la guilde *Foundation Galactic Frontier*
- **Type** : app full-stack (auth + persistance + temps réel + PWA)
- **Statut** : refonte en cours — phase 0 (scaffold)
- **Public** : interne (R5 admins + R4 officiers + membres de la guilde)
- **Volume estimé** : < 200 utilisateurs identifiés, faible charge
- **Repo** : https://github.com/MisterSad/guildmanagement (⚠️ public — à passer en privé)
- **URL prod** : pas encore déployé sur la nouvelle stack ; ancienne app vanilla toujours sous `legacy/`
- **URL staging** : preview Vercel automatique sur chaque PR (à configurer phase 0g)

## 2. Stack technique

- **Framework** : Next.js 16.2.4 (App Router, React 19.2)
- **Langage** : TypeScript 5 strict (`noUncheckedIndexedAccess`, `noImplicitOverride`)
- **Styling** : Tailwind CSS 4 (PostCSS, theme tokens dans `globals.css`)
- **Polices** : Geist Sans + Geist Mono via `next/font/google` (auto-hébergées au build)
- **Validation** : Zod (à utiliser à toutes les frontières — formulaires, Server Actions, API)
- **BDD + Auth + Storage** : Supabase, projet `RAD MANAGEMENT TOOL` (`vgweufzwmfwplusskmuf`, région `eu-west-1`)
- **Accès BDD côté code** : `@supabase/supabase-js` + `@supabase/ssr` (cookies d'auth) + types générés via `supabase gen types typescript --project-id vgweufzwmfwplusskmuf > src/types/database.types.ts` (à générer phase 1)
- **Tests** : aucun pour l'instant — Vitest + Playwright à introduire à partir de la phase 4
- **Repo** : GitHub `MisterSad/guildmanagement` (⚠️ encore public — à privatiser)
- **Hébergement** : Vercel (Free Hobby), à connecter au repo en phase 0g

**Justification des écarts** par rapport à la stack par défaut : aucun, stack 100 % conforme à `secure-web-builder`.

## 3. Threat model

**Surfaces d'attaque** identifiées sur l'app legacy (à corriger dans la nouvelle stack) :
- **Login `accounts.id/password`** → mots de passe en clair, prédictibles (`Math.random`), table sans RLS. **Mesure phase 1** : migration Supabase Auth (Argon2id côté Auth), table `profiles` liée à `auth.users` pour rôle (R5/R4/membre).
- **Écriture libre sur `event_status`** depuis la clé `anon` exposée → tout Internet peut toggler les events. **Cause #1 probable des starts/stops mystérieux**. **Mesure phase 1** : RLS + policy `INSERT/UPDATE` réservée aux R5 authentifiés + audit log.
- **XSS via `innerHTML` partout dans le legacy** → traité par migration vers JSX (échappement par défaut).
- **Pas de rate limit login** → bruteforce trivial. **Mesure phase 2** : rate limit Vercel Edge ou middleware custom + lock après N échecs.

**Données sensibles** :
- `accounts.password` (legacy) → texte clair, à supprimer en phase 1.
- Identité in-game des membres (`pseudo`, `uid`) → non sensible mais à protéger via RLS.
- Sanctions (motifs de sanction membres) → modérément sensible, RLS R5/R4.

**Risques résiduels acceptés** :
- Notifications push iOS limitées aux utilisateurs ayant ajouté la PWA à l'écran d'accueil (limite Safari, pas de contournement).
- Repo GitHub public pendant la phase 0 → à corriger dès que possible.

## 4. Architecture

```
.
├── .github/workflows/ci.yml      # Lint, typecheck, build, audit prod sur PR
├── legacy/                        # App vanilla originale, conservée jusqu'à phase 8
│   ├── app.js, events.js, ...    # → à supprimer après cutover
├── public/
│   └── favicon.png
├── src/
│   ├── app/
│   │   ├── globals.css           # Tokens design, dark mode forcé
│   │   ├── layout.tsx            # Geist Sans/Mono, metadata, viewport
│   │   └── page.tsx              # Landing temporaire
│   └── middleware.ts             # CSP nonce-based + autres headers via next.config
├── .env.local.example            # Template env vars (Supabase, VAPID)
├── eslint.config.mjs             # next/core-web-vitals + next/ts + security plugin
├── next.config.ts                # Headers (HSTS, X-Frame, Permissions-Policy, ...)
├── package.json                  # deps verrouillées (Next 16.2, React 19.2)
├── PROJECT_STATE.md              # Ce fichier
├── renovate.json                 # Updates dépendances groupées + audit hebdo
└── tsconfig.json                 # TS strict + noUncheckedIndexedAccess
```

**Décisions d'architecture clés** (ADRs courts) :
- **2026-04-27** : refonte vanilla JS → Next.js retenue plutôt que patch incrémental. Raison : les 4 nouveaux besoins (PWA + push + Guild Hub + comptes membres + i18n parfaite) coûtent plus cher en patchs successifs qu'en refonte propre, et la sécurité actuelle (RLS off, password en clair, clé exposée) impose de tout reprendre côté auth.
- **2026-04-27** : code legacy conservé sous `legacy/` au lieu d'être supprimé immédiatement. Raison : permet de comparer le comportement attendu pendant la migration et facilite les démos comparatives. Suppression planifiée phase 8.
- **2026-04-27** : CSP nonce-based plutôt que `'unsafe-inline'` pour `script-src`. Raison : Next.js App Router supporte nativement, le coût d'implémentation est minimal et l'intérêt sécurité est majeur.

## 5. Dépendances

**Production** :
- `next` 16.2.4, `react` 19.2.4, `react-dom` 19.2.4
- `@supabase/supabase-js` ^2.49 + `@supabase/ssr` ^0.7 (cookies-based auth pour App Router)
- `zod` ^3.24 (validation aux frontières)

**Dev** :
- `typescript` ^5, `@types/node` 20, `@types/react` 19
- `eslint` 9 + `eslint-config-next` 16.2 + `eslint-plugin-security` ^3
- `tailwindcss` ^4 + `@tailwindcss/postcss` ^4

**Audit** :
- Dernier `npm audit --omit=dev --audit-level=high` : 2026-04-27, exit 0. 2 vulnérabilités **moderate** (postcss <8.5.10, GHSA-qx2v-qp2m-jg93) acceptées car la fix automatique downgrade Next à v9 (breaking). Le path est `next > postcss` ; sera résolu par une mise à jour mineure de Next côté upstream — surveillé via Renovate.
- Renovate : configuré (`renovate.json`), à activer côté GitHub App
- Vulnérabilités acceptées : postcss XSS modéré via stringify (transitive Next, attendu en attente fix upstream)

## 6. Sécurité — état des contrôles

- [x] Headers HTTP de base configurés (HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy) dans `next.config.ts`
- [x] CSP nonce-based stricte injectée par `src/middleware.ts`
- [ ] Cookies sécurisés — à valider en phase 1 via `@supabase/ssr` (Secure / HttpOnly / SameSite=Lax par défaut)
- [ ] Auth Supabase — phase 1 : migration `accounts` → `auth.users` + table `profiles(role)`
- [ ] Validation Zod sur toutes les entrées — à introduire au fur et à mesure (phases 4-6)
- [ ] RLS Supabase — **toutes les tables actuellement désactivées**, phase 1 : activation + policies par rôle
- [ ] CSRF — géré nativement par Next.js Server Actions (origin check)
- [ ] Rate limiting login — phase 2
- [x] Secrets en env vars, `.env*` gitignorés (template `.env.local.example` fourni)
- [x] Renovate configuré
- [ ] HTTPS forcé en prod — assuré par Vercel + HSTS preload (phase 0g)

**Variables d'environnement requises** (noms uniquement) :
- `NEXT_PUBLIC_SUPABASE_URL` — URL projet Supabase (publique)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` — clé anon (publique, sécurité dépend de la RLS)
- `SUPABASE_SERVICE_ROLE_KEY` — serveur uniquement, bypass RLS
- `NEXT_PUBLIC_APP_URL` — URL canonique pour callbacks d'auth
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — push notifications (phase 7)

**Configuration Supabase** :
- Projet : `RAD MANAGEMENT TOOL` (id `vgweufzwmfwplusskmuf`, région `eu-west-1`)
- Postgres 17.6.1
- RLS activée sur toutes les tables : **NON — à corriger en phase 1**
- Tables existantes : `accounts` (à migrer vers `auth.users`), `guild_members`, `event_status`, `event_participants`, `shadowfront_squads`, `weekly_scores`, `sanctions`
- Auth providers à activer phase 1 : Email (magic link), à confirmer si Google/Discord souhaité
- Migrations : pas encore versionnées dans le repo, à introduire avec `supabase/migrations/` en phase 1
- Storage buckets utilisés : aucun (à introduire si avatars membres en phase 6)

## 7. Intégrations tierces

Pour l'instant **aucune intégration tierce hors stack par défaut**.

Pré-approuvées (préférences utilisateur, pas de re-validation requise) :
- **GitHub** — repo `MisterSad/guildmanagement`
- **Vercel** — à connecter en phase 0g
- **Supabase** — projet existant `vgweufzwmfwplusskmuf`

À discuter en phase 7 :
- Service Web Push (auto-hébergé via `web-push` npm package, pas d'intégration tierce nécessaire).

## 8. UI/UX

- **Identité** : palette indigo/violet sombre héritée du legacy (`#6366f1`, `#8b5cf6`), fond `#0b0f19`. Verre dépoli (glass-card) à reprendre dans la nouvelle stack.
- **Typographie** : Geist Sans (corps + titres) + Geist Mono (UID, codes, mots de passe). Lisibilité optimale pour tableaux denses.
- **Composants** : custom Tailwind pour l'instant ; envisager **shadcn/ui** (copié, pas dépendance) en phase 4 si besoin de composants accessibles éprouvés (Dialog, DropdownMenu, etc.).
- **Dark mode** : forcé pour l'instant (`color-scheme: dark`), light mode envisageable plus tard si demandé.
- **Locales** : `en` par défaut + `fr` toggle, via `next-intl` à introduire en phase 3.
- **Accessibilité** : cible WCAG 2.2 AA — `prefers-reduced-motion` déjà respecté dans `globals.css`. Tests axe + clavier en phase 8.
- **Performance** : cible Lighthouse Perf ≥ 90, A11y ≥ 95. Mesure phase 8.

## 9. Conformité

- **RGPD** : applicable (membres potentiellement européens). Données collectées : pseudo + UID in-game, email (auth phase 1). Pas de données sensibles au sens RGPD.
- **Bannière cookies** : pas requise tant qu'on n'utilise que des cookies strictement nécessaires (auth Supabase). À surveiller si analytics ajoutés.
- **Politique de confidentialité** : à rédiger phase 8.

## 10. Déploiement

- **Repo GitHub** : `MisterSad/guildmanagement` (⚠️ public)
- **Hébergement** : Vercel — projet à créer phase 0g, free Hobby
- **Connexion** : Vercel ↔ GitHub via l'intégration officielle (auto-deploy `main`, preview sur PR)
- **CI** : GitHub Actions `.github/workflows/ci.yml` — jobs `lint`, `typecheck`, `build`, `audit:prod`
- **Branches** : `main` (prod), branches feature `feat/*`, `fix/*`, branche refonte courante `claude/angry-shtern-953dc1`
- **Protection `main`** : à configurer par l'utilisateur (require PR review + status checks CI)
- **Variables d'env** : à configurer dans le dashboard Vercel phase 0g (Production / Preview / Development séparés)
- **Backup BDD Supabase** : auto inclus, rétention free tier = 7 jours. À tester en phase 1 après migrations.
- **Rollback** : Vercel deployments → "Promote to Production" sur ancien build. BDD : restore depuis backup Supabase ou migration inverse.

## 11. TODO et dette

**Priorité immédiate (utilisateur)** :
- [ ] **Passer le repo `MisterSad/guildmanagement` en privé** (Settings → General → Danger Zone → Change visibility)
- [ ] Créer un projet Vercel et connecter le repo (sélectionner branche `main`, framework Next.js détecté auto)
- [ ] Créer les 5 variables d'env Supabase + APP_URL dans Vercel (Production + Preview)

**Phase 1 (sécurité)** :
- [ ] Schéma SQL : table `profiles(id PK fk auth.users, role text check in (R5, R4, member), pseudo, uid)`
- [ ] Migration `accounts` → invitations Supabase Auth (magic link) ou import manuel
- [ ] Activer RLS sur les 7 tables, écrire les policies (R5 = écriture totale, R4 = écriture limitée, membre = lecture + son propre profil)
- [ ] Audit log `event_status_history(id, event_name, is_active, changed_by, changed_at)` + trigger ou Server Action

**Dette technique connue** :
- Aucun test E2E pour l'instant — à introduire phase 4.
- Le code legacy reste fonctionnel mais non maintenu — toute évolution doit aller dans la nouvelle stack.

## 12. Journal des sessions

- **2026-04-27** — Diagnostic complet du legacy (8 fichiers JS, 1500+ lignes, 7 tables Supabase). Identifié 8 vulnérabilités critiques (RLS off, mots de passe en clair, clé exposée publique, XSS via innerHTML, calcul de semaine en local TZ, comportement events « auto » dû à la clé exposée). Plan refonte 8 phases validé par l'utilisateur. Phase 0 livrée : scaffold Next.js 16 + TS strict + Tailwind 4 + ESLint sécurisé + headers HTTP + CSP nonce + CI GitHub Actions + Renovate + `PROJECT_STATE.md`. Code legacy déplacé sous `legacy/`. Reste à faire : `npm install`, premier commit, push, instructions Vercel et privatisation du repo à transmettre à l'utilisateur.
