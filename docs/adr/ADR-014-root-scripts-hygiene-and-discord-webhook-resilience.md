# ADR-014: Root Scripts Hygiene, Build Exclusion & Discord Webhook Rate-Limiting

- **Status**: Accepted
- **Date**: 2026-09-20
- **Authors**: Lead Architect & SecOps

---

## 1. Context

1. **Build Artifact Contamination**:
   - `scripts/build.js` minified and copied non-runtime test configuration files (`playwright.config.js`, `vitest.config.js`) from the repository root into `dist/`. Test configs should never be published or served in production.
2. **Obsolete Maintenance Scripts**:
   - `scripts/bump_cache_busters.py` became obsolete once Vite took over asset bundling and content hashing.
   - Historical one-off migration scripts (`analyze_event_ids.py`, `migrate_event_ids.py`) lingered in the active scripts directory.
3. **Discord Webhook Vulnerability to Flooding**:
   - `discord-webhook-proxy` edge function lacked incoming rate limiting. A malfunctioning loop or malicious client could flood Discord, triggering upstream rate limits and degrading delivery reliability.
   - When Discord responded with HTTP 429 (Too Many Requests), the proxy returned generic 200/500 errors instead of propagating the 429 status and `Retry-After` delay.

## 2. Decision

1. **Build Exclusion & Clean Dist**:
   - Updated `EXCLUDED_FILES` in `scripts/build.js` to explicitly exclude `playwright.config.js` and `vitest.config.js`.
   - Purged residual configuration files from `dist/`.
   - Archived obsolete scripts (`bump_cache_busters.py`, `analyze_event_ids.py`, `migrate_event_ids.py`) into `scripts/archive/` with documentation in `scripts/archive/README.md`.
2. **Discord Webhook Rate-Limiting & 429 Handling**:
   - Integrated `extractClientIp` and `checkAndRecordIpAttempt` in `discord-webhook-proxy/index.ts`.
   - Enforced a ceiling of 30 webhook dispatches per minute per client IP. Exceeding requests are rejected with HTTP 429 and `{ ok: false, error: "rate_limit_exceeded", retry_after: 60 }`.
   - Native Discord 429 Handling: When Discord returns HTTP 429, the proxy parses the `Retry-After` header and returns HTTP 429 `{ ok: false, error: "discord_rate_limited", retry_after: N }`.
3. **E2EE Test Expansion**:
   - Added E2E specs in `e2e/` for Dialog accessibility, custom message modals, and session lifecycle.
   - Optimized `playwright.config.js` to use `url: 'http://localhost:4173'` and `npx --no-install serve`.

## 3. Consequences & Invariants

- **Zero Test Config Leaks**: `dist/` contains only genuine web distribution assets.
- **Flood Protection**: Discord webhooks cannot be spammed beyond 30 calls/minute per IP, safeguarding guild communication channels.
