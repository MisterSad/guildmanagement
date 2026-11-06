# ADR-012: SHA-256 OCR Deduplication Cache for Gemini Vision

> Since ADR-024 (2026-11-06) the model is reached through OpenRouter (`google/gemini-3.8-flash`); the cache below is unchanged.

- **Status**: Accepted — **and, as of 2026-09-26, actually deployed** (see the addendum)
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

---

## Addendum, 2026-09-27 — this ADR described a feature that did not exist in production (finding H1)

For its first weeks this decision was **documented, unit-tested, and consuming Gemini quota it was supposed to save, while being absent from the deployed binary.**

The evidence was in `function_logs`, not in the code: every scan emitted `Initiating Gemini OCR scan` → `Gemini OCR extraction succeeded` → `OCR Extraction completed`, but **never** `OCR result cached successfully`, never the cache-write warning, and never `OCR cache hit` — although those lines bracket the cache block immediately. `ocr_cache` held **0 rows** and both its indexes had never been used.

The cause was ordering, not logic: `ocr-guild-members` was last deployed **~2026-09-18**, two days *before* `20260920130000_ocr_cache_table.sql` created the table it reads. The auto-deploy `pre-push` hook was added later, so functions shipped before it escaped synchronisation entirely. The code was correct the whole time.

**Now:** redeployed in Phase 5; `ocr_cache` holds real rows and the cache-hit path executes. ADR-017 records the general rule this violated.

**Two corrections carried by that repair:**

- The model list in this ADR (`gemini-1.5-flash` / `gemini-2.5-flash`) and the one in the function had diverged into invented identifiers — `gemini-3.5-flash`, `gemini-3.7-flash`, `gemini-3-flash-preview` are Claude/GPT-shaped version numbers pattern-matched onto the wrong vendor, and each cost a round trip and a 404 on the fallback path. Only verified identifiers remain.
- The table's `SELECT` policy had a `guild_id IS NULL` disjunct, which would have made every `super_admin`/`server_admin` scan (their `accounts.guild` is NULL by design) readable by **any authenticated user of any tenant**. Harmless while the table was empty — which it was, for exactly the reason above — and closed before the cache started filling.

**Retention:** cached rows hold transcribed player names, so they fall under ADR-018. `gm_cleanup_expired_ocr_cache()` existed and had been revoked from `anon`, but **no cron ever called it**; the expiry sweep now runs inside `gm_apply_data_retention()`, daily.
