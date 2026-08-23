📢 **FGF Guild Management Tool Update — CHANG_V124.2**

Hey commanders! 👋

I have just pushed a comprehensive follow-up update (`CHANG_V124.2`) closing all remaining audit items, tightening our anti-abuse defenses, and locking down CDN script integrity across the entire platform! 🛡️⚡🚀

---

### 🔒 1. Distributed IP Rate Limiting & Anti-DoS Defense
* **Cross-Isolate IP Throttling**: I implemented an IP sliding-window rate limiter backed by Postgres, protecting login and portal entrypoints against brute-force attacks and credential stuffing across all Edge server isolates.
* **Balanced Lockout Backoff**: Upgraded account lockout logic to exponential backoff (15/30/45/60 min) to prevent targeted denial-of-service against legitimate players while stopping malicious attempts.

---

### 🛡️ 2. Subresource Integrity (SRI) & Strict CSP
* **Pinned Script Hashes**: Added cryptographic SHA-384 Subresource Integrity (`integrity="sha384-..."`) attributes to all CDN dependencies, ensuring your browser executes only bit-exact, verified scripts.
* **CSP Hardening**: Eliminated `'unsafe-eval'` from our Content Security Policy headers for maximum client-side script execution security.
* **Anchored Origin Matching**: Strengthened API CORS allowlists with strictly anchored domain validators and `Vary: Origin` headers to stop unauthorized web origin requests.

---

### ⚔️ 3. Canonical Database Reconciliation & Partial Indexes
* **Canonical Migration Chain Port**: Reconciled all 13 backend stored procedures (player registration, join codes, absences, timezones, push preferences) into our canonical database migrations with isolated search paths and least-privilege permissions.
* **Optimized Session Indexes**: Added tenant-isolated partial unique indexes to guarantee event participation integrity across concurrent event sessions.

---

### ⚡ 4. OCR & Webhook Safeguards
* **Leaderboard Scan Caps**: Added upload size limits (8 MB) and image batch caps (max 5 images) to the AI OCR scanner to maintain rock-solid server performance.
* **Redirect Protection**: Added strict redirect blocking on outbound Discord webhook notifications.
* **Clean Session Reset**: Ensured server restriction flags are completely cleared on logout.

---

### 🧪 5. Quality Gate & Reliability
* **333/333 Vitest Unit Tests Passing** 🟢 (28 test suites fully green)
* **0 TypeScript Errors (`tsc --noEmit`)** 🔒
* **Clean Production Bundle Built & Verified** 🚀

*Everything is live and verified in production. Thank you for your support, and fly safe in the frontier!* 🌌⚔️
