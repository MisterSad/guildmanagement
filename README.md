# RAD Management

Outil d'opérations pour la guilde *Foundation Galactic Frontier* — événements, membres, glory, sanctions et statistiques.

> **Statut** : refonte en cours. La nouvelle stack (Next.js + Supabase) remplace progressivement l'ancienne app vanilla JS conservée sous [`legacy/`](./legacy/). Voir [`PROJECT_STATE.md`](./PROJECT_STATE.md) pour le contexte complet.

## Stack

- Next.js 16 (App Router, React 19) + TypeScript strict
- Tailwind CSS 4 + Geist Sans/Mono (`next/font`)
- Supabase (Postgres + Auth + Storage)
- Hébergement Vercel, repo GitHub

## Démarrer en local

```bash
npm install
cp .env.local.example .env.local      # remplir les valeurs Supabase
npm run dev
```

App disponible sur http://localhost:3000.

## Scripts

| Commande | Rôle |
|---|---|
| `npm run dev` | Serveur de dev |
| `npm run build` | Build production |
| `npm run start` | Serveur production local |
| `npm run lint` | ESLint (Next + security plugin) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run audit:prod` | `npm audit` deps prod, niveau ≥ high |

## Variables d'environnement

Voir [`.env.local.example`](./.env.local.example). Toutes les valeurs vivent dans le dashboard Vercel (Production / Preview / Development séparés). Ne **jamais** commiter `.env.local`.

## Sécurité

- Headers HTTP appliqués globalement via `next.config.ts` (HSTS, X-Frame-Options, Permissions-Policy, …)
- CSP nonce-based injectée par requête via [`src/middleware.ts`](./src/middleware.ts)
- ESLint avec `eslint-plugin-security`
- Renovate pour les mises à jour de dépendances + CI (lint, typecheck, build, audit)
- RLS Supabase **à activer en phase 1** (voir `PROJECT_STATE.md` § 11)

## Convention

Tout passage de scope (nouvelle dépendance, ADR, intégration tierce, vulnérabilité corrigée) doit être reflété dans [`PROJECT_STATE.md`](./PROJECT_STATE.md).
