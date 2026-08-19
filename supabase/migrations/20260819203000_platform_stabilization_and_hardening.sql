-- 20260819203000_platform_stabilization_and_hardening.sql
-- Platform Stabilization & PostgreSQL 17 Zero-Trust Hardening
-- 1. Sets search_path TO '' across all SECURITY DEFINER functions
-- 2. Removes obsolete overloaded function signatures
-- 3. Schedules daily pg_cron job for reminder locks purge

-- 1. Fix gm_apply_subscription_payment search_path
CREATE OR REPLACE FUNCTION public.gm_apply_subscription_payment(
    p_order_id text,
    p_token text DEFAULT NULL,
    p_provider text DEFAULT 'stripe',
    p_ext_ref text DEFAULT NULL
)
RETURNS TABLE(ok boolean, guild_id text, plan_key text, days_added integer, error text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_payment record;
    v_new_end timestamptz;
BEGIN
    SELECT * INTO v_payment
    FROM public.gm_payments
    WHERE order_id = p_order_id OR token = p_token OR merchant_order_ext_ref = p_ext_ref
    LIMIT 1;

    IF v_payment.id IS NULL THEN
        RETURN QUERY SELECT false, NULL::text, NULL::text, NULL::int, 'payment_not_found'::text;
        RETURN;
    END IF;

    IF v_payment.status = 'completed' THEN
        RETURN QUERY SELECT true, v_payment.guild_id, v_payment.plan_key, v_payment.days_added, NULL::text;
        RETURN;
    END IF;

    v_new_end := GREATEST(now(), COALESCE((SELECT subscription_end FROM public.guilds WHERE id = v_payment.guild_id), now())) + (v_payment.days_added || ' days')::interval;

    UPDATE public.guilds
    SET subscription_type = v_payment.plan_key,
        subscription_end = v_new_end,
        updated_at = now()
    WHERE id = v_payment.guild_id;

    UPDATE public.gm_payments
    SET status = 'completed',
        applied_at = now(),
        updated_at = now()
    WHERE id = v_payment.id;

    RETURN QUERY SELECT true, v_payment.guild_id, v_payment.plan_key, v_payment.days_added, NULL::text;
END;
$$;

-- 2. Fix gm_guild_benchmark search_path
CREATE OR REPLACE FUNCTION public.gm_guild_benchmark()
RETURNS TABLE(
    guild text,
    server_number text,
    members integer,
    total_power bigint,
    max_power bigint,
    avg_power bigint,
    active_events integer,
    participation_rate numeric,
    inactive_members integer,
    subscription_type text,
    push_subs integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
BEGIN
  IF NOT public.is_super_admin() THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH guilds AS (
    SELECT g.id AS guild, g.server_number, g.subscription_type
    FROM public.guilds g
  ),
  members AS (
    SELECT m.guild,
           count(*)::int AS members,
           coalesce(sum(m.overall_power), 0)::bigint AS total_power,
           coalesce(max(m.overall_power), 0)::bigint AS max_power,
           coalesce(round(avg(m.overall_power)), 0)::bigint AS avg_power
    FROM public.guild_members m
    GROUP BY m.guild
  ),
  active_events AS (
    SELECT es.guild, count(*)::int AS active_events
    FROM public.event_status es
    WHERE es.is_active = true
    GROUP BY es.guild
  ),
  participation AS (
    SELECT
      wk.guild,
      round(avg(wk.rate) * 100)::numeric AS participation_rate
    FROM (
      SELECT
        ep0.guild,
        ep0.week_start,
        count(distinct ep0.pseudo)::numeric /
          nullif((SELECT count(*) FROM public.guild_members gm WHERE gm.guild = ep0.guild), 0) AS rate,
        row_number() over (
          partition by ep0.guild
          order by ep0.week_start desc
        ) AS rn
      FROM public.event_participants ep0
      WHERE ep0.event_name <> 'Glory'
        AND ep0.is_pending = false
        AND (ep0.participated > 0 OR ep0.sub_present = true)
      GROUP BY ep0.guild, ep0.week_start
    ) wk
    WHERE wk.rn <= 8
    GROUP BY wk.guild
  ),
  inactive AS (
    SELECT
      gm.guild,
      count(*)::int AS inactive_members
    FROM public.guild_members gm
    WHERE NOT EXISTS (
      SELECT 1 FROM public.event_participants ep
      WHERE ep.guild = gm.guild
        AND ep.pseudo = gm.pseudo
        AND ep.event_name <> 'Glory'
        AND (ep.participated > 0 OR ep.sub_present = true)
        AND ep.week_start >= (
          SELECT (max(w.week_start) - interval '7 days')::date
          FROM public.event_participants w
          WHERE w.guild = gm.guild AND w.event_name <> 'Glory'
        )
    )
    GROUP BY gm.guild
  ),
  push AS (
    SELECT p.guild, count(*)::int AS push_subs
    FROM public.push_subscriptions p
    GROUP BY p.guild
  )
  SELECT
    g.guild,
    g.server_number,
    coalesce(m.members, 0),
    coalesce(m.total_power, 0),
    coalesce(m.max_power, 0),
    coalesce(m.avg_power, 0),
    coalesce(ae.active_events, 0),
    coalesce(p.participation_rate, 0),
    coalesce(i.inactive_members, 0),
    coalesce(g.subscription_type, 'Standard'),
    coalesce(pu.push_subs, 0)
  FROM guilds g
  LEFT JOIN members m ON m.guild = g.guild
  LEFT JOIN active_events ae ON ae.guild = g.guild
  LEFT JOIN participation p ON p.guild = g.guild
  LEFT JOIN inactive i ON i.guild = g.guild
  LEFT JOIN push pu ON pu.guild = g.guild
  ORDER BY coalesce(m.total_power, 0) desc;
END;
$$;

-- 3. Fix gm_gvg_guild_matchup search_path
CREATE OR REPLACE FUNCTION public.gm_gvg_guild_matchup()
RETURNS TABLE(
    guild text,
    server_number text,
    member_count integer,
    total_power bigint,
    avg_power bigint,
    gvg_count integer,
    avg_prep_score bigint,
    avg_pvp_score bigint,
    total_prep_score bigint,
    total_pvp_score bigint,
    danger_score bigint,
    danger_tier text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF NOT v_super THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH gvg_ep AS (
    SELECT ep0.guild AS guild_id,
           ep0.session_id,
           COALESCE(ep0.score_prep, 0)::bigint AS prep,
           COALESCE(ep0.score_pvp, 0)::bigint  AS pvp
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND ep0.guild <> 'DEMO'
      AND upper(ep0.event_name) = 'GVG'
  ),
  gvg_sessions AS (
    SELECT e.guild_id,
           e.session_id,
           sum(e.prep)::bigint AS sess_prep,
           sum(e.pvp)::bigint  AS sess_pvp
    FROM gvg_ep e
    GROUP BY e.guild_id, e.session_id
  ),
  gvg_guild_stats AS (
    SELECT s.guild_id,
           count(*)::integer AS sess_count,
           round(avg(s.sess_prep))::bigint AS avg_t_prep,
           round(avg(s.sess_pvp))::bigint  AS avg_t_pvp,
           round(avg(e0.prep))::bigint     AS avg_m_prep,
           round(avg(e0.pvp))::bigint      AS avg_m_pvp
    FROM gvg_sessions s
    JOIN gvg_ep e0 ON e0.guild_id = s.guild_id
    GROUP BY s.guild_id
  ),
  guild_roster AS (
    SELECT m.guild AS guild_id,
           g.server_number,
           count(*)::integer AS member_cnt,
           COALESCE(sum(m.overall_power), 0)::bigint AS tot_power,
           COALESCE(round(avg(m.overall_power)), 0)::bigint AS avg_power
    FROM public.guild_members m
    LEFT JOIN public.guilds g ON g.id = m.guild
    WHERE m.guild <> 'DEMO'
    GROUP BY m.guild, g.server_number
  ),
  calc AS (
    SELECT r.guild_id AS guild,
           COALESCE(r.server_number, '')::text AS server_number,
           r.member_cnt AS member_count,
           r.tot_power AS total_power,
           r.avg_power,
           COALESCE(gs.sess_count, 0)::integer AS gvg_count,
           COALESCE(gs.avg_m_prep, 0)::bigint AS avg_prep_score,
           COALESCE(gs.avg_m_pvp, 0)::bigint AS avg_pvp_score,
           COALESCE(gs.avg_t_prep, 0)::bigint AS total_prep_score,
           COALESCE(gs.avg_t_pvp, 0)::bigint AS total_pvp_score,
           (
             r.tot_power +
             (COALESCE(gs.avg_t_prep, 0) * 2) +
             (COALESCE(gs.avg_t_pvp, 0) * 5)
           )::numeric AS raw_danger,
           CASE
             WHEN r.tot_power < 1500000000 THEN 0.40
             WHEN r.tot_power <= 3500000000 THEN 0.70
             ELSE 1.00
           END AS power_mult
    FROM guild_roster r
    LEFT JOIN gvg_guild_stats gs ON gs.guild_id = r.guild_id
  ),
  combined AS (
    SELECT c.guild,
           c.server_number,
           c.member_count,
           c.total_power,
           c.avg_power,
           c.gvg_count,
           c.avg_prep_score,
           c.avg_pvp_score,
           c.total_prep_score,
           c.total_pvp_score,
           round(c.raw_danger * c.power_mult)::bigint AS danger_score
    FROM calc c
  )
  SELECT c.guild,
         c.server_number,
         c.member_count,
         c.total_power,
         c.avg_power,
         c.gvg_count,
         c.avg_prep_score,
         c.avg_pvp_score,
         c.total_prep_score,
         c.total_pvp_score,
         c.danger_score,
         CASE
           WHEN c.danger_score >= 3000000000 THEN 'EXTREME'
           WHEN c.danger_score >= 1500000000 THEN 'HIGH'
           WHEN c.danger_score >= 500000000  THEN 'MEDIUM'
           ELSE 'LOW'
         END AS danger_tier
  FROM combined c
  ORDER BY c.danger_score DESC, c.total_power DESC;
END;
$$;

-- 4. Fix gm_gvg_player_matchup search_path
CREATE OR REPLACE FUNCTION public.gm_gvg_player_matchup()
RETURNS TABLE(
    pseudo text,
    guild text,
    server_number text,
    power bigint,
    gvg_count integer,
    avg_prep_score bigint,
    avg_pvp_score bigint,
    max_prep_score bigint,
    max_pvp_score bigint,
    danger_score bigint,
    danger_tier text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF NOT v_super THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH gvg_ep AS (
    SELECT ep0.guild AS guild_id,
           lower(btrim(ep0.pseudo)) AS nkey,
           ep0.pseudo,
           COALESCE(ep0.score_prep, 0)::bigint AS prep,
           COALESCE(ep0.score_pvp, 0)::bigint  AS pvp,
           COALESCE(ep0.score, 0)::bigint      AS total_score
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND ep0.guild <> 'DEMO'
      AND upper(ep0.event_name) = 'GVG'
  ),
  gvg_stats AS (
    SELECT e.guild_id,
           e.nkey,
           count(*)::integer AS sess_count,
           round(avg(e.prep))::bigint AS a_prep,
           round(avg(e.pvp))::bigint AS a_pvp,
           max(e.prep)::bigint AS m_prep,
           max(e.pvp)::bigint AS m_pvp
    FROM gvg_ep e
    GROUP BY e.guild_id, e.nkey
  ),
  roster AS (
    SELECT DISTINCT ON (m.guild, lower(btrim(m.pseudo)))
           m.guild AS guild_id,
           g.server_number,
           m.pseudo,
           m.overall_power AS power
    FROM public.guild_members m
    LEFT JOIN public.guilds g ON g.id = m.guild
    WHERE m.guild <> 'DEMO'
    ORDER BY m.guild, lower(btrim(m.pseudo)), m.created_at DESC, m.id DESC
  ),
  calc AS (
    SELECT r.pseudo,
           r.guild_id AS guild,
           COALESCE(r.server_number, '')::text AS server_number,
           COALESCE(r.power, 0)::bigint AS power,
           COALESCE(st.sess_count, 0)::integer AS gvg_count,
           COALESCE(st.a_prep, 0)::bigint AS avg_prep_score,
           COALESCE(st.a_pvp, 0)::bigint AS avg_pvp_score,
           COALESCE(st.m_prep, 0)::bigint AS max_prep_score,
           COALESCE(st.m_pvp, 0)::bigint AS max_pvp_score,
           (
             COALESCE(r.power, 0) +
             (COALESCE(st.a_prep, 0) * 2) +
             (COALESCE(st.a_pvp, 0) * 5)
           )::numeric AS raw_danger,
           CASE
             WHEN COALESCE(r.power, 0) < 60000000 THEN 0.30
             WHEN COALESCE(r.power, 0) <= 90000000 THEN 0.65
             ELSE 1.00
           END AS power_mult
    FROM roster r
    LEFT JOIN gvg_stats st ON st.guild_id = r.guild_id AND st.nkey = lower(btrim(r.pseudo))
  ),
  combined AS (
    SELECT c.pseudo,
           c.guild,
           c.server_number,
           c.power,
           c.gvg_count,
           c.avg_prep_score,
           c.avg_pvp_score,
           c.max_prep_score,
           c.max_pvp_score,
           round(c.raw_danger * c.power_mult)::bigint AS danger_score
    FROM calc c
  )
  SELECT c.pseudo,
         c.guild,
         c.server_number,
         c.power,
         c.gvg_count,
         c.avg_prep_score,
         c.avg_pvp_score,
         c.max_prep_score,
         c.max_pvp_score,
         c.danger_score,
         CASE
           WHEN c.danger_score >= 100000000 THEN 'EXTREME'
           WHEN c.danger_score >= 45000000  THEN 'HIGH'
           WHEN c.danger_score >= 15000000  THEN 'MEDIUM'
           ELSE 'LOW'
         END AS danger_tier
  FROM combined c
  ORDER BY c.danger_score DESC, c.power DESC;
END;
$$;

-- 5. Fix gm_svs_server_matchup search_path
CREATE OR REPLACE FUNCTION public.gm_svs_server_matchup()
RETURNS TABLE(
    pseudo text,
    guild text,
    server_number text,
    power bigint,
    svs_count integer,
    avg_prep_score bigint,
    avg_pvp_score bigint,
    max_prep_score bigint,
    max_pvp_score bigint,
    danger_score bigint,
    danger_tier text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_super boolean;
BEGIN
  SELECT public.is_super_admin() INTO v_super;
  IF NOT v_super THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH svs_ep AS (
    SELECT ep0.guild AS guild_id,
           lower(btrim(ep0.pseudo)) AS nkey,
           ep0.pseudo,
           COALESCE(ep0.score_prep, 0)::bigint AS prep,
           COALESCE(ep0.score_pvp, 0)::bigint  AS pvp,
           COALESCE(ep0.score, 0)::bigint      AS total_score
    FROM public.event_participants ep0
    WHERE ep0.is_pending = false
      AND ep0.guild <> 'DEMO'
      AND upper(ep0.event_name) = 'SVS'
  ),
  svs_stats AS (
    SELECT e.guild_id,
           e.nkey,
           count(*)::integer AS sess_count,
           round(avg(e.prep))::bigint AS a_prep,
           round(avg(e.pvp))::bigint AS a_pvp,
           max(e.prep)::bigint AS m_prep,
           max(e.pvp)::bigint AS m_pvp
    FROM svs_ep e
    GROUP BY e.guild_id, e.nkey
  ),
  roster AS (
    SELECT DISTINCT ON (m.guild, lower(btrim(m.pseudo)))
           m.guild AS guild_id,
           g.server_number,
           m.pseudo,
           m.overall_power AS power
    FROM public.guild_members m
    LEFT JOIN public.guilds g ON g.id = m.guild
    WHERE m.guild <> 'DEMO'
    ORDER BY m.guild, lower(btrim(m.pseudo)), m.created_at DESC, m.id DESC
  ),
  calc AS (
    SELECT r.pseudo,
           r.guild_id AS guild,
           COALESCE(r.server_number, '')::text AS server_number,
           COALESCE(r.power, 0)::bigint AS power,
           COALESCE(st.sess_count, 0)::integer AS svs_count,
           COALESCE(st.a_prep, 0)::bigint AS avg_prep_score,
           COALESCE(st.a_pvp, 0)::bigint AS avg_pvp_score,
           COALESCE(st.m_prep, 0)::bigint AS max_prep_score,
           COALESCE(st.m_pvp, 0)::bigint AS max_pvp_score,
           (
             COALESCE(r.power, 0) +
             (COALESCE(st.a_prep, 0) * 2) +
             (COALESCE(st.a_pvp, 0) * 5)
           )::numeric AS raw_danger,
           CASE
             WHEN COALESCE(r.power, 0) < 60000000 THEN 0.30
             WHEN COALESCE(r.power, 0) <= 90000000 THEN 0.65
             ELSE 1.00
           END AS power_mult
    FROM roster r
    LEFT JOIN svs_stats st ON st.guild_id = r.guild_id AND st.nkey = lower(btrim(r.pseudo))
  ),
  combined AS (
    SELECT c.pseudo,
           c.guild,
           c.server_number,
           c.power,
           c.svs_count,
           c.avg_prep_score,
           c.avg_pvp_score,
           c.max_prep_score,
           c.max_pvp_score,
           round(c.raw_danger * c.power_mult)::bigint AS danger_score
    FROM calc c
  )
  SELECT c.pseudo,
         c.guild,
         c.server_number,
         c.power,
         c.svs_count,
         c.avg_prep_score,
         c.avg_pvp_score,
         c.max_prep_score,
         c.max_pvp_score,
         c.danger_score,
         CASE
           WHEN c.danger_score >= 100000000 THEN 'EXTREME'
           WHEN c.danger_score >= 45000000  THEN 'HIGH'
           WHEN c.danger_score >= 15000000  THEN 'MEDIUM'
           ELSE 'LOW'
         END AS danger_tier
  FROM combined c
  ORDER BY c.danger_score DESC, c.power DESC;
END;
$$;

-- 6. Clean up obsolete duplicate function overloads
DROP FUNCTION IF EXISTS public.gm_populate_event_participants(text, text, date);
DROP FUNCTION IF EXISTS public.gm_upsert_player_glory(text, text, text, integer);
DROP FUNCTION IF EXISTS public.gm_transfer_guild_member(text, text);
DROP FUNCTION IF EXISTS public.transfer_guild_member(text, text);

-- 7. Fix gm_transfer_guild_member search_path
CREATE OR REPLACE FUNCTION public.gm_transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_caller_role text;
    v_caller_guild text;
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
    v_uid text;
BEGIN
    SELECT role, guild INTO v_caller_role, v_caller_guild
    FROM public.accounts
    WHERE auth_user_id = auth.uid()
       OR id = COALESCE(auth.jwt()->>'email', auth.jwt()->>'sub', '');

    IF v_caller_role IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
    END IF;

    IF v_caller_role = 'super_admin' THEN
        IF p_pseudo IS NOT NULL AND p_pseudo <> '' THEN
            SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
            FROM public.guild_members
            WHERE uid = p_uid AND LOWER(pseudo) = LOWER(p_pseudo)
            ORDER BY created_at DESC
            LIMIT 1;
        ELSE
            SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
            FROM public.guild_members
            WHERE uid = p_uid
            ORDER BY created_at DESC
            LIMIT 1;
        END IF;
    ELSE
        SELECT guild, pseudo, uid INTO v_source_guild, v_pseudo, v_uid
        FROM public.guild_members
        WHERE uid = p_uid
          AND guild = COALESCE(v_caller_guild, 'ALPHA');
    END IF;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF v_caller_role <> 'super_admin' AND v_caller_guild <> v_source_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'permission_denied');
    END IF;

    IF v_caller_role <> 'super_admin' AND NOT public.is_subscription_active(v_source_guild) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_members WHERE guild = p_target_guild AND LOWER(pseudo) = LOWER(v_pseudo)) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'duplicate_pseudo_in_target');
    END IF;

    -- Update member guild
    UPDATE public.guild_members
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND pseudo = v_pseudo
      AND guild = v_source_guild;

    -- Update account guild if player account exists
    UPDATE public.accounts
    SET guild = p_target_guild
    WHERE uid = v_uid
      AND role = 'member';

    -- Clean up unparticipated active event rows in source guild
    PERFORM public.gm_remove_member_from_active_events(v_pseudo, v_source_guild);

    -- Auto-enroll member into active event sessions in target guild
    PERFORM public.gm_add_member_to_active_events(v_pseudo, p_target_guild);

    RETURN jsonb_build_object(
        'ok', true,
        'pseudo', v_pseudo,
        'source_guild', v_source_guild,
        'target_guild', p_target_guild,
        'server_number', v_source_server
    );
END;
$$;

-- 8. Fix transfer_guild_member wrapper search_path
CREATE OR REPLACE FUNCTION public.transfer_guild_member(p_uid text, p_target_guild text, p_pseudo text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT public.gm_transfer_guild_member(p_uid, p_target_guild, p_pseudo);
$$;

-- 9. Fix request_guild_transfer search_path
CREATE OR REPLACE FUNCTION public.request_guild_transfer(p_uid text, p_target_guild text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_source_guild text;
    v_source_server text;
    v_target_server text;
    v_pseudo text;
BEGIN
    SELECT guild, pseudo INTO v_source_guild, v_pseudo
    FROM public.guild_members
    WHERE uid = p_uid;

    IF v_source_guild IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'member_not_found');
    END IF;

    IF v_source_guild = p_target_guild THEN
        RETURN jsonb_build_object('ok', false, 'error', 'same_guild');
    END IF;

    SELECT server_number INTO v_source_server FROM public.guilds WHERE id = v_source_guild;
    SELECT server_number INTO v_target_server FROM public.guilds WHERE id = p_target_guild;

    IF v_target_server IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'target_guild_not_found');
    END IF;

    IF v_source_server IS NULL OR v_target_server IS NULL OR v_source_server <> v_target_server THEN
        RETURN jsonb_build_object('ok', false, 'error', 'different_server');
    END IF;

    IF EXISTS (SELECT 1 FROM public.guild_transfers WHERE uid = p_uid AND status = 'pending') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'already_pending');
    END IF;

    INSERT INTO public.guild_transfers (uid, pseudo, source_guild, target_guild, status)
    VALUES (p_uid, v_pseudo, v_source_guild, p_target_guild, 'pending');

    RETURN jsonb_build_object('ok', true, 'message', 'transfer_requested');
END;
$$;

-- 10. Schedule daily pg_cron job for reminder locks cleanup
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.unschedule('daily-cleanup-stale-locks');
        PERFORM cron.schedule(
            'daily-cleanup-stale-locks',
            '0 4 * * *',
            'SELECT public.gm_cleanup_stale_reminder_locks();'
        );
    END IF;
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

-- 11. Run initial cleanup of locks older than 14 days
SELECT public.gm_cleanup_stale_reminder_locks();

-- Revoke execute from public/anon on all modified RPCs and grant to authenticated
REVOKE ALL ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_apply_subscription_payment(text, text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_guild_benchmark() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_guild_benchmark() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_gvg_guild_matchup() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_gvg_guild_matchup() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_gvg_player_matchup() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_gvg_player_matchup() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_svs_server_matchup() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_svs_server_matchup() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.gm_transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_transfer_guild_member(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.transfer_guild_member(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.transfer_guild_member(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.request_guild_transfer(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_guild_transfer(text, text) TO authenticated, service_role;

-- 12. Drop obsolete prototype reminders function
DROP FUNCTION IF EXISTS public.check_and_send_discord_reminders();
DROP FUNCTION IF EXISTS public.gm_apply_subscription_payment(text);

-- 13. Fix check_uid_exists_globally search_path
CREATE OR REPLACE FUNCTION public.check_uid_exists_globally(p_uid text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_exists boolean;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.guild_members WHERE uid = p_uid
    ) INTO v_exists;
    RETURN v_exists;
END;
$$;

-- 14. Fix check_user_guild_access search_path
CREATE OR REPLACE FUNCTION public.check_user_guild_access(p_guild text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text;
  v_guild text;
  v_effective_guild text;
BEGIN
  SELECT role, guild INTO v_role, v_guild
  FROM public.accounts
  WHERE auth_user_id = auth.uid();

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  v_effective_guild := COALESCE(p_guild, 'ALPHA');
  RETURN v_guild = v_effective_guild OR v_guild IS NULL OR v_guild = 'ALL';
END;
$$;

-- 15. Fix get_push_config search_path
CREATE OR REPLACE FUNCTION public.get_push_config()
RETURNS TABLE(vapid_public text, vapid_private text, vapid_subject text, cron_secret text)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO ''
AS $$
    SELECT
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'vapid_public_key'),
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'vapid_private_key'),
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'vapid_subject'),
        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'push_cron_secret');
$$;

REVOKE ALL ON FUNCTION public.check_uid_exists_globally(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_uid_exists_globally(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.check_user_guild_access(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.check_user_guild_access(text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_push_config() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.get_push_config() TO service_role;

