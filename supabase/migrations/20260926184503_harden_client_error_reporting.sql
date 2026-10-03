-- ═══════════════════════════════════════════════════════════════════════════
-- Phase 4 — finding M17: harden gm_report_client_error
--
-- This is the only SECURITY DEFINER function deliberately callable by `anon`
-- (ADR-011, unauthenticated crash reporting), and it writes into
-- `system_audit_logs` — the table the audit console reads and the closest
-- thing this system has to a forensic record. Three defects made it
-- poisonable by anyone holding the publishable key:
--
--   1. THE RATE LIMIT COUNTED BY `correlation_id`, WHICH THE CALLER SUPPLIES.
--      Rotating it on every request bypassed the limit entirely — and passing
--      an EMPTY one skipped the check altogether, because the whole block was
--      wrapped in `IF v_corr <> ''`.
--
--   2. `p_metadata` AND `p_error_details` WERE INSERTED UNBOUNDED. Only
--      `message` was capped, so storage exhaustion simply moved one column
--      across.
--
--   3. `p_guild` AND `p_user_identifier` ARE CALLER-CHOSEN, so anyone could
--      write FATAL rows attributed to any guild and any user. That cannot be
--      fixed by validation — the values are genuinely useful when honest — so
--      they are now recorded as *claims*, alongside the identity the database
--      can actually verify.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.gm_report_client_error(
    p_level           text,
    p_service         text,
    p_correlation_id  text,
    p_guild           text  DEFAULT NULL,
    p_user_identifier text  DEFAULT NULL,
    p_message         text  DEFAULT '',
    p_metadata        jsonb DEFAULT '{}'::jsonb,
    p_error_details   jsonb DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    -- Per signed-in user. Generous: a crash loop legitimately produces bursts.
    v_auth_limit CONSTANT integer := 15;
    -- Shared by every anonymous reporter. There is no IP inside SQL and no
    -- identity to key on, so this is a global ceiling: one flooder can consume
    -- it, which is a denial of *reporting*, not of service, and is strictly
    -- better than the unlimited write it replaces.
    v_anon_limit CONSTANT integer := 60;
    -- Roughly 8 KB of JSON each. Past that the payload is a bug report about
    -- the bug reporter.
    v_json_cap   CONSTANT integer := 8000;

    v_recent  integer;
    v_uid     uuid := auth.uid();
    v_level   text;
    v_service text;
    v_msg     text;
    v_corr    text;
    v_guild   text;
    v_user    text;
    v_meta    jsonb;
    v_details jsonb;
BEGIN
    v_level := UPPER(TRIM(COALESCE(p_level, 'ERROR')));
    IF v_level NOT IN ('ERROR', 'FATAL', 'WARN') THEN
        v_level := 'ERROR';
    END IF;

    v_service := SUBSTRING(TRIM(COALESCE(p_service, 'fgf-client')) FROM 1 FOR 64);
    v_corr    := SUBSTRING(TRIM(COALESCE(p_correlation_id, '')) FROM 1 FOR 64);
    v_guild   := NULLIF(SUBSTRING(TRIM(COALESCE(p_guild, '')) FROM 1 FOR 32), '');
    v_user    := NULLIF(SUBSTRING(TRIM(COALESCE(p_user_identifier, '')) FROM 1 FOR 128), '');
    v_msg     := SUBSTRING(TRIM(COALESCE(p_message, 'Unknown client error')) FROM 1 FOR 4000);

    -- ── Rate limit on something the caller cannot rotate ──────────────────
    IF v_uid IS NOT NULL THEN
        SELECT count(*) INTO v_recent
        FROM public.system_audit_logs l
        WHERE l.created_at > now() - interval '1 minute'
          AND l.metadata ->> 'verified_auth_uid' = v_uid::text;
        IF v_recent >= v_auth_limit THEN
            RETURN false;
        END IF;
    ELSE
        SELECT count(*) INTO v_recent
        FROM public.system_audit_logs l
        WHERE l.created_at > now() - interval '1 minute'
          AND l.service = v_service
          AND l.metadata ->> 'verified_auth_uid' IS NULL;
        IF v_recent >= v_anon_limit THEN
            RETURN false;
        END IF;
    END IF;

    -- ── Bound the jsonb payloads ──────────────────────────────────────────
    v_meta := COALESCE(p_metadata, '{}'::jsonb);
    IF length(v_meta::text) > v_json_cap THEN
        v_meta := jsonb_build_object(
            'truncated', true,
            'original_bytes', length(v_meta::text)
        );
    END IF;

    v_details := p_error_details;
    IF v_details IS NOT NULL AND length(v_details::text) > v_json_cap THEN
        v_details := jsonb_build_object(
            'truncated', true,
            'original_bytes', length(v_details::text)
        );
    END IF;

    -- ── Record what is claimed, next to what is verified ──────────────────
    -- `guild` and `user_identifier` are whatever the caller sent. Anyone
    -- reading this table for forensics needs to know that, and needs the one
    -- identity the database established for itself.
    v_meta := v_meta || jsonb_build_object(
        'attribution', CASE WHEN v_uid IS NULL THEN 'client_declared_anonymous'
                            ELSE 'client_declared_authenticated' END,
        'verified_auth_uid', v_uid,
        'claimed_guild', v_guild,
        'claimed_user_identifier', v_user
    );

    INSERT INTO public.system_audit_logs (
        level, service, correlation_id, guild, user_identifier,
        message, metadata, error_details, created_at
    ) VALUES (
        v_level, v_service, v_corr, v_guild, v_user,
        v_msg, v_meta, v_details, now()
    );

    RETURN true;
EXCEPTION
    WHEN OTHERS THEN
        RETURN false;
END;
$$;

-- NOTE: this migration originally created `idx_audit_logs_created_at_recent`
-- on (created_at DESC) to support both rate-limit lookups. That index already
-- existed as `idx_audit_logs_created_at`, and `CREATE INDEX IF NOT EXISTS`
-- cannot detect an equivalent index under a different name -- so it shipped a
-- duplicate, which 20260926270000 drops. Nothing is created here: the index the
-- rate limit needs is already in place.

COMMENT ON FUNCTION public.gm_report_client_error(text, text, text, text, text, text, jsonb, jsonb) IS
    'Unauthenticated crash reporting (ADR-011). `guild` and `user_identifier` are CLIENT-DECLARED and must not be trusted for forensics; metadata.verified_auth_uid carries the only identity the database established. Rate limited per auth.uid() when signed in, and by a shared anonymous ceiling otherwise -- never by the caller-supplied correlation_id, which was finding M17.';

DO $verify$
DECLARE
    v_def text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'gm_report_client_error';

    IF v_def ~ 'correlation_id = v_corr' THEN
        RAISE EXCEPTION 'the rate limit still keys on the caller-supplied correlation_id';
    END IF;
    IF v_def !~ 'verified_auth_uid' THEN
        RAISE EXCEPTION 'the verified identity must be recorded alongside the claimed one';
    END IF;
    IF v_def !~ 'v_json_cap' THEN
        RAISE EXCEPTION 'the jsonb payloads must be bounded';
    END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
