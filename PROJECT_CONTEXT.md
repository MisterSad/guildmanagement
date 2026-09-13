# Contexte Projet & SSOT - FGF Guild Management

## 1. Stack Technique Réelle
- **Runtime & Build :** Node.js 20 LTS, Vite 8.2 (build via `scripts/build.js` + minification esbuild).
- **Frontend :** SPA hybride (module `/src/main.ts` + 23 scripts racine sous IIFE/`window.GM_*`).
- **Base de données :** Supabase PostgreSQL (38 tables persistantes actives avec RLS hermétique sur 41 `CREATE TABLE` historiques, helpers SECURITY DEFINER avec search_path vide, résolution de rôles stricte via table `accounts`).
- **Edge Functions (16 live) :** Deno / TypeScript dans `supabase/functions/` — 8 publiques sans JWT (`verify_jwt = false` : `auth-login`, `auth-passkey`, `player-register`, `guild-request`, `event-reminders`, `gm-stripe-webhook`, `discord-bot-interactions`, `discord-profile-verification`) et 8 sécurisées par JWT (`verify_jwt = true` : `member-portal`, `admin-accounts`, `ocr-guild-members`, `discord-webhook-proxy`, `gm-create-order`, `gm-order-status`, `guild-data-export`, `tickets`).
- **Authentification & Crypto :** WebAuthn (Passkeys RP_ID `guildmanagement.vercel.app`), Discord OAuth2/Ed25519, E2EE Signal (`gm-signal-crypto.js`, `@noble/curves`).
- **Tests :** Vitest (75 suites, 904 tests, 100 % passants), Playwright (E2E sur port 4173), syntax-check racine et type-check TypeScript.
- **Hébergement :** Vercel (frontend statique + headers de sécurité dans `vercel.json`), Supabase Cloud (PostgreSQL, Auth, Edge Functions).

## 2. Règles d'Or & Standards d'Ingénierie
- **Stratégie de Modularisation (Strangler) :** Tout nouveau code est écrit sous forme de module TypeScript/ESM dans `/src/`. Interdiction stricte de créer de nouveaux fichiers `.js` à la racine ou d'ajouter de nouvelles variables globales sur `window.GM_*`.
- **Porte Qualité CI :** Aucun commit sans que `npm run type-check`, `npm test` (904 tests verts, 75 suites) et `scripts/build.js` ne soient au vert.
- **Sécurité RLS :** 100 % des tables doivent avoir `ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY`. Les rôles sont lus exclusivement dans la table `accounts` (aucun fallback `user_metadata`).
- **Logos & Tiers :** Utiliser exclusivement le package `simple-icons` pour tout logo officiel tiers (Discord, Google, Apple, etc.). Ne jamais inventer de SVG à la main.