# Contexte Projet & SSOT - FGF Guild Management

## 1. Stack Technique Réelle
- **Runtime & Build :** Node.js 20 LTS, Vite 8.2 (build via `scripts/build.js` + minification esbuild).
- **Frontend :** SPA hybride (module `/src/main.ts` + 23 scripts racine sous IIFE/`window.GM_*`).
- **Base de données :** Supabase PostgreSQL (41 tables actives avec RLS hermétique, helpers SECURITY DEFINER avec search_path vide, résolution de rôles stricte via table `accounts`).
- **Edge Functions (16 live) :** Deno / TypeScript dans `supabase/functions/`. Attention : `auth-passkey`, `guild-request`, `discord-bot-interactions` doivent impérativement être configurés avec `verify_jwt = false`.
- **Authentification & Crypto :** WebAuthn (Passkeys RP_ID `guildmanagement.vercel.app`), Discord OAuth2/Ed25519, E2EE Signal (`gm-signal-crypto.js`, `@noble/curves`).
- **Tests :** Vitest (74 suites, 898 tests), Playwright (E2E sur port 4173), syntax-check racine et type-check TypeScript.
- **Hébergement :** Vercel (frontend statique + headers de sécurité dans `vercel.json`), Supabase Cloud (PostgreSQL, Auth, Edge Functions).

## 2. Règles d'Or & Standards d'Ingénierie
- **Stratégie de Modularisation (Strangler) :** Tout nouveau code est écrit sous forme de module TypeScript/ESM dans `/src/`. Interdiction stricte de créer de nouveaux fichiers `.js` à la racine ou d'ajouter de nouvelles variables globales sur `window.GM_*`.
- **Porte Qualité CI :** Aucun commit sans que `npm run type-check`, `npm test` (898+ tests verts) et `scripts/build.js` ne soient au vert.
- **Sécurité RLS :** 100 % des tables doivent avoir `ENABLE ROW LEVEL SECURITY` et `FORCE ROW LEVEL SECURITY`. Les rôles sont lus exclusivement dans la table `accounts` (aucun fallback `user_metadata`).
- **Logos & Tiers :** Utiliser exclusivement le package `simple-icons` pour tout logo officiel tiers (Discord, Google, Apple, etc.). Ne jamais inventer de SVG à la main.