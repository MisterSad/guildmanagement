# 🚀 Production Deployment & Infrastructure Runbook — FGF Guild Management Tool

> **Status**: Executed 2026-08-23 — Status: Complete  
> **Target Project**: `vgweufzwmfwplusskmuf` (Supabase Postgres 17 + Deno Edge Runtime)  
> **Production Frontend**: `https://guildmanagement.vercel.app/`

---

## 1. Overview & Operational Pre-requisites

This runbook defines the authoritative, repeatable sequence for deploying database migrations, rotating sensitive secrets, and deploying Deno Edge Functions with zero downtime.

### Pre-requisite Tools:
- Supabase CLI linked to target project (`supabase link --project-ref <REF>`).
- Node.js runtime and npm packages installed.
- Curl CLI with HTTP/2 support.

---

## 2. Phase 0 — Pre-Flight Verification & Inventory Snapshot

### 2.1 Baseline Quality Gate
```sh
npm run type-check   # 0 TypeScript errors required
npm test             # 397/397 Vitest unit tests green required
npm run build        # Clean production build + root syntax check
```

### 2.2 Pre-Flight Database Inventory Queries
Run against target Supabase database:
```sql
-- Check existing functions
SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid
WHERE n.nspname='public' AND proname IN ('gm_invoke_event_reminders','gm_register_player','gm_get_shadow','gm_apply_subscription_payment') ORDER BY proname;

-- Check tables & RLS status
SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('login_throttle', 'system_audit_logs');

-- Check column presence
SELECT table_name, column_name FROM information_schema.columns 
WHERE table_name IN ('guilds', 'accounts') AND column_name IN ('plan_key', 'password_hash', 'failed_login_count', 'locked_until', 'last_login_at');

-- Check role drift
SELECT u.id, u.raw_user_meta_data, a.id AS account_id, a.role, a.status
FROM auth.users u LEFT JOIN public.accounts a ON a.auth_user_id = u.id
WHERE (u.raw_app_meta_data->>'app_role') IS DISTINCT FROM a.role OR a.id IS NULL;
```

---

## 3. Phase 1 — Database Migrations (Canonical Application Order)

Apply each migration file sequentially using `supabase db query --linked -f <FILE>` and execute its corresponding verification query:

### 1. `20260823050000_role_helpers_remove_user_metadata_fallback.sql`
- **Purpose**: Eliminates `user_metadata` fallback in `public.is_super_admin()`.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823050000_role_helpers_remove_user_metadata_fallback.sql`
- **Verify**:
  ```sql
  SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid 
  WHERE n.nspname='public' AND proname='is_super_admin';
  -- Must query public.accounts only
  ```

### 2. `20260823053000_harden_subscription_payment_and_plans.sql`
- **Purpose**: Adds `guilds.plan_key`, adds `FOR UPDATE` row lock, revokes `gm_apply_subscription_payment` from `authenticated`.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823053000_harden_subscription_payment_and_plans.sql`
- **Verify**:
  ```sql
  SELECT column_name FROM information_schema.columns WHERE table_name='guilds' AND column_name='plan_key';
  ```

### 3. `20260823060000_security_rpc_lockdown.sql`
- **Purpose**: Enforces authorization gates on 11 RPCs; restricts `system_audit_logs` INSERT to `service_role`.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823060000_security_rpc_lockdown.sql`
- **Verify**:
  ```sql
  SELECT policyname, roles, cmd FROM pg_policies WHERE tablename='system_audit_logs';
  -- INSERT must be restricted to {service_role}
  ```

### 4. `20260823063000_cron_secret_to_vault.sql`
- **Purpose**: Replaces hardcoded cron secret with `public.gm_invoke_event_reminders()` reading from Vault.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823063000_cron_secret_to_vault.sql`
- **Verify**:
  ```sql
  SELECT jobname, schedule, command FROM cron.job WHERE jobname = 'fgf-event-reminders';
  ```

### 5. `20260823070000_auth_hardening.sql`
- **Purpose**: Adds Bcrypt `password_hash`, lockout counter, and timestamps to `public.accounts`.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823070000_auth_hardening.sql`
- **Verify**:
  ```sql
  SELECT column_name FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('password_hash', 'failed_login_count', 'locked_until');
  ```

### 6. `20260823100000_canonical_reconciliation_round2.sql`
- **Purpose**: Canonical reconciliation of 13 archive RPCs and accounts SELECT grant.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823100000_canonical_reconciliation_round2.sql`
- **Verify**:
  ```sql
  SELECT proname FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid 
  WHERE n.nspname='public' AND proname IN ('gm_register_player', 'gm_get_shadow');
  ```

### 7. `20260823110000_login_throttle_ip.sql`
- **Purpose**: Creates `public.login_throttle` table and exponential lockout logic.
- **Apply**: `supabase db query --linked -f supabase/migrations/20260823110000_login_throttle_ip.sql`
- **Verify**:
  ```sql
  SELECT relname, relrowsecurity FROM pg_class WHERE relname='login_throttle'; -- relrowsecurity = true
  SELECT count(*) FROM pg_policies WHERE tablename='login_throttle'; -- 0
  ```

---

## 4. Phase 2 — Secrets Vault Rotation

1. **Generate New Secret**:
   ```sh
   NEW_SECRET=$(openssl rand -hex 32)
   ```
2. **Store in Supabase Vault**:
   ```sql
   SELECT vault.create_secret('<NEW_SECRET>', 'event_reminders_cron_secret');
   ```
3. **Synchronize Edge Function Environment**:
   ```sh
   supabase secrets set CRON_SECRET="<NEW_SECRET>"
   ```
4. **Verify Acceptance of New Secret & Rejection of Old Secret**:
   ```sh
   # New Secret -> HTTP 200 OK
   curl -s -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/event-reminders" \
     -H "Authorization: Bearer <NEW_SECRET>" -d '{}'

   # Old Secret -> HTTP 401 Unauthorized
   curl -s -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/event-reminders" \
     -H "Authorization: Bearer <OLD_SECRET>" -d '{}'
   ```

---

## 5. Phase 3 — Edge Functions Deployment Matrix

Deploy all 10 Edge Functions adhering to the codified JWT verification matrix in `supabase/config.toml`:

```sh
# Public Endpoints (verify_jwt = false)
supabase functions deploy auth-login --no-verify-jwt
supabase functions deploy player-register --no-verify-jwt
supabase functions deploy event-reminders --no-verify-jwt
supabase functions deploy gm-stripe-webhook --no-verify-jwt

# JWT-Gated Endpoints (verify_jwt = true)
supabase functions deploy member-portal
supabase functions deploy admin-accounts
supabase functions deploy gm-create-order
supabase functions deploy gm-order-status
supabase functions deploy discord-webhook-proxy
supabase functions deploy ocr-guild-members
```

---

## 6. Phase 4 — Post-Deployment Verification Matrix (S1–S6 & F1–F6)

### Security Behavior Matrix (S1–S6):
- **S1**: Authenticated member calling `gm_apply_subscription_payment` via PostgREST → Expect HTTP 403 `permission denied`.
- **S2**: Anonymous caller inserting into `system_audit_logs` via PostgREST → Expect HTTP 401 RLS denial.
- **S3**: 5 consecutive failed login attempts on test account → 5th attempt returns `account_locked`; DB row shows `failed_login_count=5` and `locked_until > now()`.
- **S4**: 31 rapid login attempts from same client IP → 31st attempt returns HTTP 429 `too_many_attempts`.
- **S5**: Login with legacy PGP encrypted account (`DemoAdmin`) → Login succeeds, password auto-migrates to Bcrypt hash (`$2a$10$...`), `last_login_at` timestamp recorded.
- **S6**: Old CRON secret returns HTTP 401; new CRON secret returns HTTP 200.

### Response CORS Echo Verification (Mandatory Post-Deploy Check):
- **CORS Echo Verification**: For every function, curl a function-code path (success AND error) with `Origin: https://guildmanagement.vercel.app`; the response `Access-Control-Allow-Origin` header must echo `https://guildmanagement.vercel.app`. Preflight alone is insufficient (2026-08-23 incident lesson).

### Functional Matrix (F1–F6):
- **F1**: Admin login loads Command Center and guild switcher.
- **F2**: Player Portal login (`DemoPlayer`) returns full player KPIs (`get-personal-kpis`) and guild averages.
- **F3**: Roster OCR opens Three-Section Review (Existing/New/Removed) with UID input and removal overrides.
- **F4**: Subscriptions view correctly displays active status across all 9 live guild tenants.
- **F5**: System Logs diagnostics tab renders structured audit logs for `super_admin`.
- **F6**: Zero browser console CSP/CORS errors on production domain `https://guildmanagement.vercel.app`.

---

## 7. Rollback & Disaster Recovery Procedures

If a catastrophic failure occurs during deployment:
1. **Edge Function Rollback**: Redeploy the previous Git revision for the affected function (`supabase functions deploy <FUNCTION>`).
2. **Database Function Rollback**: Re-execute the safety backup DDL snapshot created in Phase 0 (`deploy_backup_*.json`).
3. **Secret Rollback**: Revert Vault secret and `supabase secrets set` in tandem.
