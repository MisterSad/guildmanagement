-- 20260810010000_fix_shadowfront_sync_and_indexes.sql
-- 1. Fix gm_sync_shadowfront_participants date lookup (event_status start_at instead of invalid timestamp cast).
-- 2. Add gm_unsync_shadowfront_participant RPC for atomic squad unassignment.
-- 3. Add missing tenant and composite indexes for multi-tenant query speed.
-- 4. Add FK on player_name_history(guild).
-- 5. Add DEFAULT constraint on sanctions.created_by.

-- 1. Fix gm_sync_shadowfront_participants
DROP FUNCTION IF EXISTS public.gm_sync_shadowfront_participants(text, text);
CREATE OR REPLACE FUNCTION public.gm_sync_shadowfront_participants(p_guild text, p_session_id text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_caller_guild text;
  v_target text;
  v_inserted integer;
  v_week date;
BEGIN
  IF p_guild IS NULL OR p_session_id IS NULL OR p_session_id = '' THEN
    RAISE EXCEPTION 'missing_parameters';
  END IF;

  SELECT role, guild INTO v_caller_role, v_caller_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  IF v_caller_role = 'guild_admin' THEN
    v_target := coalesce(v_caller_guild, 'ALPHA');
    IF p_guild <> v_target THEN
      RAISE EXCEPTION 'not_authorized';
    END IF;
  ELSE
    v_target := coalesce(upper(p_guild), 'ALPHA');
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
        WHERE gm.guild = v_target AND lower(gm.pseudo) = lower(s.pseudo)
      )
    ON CONFLICT (guild, event_name, session_id, pseudo) WHERE session_id IS NOT NULL DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_inserted FROM ins;

  RETURN coalesce(v_inserted, 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_sync_shadowfront_participants(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_sync_shadowfront_participants(text, text) TO authenticated;

-- 2. Atomic unassign RPC for Shadowfront
DROP FUNCTION IF EXISTS public.gm_unsync_shadowfront_participant(text, text, text);
CREATE OR REPLACE FUNCTION public.gm_unsync_shadowfront_participant(
  p_guild text,
  p_session_id text,
  p_pseudo text
)
 RETURNS table(ok boolean, error text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_caller_role text;
  v_caller_guild text;
BEGIN
  IF p_guild IS NULL OR p_session_id IS NULL OR p_pseudo IS NULL THEN
    RETURN QUERY SELECT false, 'missing_parameters'::text;
    RETURN;
  END IF;

  SELECT role, guild INTO v_caller_role, v_caller_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid()
     OR id = coalesce(auth.jwt()->>'email', auth.jwt()->>'sub', '');

  IF v_caller_role IS NULL OR v_caller_role = 'member' THEN
    RETURN QUERY SELECT false, 'not_authorized'::text;
    RETURN;
  END IF;

  IF v_caller_role = 'guild_admin' AND p_guild <> coalesce(v_caller_guild, '') THEN
    RETURN QUERY SELECT false, 'not_authorized'::text;
    RETURN;
  END IF;

  DELETE FROM public.shadowfront_squads
  WHERE guild = p_guild AND session_id = p_session_id AND lower(pseudo) = lower(p_pseudo);

  DELETE FROM public.event_participants
  WHERE guild = p_guild AND session_id = p_session_id AND lower(pseudo) = lower(p_pseudo)
    AND lower(event_name) LIKE '%shadowfront%';

  RETURN QUERY SELECT true, NULL::text;
END;
$function$;

REVOKE ALL ON FUNCTION public.gm_unsync_shadowfront_participant(text, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gm_unsync_shadowfront_participant(text, text, text) TO authenticated;

-- 3. Indexes for multi-tenant query performance
CREATE INDEX IF NOT EXISTS idx_accounts_guild ON public.accounts(guild);
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_guild ON public.shadowfront_signups(guild);
CREATE INDEX IF NOT EXISTS idx_player_name_history_guild ON public.player_name_history(guild);
CREATE INDEX IF NOT EXISTS idx_ep_guild_week ON public.event_participants(guild, week_start);
CREATE INDEX IF NOT EXISTS idx_ep_guild_pseudo ON public.event_participants(guild, lower(pseudo));

-- 4. Foreign key on player_name_history(guild)
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

-- 5. Set DEFAULT for sanctions created_by
ALTER TABLE public.sanctions ALTER COLUMN created_by SET DEFAULT (coalesce(auth.uid()::text, 'Admin'));

-- Force PostgREST schema cache reload
NOTIFY pgrst, 'reload schema';
