# ADR-012: SHA-256 OCR Deduplication Cache for Gemini Vision

- **Status**: Accepted
- **Date**: 2026-09-20
- **Authors**: Lead Architect & SecOps

---

## 1. Context

In war reconciliation and roster management workflows, officers frequently upload screenshots (or re-upload identical batches after reviewing) to scan player names, power scores, and ranks. Prior to this decision, every upload triggered a multi-image inference call to the Gemini Vision API (`gemini-1.5-flash` / `gemini-2.5-flash`). This incurred unnecessary external API latency (3-8 seconds) and consumed API quotas.

## 2. Decision

We implemented a cryptographic deduplication cache layer in `supabase/functions/ocr-guild-members/index.ts` backed by a dedicated PostgreSQL table `public.ocr_cache`:
1. **Canonical SHA-256 Fingerprint**:
   - Implemented `computeOcrPayloadHash(...)` combining the raw binary/base64 image buffer hashes with normalized metadata (`metricType`, `guildTag`, `rankHint`, `scanDay`).
2. **Database Cache Table (`public.ocr_cache`)**:
   - `hash text PRIMARY KEY`
   - `guild_id text REFERENCES public.guilds(id) ON DELETE CASCADE`
   - `metric_type text NOT NULL`
   - `players jsonb NOT NULL`
   - `created_at timestamptz DEFAULT now()`
   - `expires_at timestamptz DEFAULT (now() + interval '7 days')`
   - Secured with `FORCE ROW LEVEL SECURITY` and multi-tenant scoping policy `ocr_cache_admin_select`.
3. **Execution Flow**:
   - **Cache Hit**: Returns the cached JSON payload in <50ms with `cached: true` and zero Gemini API calls.
   - **Cache Miss**: Executes Gemini Vision inference, saves the extracted roster to `ocr_cache` with a 7-day TTL, and returns `cached: false`.
   - Automated retention cleanup via `public.gm_cleanup_expired_ocr_cache()`.

## 3. Consequences & Invariants

- **Determinism**: Identical uploads within the 7-day window yield instantaneous, identical results.
- **Fail-Open Cache**: Cache lookup or insert failures never fail the user request; they gracefully fall through to live inference.
- **Tenant Isolation**: `ocr_cache` queries require the caller to hold valid admin privileges for the associated guild.
