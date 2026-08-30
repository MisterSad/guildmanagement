-- ============================================================================
-- Promote 4 archive-only event RPCs into the canonical migration set
-- ============================================================================
-- gm_sync_shadowfront_participants, gm_unsync_shadowfront_participant,
-- gm_approve_participant_submission and gm_list_event_sessions are all live
-- in production today and are exactly what the front-end calls
-- (shadowfront.js, events.js, history.js) — but their CREATE OR REPLACE
-- FUNCTION source only ever existed in supabase/migrations_archive/, which
-- was superseded by the "ADR-004 canonical schema consolidation"
-- (20260812000001-4) without carrying these four forward. A database
-- re-provisioned from supabase/migrations/ alone (disaster recovery, a
-- fresh environment, a Supabase branch) would be missing all four.
--
-- Bodies below are sourced from the chronologically latest archive
-- definition of each (verified against every archive file that redefines
-- them), with two deliberate, consistent corrections applied to all four
-- while promoting — not a silent behavior change, an actual gap being
-- closed:
--   1. Each only ever handled 'guild_admin' (scoped to their own guild) vs.
--      everyone else (unscoped — could target ANY guild, including
--      'server_admin', a role that didn't exist yet when these were first
--      written). Added a proper server_admin branch scoped to guilds on
--      their own server_number, matching the pattern already established
--      for the transfer RPCs in 20260830070000.
--   2. The caller lookup now also requires status = 'active', matching
--      every other canonical SECURITY DEFINER function in this schema —
--      the archived versions predate that convention and would let a
--      deactivated admin account still call them.
--
-- Also promotes the handful of indexes/FK/default this archive file added
-- alongside gm_sync_shadowfront_participants — confirmed live via direct
-- query against the production database (they exist, so this is a no-op
-- IF NOT EXISTS/idempotent re-apply for canonical-file parity, not a new
-- schema change).
-- ============================================================================

-- 1. gm_approve_participant_submission (events.js SvS/GvG/DTR approve/approve-all)
CREATE OR REPLACE FUNCTION public.gm_approve_participant_submission(
    p_guild text,
    p_event_name text,
    p_session_id text,
    p_pseudo text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_server text;
    v_target text;
    v_updated integer;
BEGIN
    IF p_guild IS NULL OR p_event_name IS NULL OR p_pseudo IS NULL OR p_session_id IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'missing_parameters');
    END IF;

    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    v_target := COALESCE(UPPER(p_guild), 'ALPHA');

    IF v_caller_role = 'guild_admin' THEN
        IF v_target <> COALESCE(v_caller_guild, '') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    ELSIF v_caller_role = 'server_admin' THEN
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
            RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
        END IF;
    END IF;

    UPDATE public.event_participants
    SET is_pending = false
    WHERE guild = v_target
      AND event_name = p_event_name
      AND session_id = p_session_id
      AND LOWER(pseudo) = LOWER(p_pseudo);
    GET DIAGNOSTICS v_updated = ROW_COUNT;

    RETURN jsonb_build_object('ok', true, 'updated', v_updated);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_approve_participant_submission(text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_approve_participant_submission(text, text, text, text) TO authenticated;

-- 2. gm_list_event_sessions (history.js — entire History tab data source)
DROP FUNCTION IF EXISTS public.gm_list_event_sessions(text);
CREATE OR REPLACE FUNCTION public.gm_list_event_sessions(p_guild text DEFAULT NULL::text)
RETURNS TABLE(
    event_name text,
    display_name text,
    session_id text,
    week_start date,
    start_at timestamptz,
    participants integer,
    participated_count integer,
    total_score bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_guild text;
    v_target_server text;
BEGIN
    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    -- Only admins (or super admins) may list sessions; members use the portal.
    IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
        RETURN;
    END IF;

    IF v_caller_role = 'guild_admin' THEN
        v_target_guild := COALESCE(v_caller_guild, 'ALPHA');
    ELSIF v_caller_role = 'server_admin' THEN
        v_target_guild := COALESCE(p_guild, v_caller_guild, 'ALPHA');
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target_guild;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
            RETURN;
        END IF;
    ELSE
        v_target_guild := COALESCE(p_guild, v_caller_guild, 'ALPHA');
    END IF;

    RETURN QUERY
    SELECT
        ep.event_name,
        COALESCE(es.event_name, ep.event_name) AS display_name,
        COALESCE(ep.session_id, ep.week_start::text) AS session_id,
        MIN(ep.week_start) AS week_start,
        MAX(es.start_at) AS start_at,
        COUNT(*)::integer AS participants,
        SUM(CASE WHEN ep.participated > 0 OR COALESCE(ep.score, 0) > 0 OR COALESCE(ep.score_prep, 0) > 0 OR COALESCE(ep.score_pvp, 0) > 0 THEN 1 ELSE 0 END)::integer AS participated_count,
        SUM(COALESCE(ep.score, 0) + COALESCE(ep.score_prep, 0) + COALESCE(ep.score_pvp, 0))::bigint AS total_score
    FROM public.event_participants ep
    LEFT JOIN public.event_status es
      ON es.guild = ep.guild
     AND es.session_id = ep.session_id
     AND (
       LOWER(es.event_name) = LOWER(ep.event_name)
       OR (ep.event_name = 'Shadowfront' AND es.event_name LIKE 'Shadowfront%')
     )
    WHERE ep.guild = v_target_guild
    GROUP BY ep.event_name, COALESCE(es.event_name, ep.event_name), COALESCE(ep.session_id, ep.week_start::text)
    ORDER BY COALESCE(
      MAX(es.start_at),
      CASE
        WHEN MIN(COALESCE(ep.session_id, '')) ~ '-[0-9]{8}(-[0-9]+)?$'
        THEN to_timestamp(
               substring(MIN(ep.session_id) FROM '-([0-9]{8})'),
               'YYYYMMDD'
             ) AT TIME ZONE 'UTC'
        ELSE NULL
      END,
      (MIN(ep.week_start) || 'T12:00:00')::timestamptz
    ) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_list_event_sessions(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_event_sessions(text) TO authenticated;

-- 3. gm_sync_shadowfront_participants (shadowfront.js — populates event_participants after squad composition)
DROP FUNCTION IF EXISTS public.gm_sync_shadowfront_participants(text, text);
CREATE OR REPLACE FUNCTION public.gm_sync_shadowfront_participants(p_guild text, p_session_id text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_server text;
    v_target text;
    v_inserted integer;
    v_week date;
BEGIN
    IF p_guild IS NULL OR p_session_id IS NULL OR p_session_id = '' THEN
        RAISE EXCEPTION 'missing_parameters';
    END IF;

    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
        RAISE EXCEPTION 'not_authorized';
    END IF;

    v_target := COALESCE(UPPER(p_guild), 'ALPHA');

    IF v_caller_role = 'guild_admin' THEN
        IF v_target <> COALESCE(v_caller_guild, '') THEN
            RAISE EXCEPTION 'not_authorized';
        END IF;
    ELSIF v_caller_role = 'server_admin' THEN
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = v_target;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
            RAISE EXCEPTION 'not_authorized';
        END IF;
    END IF;

    -- Resolve week from event_status start_at date, falling back to current week start
    SELECT (date_trunc('week', es.start_at AT TIME ZONE 'UTC'))::date INTO v_week
    FROM public.event_status es
    WHERE es.guild = v_target AND es.session_id = p_session_id
    LIMIT 1;

    IF v_week IS NULL THEN
        SELECT (date_trunc('week', now() AT TIME ZONE 'UTC'))::date INTO v_week;
    END IF;

    WITH ins AS (
        INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated)
        SELECT
            v_target,
            'Shadowfront',
            p_session_id,
            v_week,
            s.pseudo,
            0
        FROM public.shadowfront_squads s
        WHERE s.guild = v_target
          AND s.session_id = p_session_id
          AND EXISTS (
            SELECT 1 FROM public.guild_members gm
            WHERE gm.guild = v_target AND LOWER(gm.pseudo) = LOWER(s.pseudo)
          )
        ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO v_inserted FROM ins;

    RETURN COALESCE(v_inserted, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_sync_shadowfront_participants(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_sync_shadowfront_participants(text, text) TO authenticated;

-- 4. gm_unsync_shadowfront_participant (shadowfront.js — atomic squad unassignment)
DROP FUNCTION IF EXISTS public.gm_unsync_shadowfront_participant(text, text, text);
CREATE OR REPLACE FUNCTION public.gm_unsync_shadowfront_participant(
    p_guild text,
    p_session_id text,
    p_pseudo text
) RETURNS TABLE(ok boolean, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_caller_server text;
    v_target_server text;
BEGIN
    IF p_guild IS NULL OR p_session_id IS NULL OR p_pseudo IS NULL THEN
        RETURN QUERY SELECT false, 'missing_parameters'::text;
        RETURN;
    END IF;

    SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
    INTO v_caller_role, v_caller_guild, v_caller_server
    FROM public.accounts a
    LEFT JOIN public.guilds g ON g.id = a.guild
    WHERE a.auth_user_id = auth.uid() AND a.status = 'active';

    IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
        RETURN QUERY SELECT false, 'not_authorized'::text;
        RETURN;
    END IF;

    IF v_caller_role = 'guild_admin' AND p_guild <> COALESCE(v_caller_guild, '') THEN
        RETURN QUERY SELECT false, 'not_authorized'::text;
        RETURN;
    END IF;

    IF v_caller_role = 'server_admin' THEN
        SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_guild;
        IF v_caller_server IS NULL OR v_target_server IS NULL OR v_target_server <> v_caller_server THEN
            RETURN QUERY SELECT false, 'not_authorized'::text;
            RETURN;
        END IF;
    END IF;

    DELETE FROM public.shadowfront_squads
    WHERE guild = p_guild AND session_id = p_session_id AND LOWER(pseudo) = LOWER(p_pseudo);

    DELETE FROM public.event_participants
    WHERE guild = p_guild AND session_id = p_session_id AND LOWER(pseudo) = LOWER(p_pseudo)
      AND LOWER(event_name) LIKE '%shadowfront%';

    RETURN QUERY SELECT true, NULL::text;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_unsync_shadowfront_participant(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_unsync_shadowfront_participant(text, text, text) TO authenticated;

-- 5. Auxiliary indexes/FK/default from the same archive file (confirmed live; promoted for canonical-file parity)
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_guild ON public.shadowfront_signups(guild);
CREATE INDEX IF NOT EXISTS idx_player_name_history_guild ON public.player_name_history(guild);
CREATE INDEX IF NOT EXISTS idx_ep_guild_week ON public.event_participants(guild, week_start);
CREATE INDEX IF NOT EXISTS idx_ep_guild_pseudo ON public.event_participants(guild, lower(pseudo));

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'fk_pnh_guild' AND table_name = 'player_name_history'
    ) THEN
        ALTER TABLE public.player_name_history
            ADD CONSTRAINT fk_pnh_guild FOREIGN KEY (guild) REFERENCES public.guilds(id) ON DELETE CASCADE;
    END IF;
END $$;

ALTER TABLE public.sanctions ALTER COLUMN created_by SET DEFAULT (COALESCE(auth.uid()::text, 'Admin'));

NOTIFY pgrst, 'reload schema';
