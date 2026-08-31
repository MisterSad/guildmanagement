-- 20260901000000_webauthn_passkeys.sql
--
-- Passkeys/WebAuthn support. This app does NOT use Supabase Auth natively
-- for real credentials — a custom `accounts` table (bcrypt password) is the
-- source of truth, bridged to a synthetic "shadow" GoTrue user purely to
-- mint a real JWT (see supabase/functions/auth-login/index.ts). A passkey
-- ceremony replaces the gm_check_login(id, password) step only; everything
-- downstream (shadow user resolution, GoTrue session issuance) is reused
-- as-is via a new _shared/shadow-session.ts helper.
--
-- All three tables here are accessed exclusively through a new
-- supabase/functions/auth-passkey Edge Function (service_role client),
-- mirroring how the `member` role already has zero direct database access
-- and must go through member-portal for everything. RLS is enabled with NO
-- policies (deny-all to authenticated/anon) — same pattern already used by
-- login_throttle.

-- Short-lived WebAuthn registration/authentication challenges. A ceremony
-- is two round trips (options -> verify); the challenge has to be held
-- server-side between them since Edge Functions are stateless per request.
CREATE TABLE IF NOT EXISTS public.webauthn_challenges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT REFERENCES public.accounts(id) ON DELETE CASCADE,
    challenge TEXT NOT NULL,
    ceremony_type TEXT NOT NULL CHECK (ceremony_type IN ('registration', 'authentication')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_account ON public.webauthn_challenges(account_id);

-- One row per registered credential. An account can register multiple (one
-- per device) — device_label defaults to a client-detected "Chrome on
-- macOS"-style string at registration time and is user-editable afterward.
CREATE TABLE IF NOT EXISTS public.account_passkeys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    public_key TEXT NOT NULL,
    sign_count BIGINT NOT NULL DEFAULT 0,
    transports TEXT[] DEFAULT '{}',
    device_label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_account_passkeys_account ON public.account_passkeys(account_id);

-- One shared set of recovery codes per account, generated at first-passkey
-- enrollment and regenerable afterward (regenerating invalidates the prior
-- set — old rows are deleted, not just superseded). Hashed with SHA-256
-- (not bcrypt): redemption needs a direct hash lookup across several rows
-- for one account, which per-row-salted bcrypt can't do — same reasoning
-- already applied to the guild join code in gm_register_player.
CREATE TABLE IF NOT EXISTS public.account_backup_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL UNIQUE,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_backup_codes_account ON public.account_backup_codes(account_id);

ALTER TABLE public.webauthn_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_passkeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_backup_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: every read/write goes through auth-passkey's
-- service_role client, which enforces "self OR in-scope admin" in code
-- (mirrors login_throttle, also service_role-only with zero policies).

NOTIFY pgrst, 'reload schema';
