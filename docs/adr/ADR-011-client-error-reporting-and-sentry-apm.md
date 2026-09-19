# ADR-011: Client Error Reporting RPC, Sentry APM & CSP Hardening

- **Status**: Accepted
- **Date**: 2026-09-20
- **Authors**: Lead Architect & SecOps

---

## 1. Context

1. **Client Crash Invisibility**: `ClientLogger.reportCriticalError()` attempted a direct insert into `system_audit_logs`. Because `system_audit_logs` RLS was strictly locked down to `service_role`, client-side crash reports failed silently with 403 Forbidden.
2. **Third-Party CDN Exposure**: `supabase-js` and `phosphor-icons` were fetched from public CDNs (`cdn.jsdelivr.net`, `unpkg.com`) via un-hashed `<script>` tags in `index.html`. This introduced supply-chain risks and forced broad allowances in `vercel.json` CSP.
3. **No APM Telemetry**: Production lacked real-time error aggregation, performance monitoring, and stack trace symbolication for client runtime crashes.

## 2. Decision

1. **Client Error Reporting RPC**:
   - Created `public.gm_report_client_error(...)` as a `SECURITY DEFINER` function with `search_path = ''`.
   - Built-in rate limiting: max 10 error reports per minute per IP to prevent audit table flooding.
   - Updated `ClientLogger` (`src/core/logger/logger.ts`) to call `supabase.rpc('gm_report_client_error', ...)` instead of direct table inserts.
2. **Sentry APM Integration**:
   - Added `@sentry/browser` to `package.json`.
   - Initialized in `src/main.ts` via `src/core/monitoring/sentry.ts`.
   - Automated PII and credential scrubbing: stripped JWT tokens, passkey credentials, Discord tokens, and passwords from all outbound telemetry frames.
   - Added Sentry ingest domain (`*.ingest.sentry.io`) to `connect-src` in `vercel.json`.
3. **CDN Packaging & CSP Hardening**:
   - Packaged `@phosphor-icons/web` locally as an npm dependency and imported styles in `src/main.ts`.
   - Bundled all 5 CSS stylesheets into Vite (`tokens.css`, `theme.css`, `styles.css`, `components.css`, `shell.css`).
   - Removed external CDN script tags from `index.html`.
   - Removed `cdn.jsdelivr.net` and `unpkg.com` from `script-src`, `style-src`, `font-src`, and `connect-src` in `vercel.json`.

## 3. Consequences & Invariants

- **Full Offline Capability**: The application no longer depends on any external CDN to boot, render styles, or display icons.
- **Strict CSP**: Only origin assets and configured Supabase/Sentry endpoints are permitted in `vercel.json`.
- **Zero-PII Telemetry**: All error reports are scrubbed before transmission.
