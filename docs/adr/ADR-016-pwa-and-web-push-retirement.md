# ADR-016: Retiring the PWA and Web Push — and the Ordering That Makes It Safe

- **Status**: Accepted
- **Date**: 2026-09-26
- **Authors**: Owner decision, executed in Phase 2

---

## 1. Context

Discord is the only channel that reaches all 26 guilds, and the owner chose it as the only notification channel.

What the PWA actually provided, measured rather than assumed:

- The service worker had **no `fetch` handler** and **never touched Cache Storage** — verified by zero occurrences of `caches.`, `indexedDB`, `backgroundSync`, `periodicSync` or a `sync` listener anywhere in the repository. It therefore delivered **no offline capability and no caching**. Its only remaining benefit was installability.
- `PushService.init()` and `.mount()` had **empty bodies**, and `event-reminders` contained no push code at all. The feature was already decommissioned in the product.
- `src/core/pwa/pwa.ts` told users *"Working offline. Local changes will sync when online."* There was no write queue and no sync. **Every write made offline was silently lost** while the app claimed the opposite — a trust bug, not a copy bug.
- `save_push_subscription` was granted to `anon` and carried `coalesce(v_guild, 'ALPHA')`, so an unauthenticated caller with only the publishable key could insert a subscription into a real tenant (finding C2).

## 2. Decision

Remove the PWA and Web Push entirely, **in two releases, in this order**.

**Release *n* — ship a self-destructing tombstone.** `src/sw/service-worker.ts` becomes a worker whose only job is `skipWaiting()` then `registration.unregister()` (plus a defensive Cache Storage purge and a best-effort reload of open clients). Everything else goes: `PushService.ts`, `pwa.ts`, `push-payload.ts`, `manifest.webmanifest`, the five install-only PNG icons (612 KB), the `push_subscriptions` and `player_push_prefs` tables and the three push RPCs. The offline copy is rewritten to say changes will **not** be saved.

**Release *n+1*, only after a full cycle — delete `src/sw/`**, the esbuild block in `scripts/build.js` and the dev plugin in `vite.config.ts`, together.

## 3. Consequences & Invariants

- **Deleting a service worker's source does not uninstall it.** A worker already installed on a member's device runs forever, independently of the page that registered it. It goes away only when the browser can fetch a **new** `/sw.js` from that exact URL and watch it unregister. Removing the file instead 404s the path and makes the old worker unreachable and immortal. This is the entire reason for the two-release ordering.
- **Check before touching `src/sw/`:**
  ```
  curl -sS https://guildmanagement.vercel.app/sw.js | grep -c unregister
  ```
  `0` means the tombstone is not live yet — stop.
- **`/sw.js` must be served revalidating.** Serve it `immutable` like the hashed assets and the browser keeps handing back the old worker; the kill switch never arrives and nothing fails loudly. `vercel.json` pins `no-cache, must-revalidate`.
- **The source, the build step and the dev plugin are all-or-nothing.** Half-deleting them is silent. `tests/phase2_pwa_retirement.test.js` enforces both this and the cache header.
- **Freshness now rests entirely on the CDN**, since no worker manages it: `/assets/*` immutable, `index.html` and `version.json` no-cache.
- Dropping the push tables closed finding C2 completely. Anon-executable `SECURITY DEFINER` functions fell from four to one (`gm_report_client_error`, intentional under ADR-011).
