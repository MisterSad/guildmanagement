-- ============================================================================
-- FGF GUILD MANAGEMENT — SvS / GvG GRANULAR EVOLUTION (Lot 1)
-- Migration: 20260914090000_war_daily_scores_and_chest_tiers.sql
-- Description: per-day (Day 1..6) player scores with parametrizable chest
--              tiers, Won/Lost results per day, opponent resolution/creation,
--              and transactional maintenance of event_participants aggregates.
-- Invariants:  Zero-Trust multi-tenant, FORCE ROW LEVEL SECURITY on all new
--              tables, SECURITY DEFINER with SET search_path TO '', role
--              resolution exclusively via public.accounts.
-- Retro-compat: NO destructive ALTER, no backfill of war_sessions (history
--              keeps its legacy score_prep/score_pvp columns); score_prep and
--              score_pvp become DERIVED cache columns only for sessions that
--              opt into the granular grid (a war_sessions row exists).
-- ============================================================================

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- 1.1 war_opponents — per-guild opponent catalog (server or guild copies).
--     Deliberately NOT FK'd to public.guilds: an adversary is a lightweight
--     snapshot, never a tenant. guild_ref only records which registered guild
--     a guild-kind opponent was cloned from (no cross-tenant FK).
CREATE TABLE IF NOT EXISTS public.war_opponents (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild         TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('server', 'guild')),
    name          TEXT NOT NULL,
    server_number TEXT,
    guild_ref     TEXT,
    created_by    TEXT DEFAULT (COALESCE(auth.uid()::text, 'Admin')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT war_opponents_guild_kind_name_key UNIQUE (guild, kind, name)
);

-- 1.2 war_sessions — persistent per-session war metadata (opponent, W/L per
--     day, frozen chest grid). event_status only holds the LIVE session; this
--     table is the durable record that survives week-over-week overwrites.
CREATE TABLE IF NOT EXISTS public.war_sessions (
    id                   BIGSERIAL PRIMARY KEY,
    guild                TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    event_name           TEXT NOT NULL CHECK (event_name IN ('SvS', 'GvG')),
    session_id           TEXT NOT NULL,
    opponent_id          UUID REFERENCES public.war_opponents(id) ON DELETE SET NULL,
    opponent_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
    day1_result          TEXT CHECK (day1_result IN ('won', 'lost')),
    day2_result          TEXT CHECK (day2_result IN ('won', 'lost')),
    day3_result          TEXT CHECK (day3_result IN ('won', 'lost')),
    day4_result          TEXT CHECK (day4_result IN ('won', 'lost')),
    day5_result          TEXT CHECK (day5_result IN ('won', 'lost')),
    day6_result          TEXT CHECK (day6_result IN ('won', 'lost')),
    chest_tiers_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,
    start_at             TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT war_sessions_guild_event_session_key UNIQUE (guild, event_name, session_id)
);

-- 1.3 event_daily_scores — granular per-player per-day scores + chests.
CREATE TABLE IF NOT EXISTS public.event_daily_scores (
    id              BIGSERIAL PRIMARY KEY,
    guild           TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    event_name      TEXT NOT NULL CHECK (event_name IN ('SvS', 'GvG')),
    session_id      TEXT NOT NULL,
    pseudo          TEXT NOT NULL,
    day             SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 6),
    score           INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0),
    chests_unlocked SMALLINT NOT NULL DEFAULT 0 CHECK (chests_unlocked >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT event_daily_scores_guild_event_session_pseudo_day_key
        UNIQUE (guild, event_name, session_id, pseudo, day),
    CONSTRAINT fk_event_daily_scores_member FOREIGN KEY (guild, pseudo)
        REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_event_daily_scores_session FOREIGN KEY (guild, event_name, session_id)
        REFERENCES public.war_sessions(guild, event_name, session_id) ON DELETE CASCADE
);

-- 1.4 event_chest_tiers — parametrizable chest threshold grid (Guild Admin).
--     Edited atomically (gm_save_chest_tiers replaces the whole grid); the
--     active grid is frozen into war_sessions.chest_tiers_snapshot at session
--     open so rebalancing never rewrites history.
CREATE TABLE IF NOT EXISTS public.event_chest_tiers (
    guild      TEXT NOT NULL REFERENCES public.guilds(id) ON DELETE CASCADE,
    event_name TEXT NOT NULL CHECK (event_name IN ('SvS', 'GvG')),
    day        SMALLINT NOT NULL CHECK (day BETWEEN 1 AND 6),
    tier       SMALLINT NOT NULL CHECK (tier >= 1),
    min_score  BIGINT NOT NULL CHECK (min_score >= 0),
    chests     BIGINT NOT NULL DEFAULT 1 CHECK (chests >= 1),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild, event_name, day, tier)
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_war_sessions_guild_event
    ON public.war_sessions(guild, event_name);
CREATE INDEX IF NOT EXISTS idx_war_opponents_guild_kind
    ON public.war_opponents(guild, kind);
CREATE INDEX IF NOT EXISTS idx_eds_session
    ON public.event_daily_scores(guild, event_name, session_id);
CREATE INDEX IF NOT EXISTS idx_eds_player
    ON public.event_daily_scores(guild, event_name, session_id, pseudo);
CREATE INDEX IF NOT EXISTS idx_ect_guild_event_day
    ON public.event_chest_tiers(guild, event_name, day);

-- ============================================================================
-- 3. ROW LEVEL SECURITY (Zero-Trust, FORCE)
-- ============================================================================
ALTER TABLE public.war_opponents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.war_sessions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_daily_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_chest_tiers  ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.war_opponents      FORCE ROW LEVEL SECURITY;
ALTER TABLE public.war_sessions       FORCE ROW LEVEL SECURITY;
ALTER TABLE public.event_daily_scores FORCE ROW LEVEL SECURITY;
ALTER TABLE public.event_chest_tiers  FORCE ROW LEVEL SECURITY;

-- war_opponents
DROP POLICY IF EXISTS war_opponents_select ON public.war_opponents;
CREATE POLICY war_opponents_select ON public.war_opponents
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS war_opponents_insert ON public.war_opponents;
CREATE POLICY war_opponents_insert ON public.war_opponents
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS war_opponents_update ON public.war_opponents;
CREATE POLICY war_opponents_update ON public.war_opponents
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS war_opponents_delete ON public.war_opponents;
CREATE POLICY war_opponents_delete ON public.war_opponents
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- war_sessions
DROP POLICY IF EXISTS war_sessions_select ON public.war_sessions;
CREATE POLICY war_sessions_select ON public.war_sessions
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS war_sessions_insert ON public.war_sessions;
CREATE POLICY war_sessions_insert ON public.war_sessions
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS war_sessions_update ON public.war_sessions;
CREATE POLICY war_sessions_update ON public.war_sessions
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS war_sessions_delete ON public.war_sessions;
CREATE POLICY war_sessions_delete ON public.war_sessions
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- event_daily_scores
DROP POLICY IF EXISTS event_daily_scores_select ON public.event_daily_scores;
CREATE POLICY event_daily_scores_select ON public.event_daily_scores
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS event_daily_scores_insert ON public.event_daily_scores;
CREATE POLICY event_daily_scores_insert ON public.event_daily_scores
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS event_daily_scores_update ON public.event_daily_scores;
CREATE POLICY event_daily_scores_update ON public.event_daily_scores
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS event_daily_scores_delete ON public.event_daily_scores;
CREATE POLICY event_daily_scores_delete ON public.event_daily_scores
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- event_chest_tiers
DROP POLICY IF EXISTS event_chest_tiers_select ON public.event_chest_tiers;
CREATE POLICY event_chest_tiers_select ON public.event_chest_tiers
    FOR SELECT TO authenticated
    USING (public.gm_can_read_guild_data(guild));

DROP POLICY IF EXISTS event_chest_tiers_insert ON public.event_chest_tiers;
CREATE POLICY event_chest_tiers_insert ON public.event_chest_tiers
    FOR INSERT TO authenticated
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS event_chest_tiers_update ON public.event_chest_tiers;
CREATE POLICY event_chest_tiers_update ON public.event_chest_tiers
    FOR UPDATE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild))
    WITH CHECK (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

DROP POLICY IF EXISTS event_chest_tiers_delete ON public.event_chest_tiers;
CREATE POLICY event_chest_tiers_delete ON public.event_chest_tiers
    FOR DELETE TO authenticated
    USING (public.check_user_guild_write_access(guild) AND public.is_subscription_active(guild));

-- ============================================================================
-- 4. DETERMINISTIC SCORING HELPER
-- ============================================================================
-- Number of chests unlocked for a given score against a PER-DAY tier slice
-- (the caller filters the grid by day before calling). Semantics: the highest
-- tier whose min_score <= score defines the (cumulative) chest count. Malformed
-- elements are ignored; empty/null tiers or null score => 0.
-- Mirrored 1:1 in TS: src/core/scoring/chests.ts resolveChestsForScore().
CREATE OR REPLACE FUNCTION public.gm_chests_for_score(p_tiers jsonb, p_score bigint)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
    SELECT COALESCE(MAX((t->>'chests')::integer), 0)::integer
    FROM jsonb_array_elements(COALESCE(p_tiers, '[]'::jsonb)) t
    WHERE p_score IS NOT NULL
      AND p_score >= 0
      AND jsonb_typeof(t->'min_score') = 'number'
      AND jsonb_typeof(t->'chests') = 'number'
      AND (t->>'min_score')::bigint <= p_score
$$;

REVOKE ALL ON FUNCTION public.gm_chests_for_score(jsonb, bigint) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_chests_for_score(jsonb, bigint) TO authenticated;

-- ============================================================================
-- 5. RPC — CHEST GRID
-- ============================================================================

-- 5.1 gm_get_chest_tiers: active grid for (guild, event).
CREATE OR REPLACE FUNCTION public.gm_get_chest_tiers(p_guild text, p_event_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target text := TRIM(p_guild);
    v_event  text := TRIM(p_event_name);
    v_tiers  jsonb;
BEGIN
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object('day', t.day, 'tier', t.tier,
                           'min_score', t.min_score, 'chests', t.chests)
        ORDER BY t.day, t.tier
    ), '[]'::jsonb) INTO v_tiers
    FROM public.event_chest_tiers t
    WHERE t.guild = v_target AND t.event_name = v_event;

    RETURN jsonb_build_object('ok', true, 'guild', v_target,
                              'event_name', v_event, 'tiers', v_tiers);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_chest_tiers(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_chest_tiers(text, text) TO authenticated;

-- 5.2 gm_save_chest_tiers: atomic replace of the active grid (validated, audited).
CREATE OR REPLACE FUNCTION public.gm_save_chest_tiers(p_guild text, p_event_name text, p_tiers jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target    text := TRIM(p_guild);
    v_event     text := TRIM(p_event_name);
    v_seen      text[] := ARRAY[]::text[];
    v_last_min  bigint[] := ARRAY[NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint];
    v_el        jsonb;
    v_day       int;
    v_tier      int;
    v_min_score bigint;
    v_chests    bigint;
    v_n         int := 0;
    v_key       text;
    v_caller_id text;
BEGIN
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF jsonb_typeof(p_tiers) <> 'array' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF jsonb_array_length(p_tiers) > 60 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'too_many_tiers');
    END IF;

    -- Pass 1: validate every tier (bounds, duplicates, ascending thresholds).
    FOR i IN 0 .. jsonb_array_length(p_tiers) - 1 LOOP
        v_el := p_tiers->i;

        IF jsonb_typeof(v_el) <> 'object'
           OR v_el->'day' IS NULL OR jsonb_typeof(v_el->'day') <> 'number'
           OR v_el->'tier' IS NULL OR jsonb_typeof(v_el->'tier') <> 'number'
           OR v_el->'min_score' IS NULL OR jsonb_typeof(v_el->'min_score') <> 'number'
           OR v_el->'chests' IS NULL OR jsonb_typeof(v_el->'chests') <> 'number'
           OR (v_el->>'day') !~ '^[0-9]+$'
           OR (v_el->>'tier') !~ '^[0-9]+$'
           OR (v_el->>'min_score') !~ '^[0-9]+$'
           OR (v_el->>'chests') !~ '^[0-9]+$' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_tier_shape');
        END IF;

        v_day       := (v_el->>'day')::int;
        v_tier      := (v_el->>'tier')::int;
        v_min_score := (v_el->>'min_score')::bigint;
        v_chests    := (v_el->>'chests')::bigint;

        IF v_day BETWEEN 1 AND 6
           AND v_tier >= 1
           AND v_min_score >= 0
           AND v_chests >= 1 THEN
            v_key := v_day::text || ':' || v_tier::text;
            IF v_seen @> ARRAY[v_key] THEN
                RETURN jsonb_build_object('ok', false, 'error', 'duplicate_tier');
            END IF;
            IF v_last_min[v_day] IS NOT NULL AND v_min_score < v_last_min[v_day] THEN
                RETURN jsonb_build_object('ok', false, 'error', 'unsorted_thresholds');
            END IF;
            v_seen     := v_seen || ARRAY[v_key];
            v_last_min[v_day] := v_min_score;
            v_n := v_n + 1;
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;
    END LOOP;

    -- Pass 2: atomic replace.
    DELETE FROM public.event_chest_tiers
    WHERE guild = v_target AND event_name = v_event;

    FOR i IN 0 .. jsonb_array_length(p_tiers) - 1 LOOP
        v_el := p_tiers->i;
        INSERT INTO public.event_chest_tiers (guild, event_name, day, tier, min_score, chests, updated_at)
        VALUES (v_target, v_event,
                (v_el->>'day')::smallint, (v_el->>'tier')::smallint,
                (v_el->>'min_score')::bigint, (v_el->>'chests')::bigint,
                now());
    END LOOP;

    SELECT a.id INTO v_caller_id
    FROM public.accounts a
    WHERE a.auth_user_id = auth.uid() LIMIT 1;

    INSERT INTO public.system_audit_logs (
        level, service, guild, user_identifier, message, metadata, created_at
    ) VALUES (
        'info', 'war_chest_tiers', v_target,
        COALESCE(v_caller_id, auth.uid()::text, 'Admin'),
        'Saved chest tiers',
        jsonb_build_object('event_name', v_event, 'tiers_saved', v_n),
        now()
    );

    RETURN jsonb_build_object('ok', true, 'saved', v_n);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_save_chest_tiers(text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_save_chest_tiers(text, text, jsonb) TO authenticated;

-- ============================================================================
-- 6. RPC — WAR SESSIONS (metadata + opponent + W/L)
-- ============================================================================

-- 6.1 gm_upsert_war_session: resolve-or-create opponent, upsert session meta,
--     freeze the active chest grid on first create.
CREATE OR REPLACE FUNCTION public.gm_upsert_war_session(
    p_guild text,
    p_event_name text,
    p_session_id text,
    p_opponent jsonb DEFAULT NULL,
    p_daily_results jsonb DEFAULT NULL,
    p_start_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target      text := TRIM(p_guild);
    v_event       text := TRIM(p_event_name);
    v_sid         text := TRIM(p_session_id);
    v_kind        text;
    v_name        text;
    v_server      text;
    v_guild_ref   text;
    v_opp_id      uuid;
    v_opp_snap    jsonb;
    v_chest_snap  jsonb;
    v_d1 text; v_d2 text; v_d3 text; v_d4 text; v_d5 text; v_d6 text;
    v_val         text;
    v_sess        public.war_sessions%ROWTYPE;
BEGIN
    IF v_sid = '' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'missing_parameters');
    END IF;
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    -- Daily results (Day 1..6): only provided keys are applied; explicit
    -- null clears a result; anything else is rejected.
    IF p_daily_results IS NOT NULL AND jsonb_typeof(p_daily_results) <> 'object' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF p_daily_results IS NOT NULL THEN
        IF p_daily_results ? 'day1' THEN
            v_val := p_daily_results->>'day1';
            IF v_val IS NULL THEN v_d1 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d1 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day2' THEN
            v_val := p_daily_results->>'day2';
            IF v_val IS NULL THEN v_d2 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d2 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day3' THEN
            v_val := p_daily_results->>'day3';
            IF v_val IS NULL THEN v_d3 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d3 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day4' THEN
            v_val := p_daily_results->>'day4';
            IF v_val IS NULL THEN v_d4 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d4 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day5' THEN
            v_val := p_daily_results->>'day5';
            IF v_val IS NULL THEN v_d5 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d5 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
        IF p_daily_results ? 'day6' THEN
            v_val := p_daily_results->>'day6';
            IF v_val IS NULL THEN v_d6 := NULL;
            ELSIF v_val IN ('won', 'lost') THEN v_d6 := v_val;
            ELSE RETURN jsonb_build_object('ok', false, 'error', 'invalid_result'); END IF;
        END IF;
    END IF;

    -- Opponent resolution (optional): kind in {server, guild}, name required.
    IF p_opponent IS NOT NULL AND jsonb_typeof(p_opponent) <> 'object' THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
    END IF;

    IF p_opponent IS NOT NULL THEN
        v_kind := LOWER(COALESCE(p_opponent->>'kind', ''));
        IF v_kind NOT IN ('server', 'guild') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_opponent_kind');
        END IF;
        v_name := TRIM(COALESCE(p_opponent->>'name', ''));
        v_server := NULLIF(TRIM(COALESCE(p_opponent->>'server_number', '')), '');
        v_guild_ref := NULLIF(TRIM(COALESCE(p_opponent->>'guild_ref', '')), '');

        IF v_guild_ref IS NOT NULL THEN
            SELECT g.name, g.server_number INTO v_name, v_server
            FROM public.guilds g WHERE g.id = v_guild_ref LIMIT 1;
            IF v_name IS NULL THEN v_name := v_guild_ref; END IF;
        END IF;

        IF v_name = '' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'missing_opponent_name');
        END IF;

        SELECT o.id INTO v_opp_id
        FROM public.war_opponents o
        WHERE o.guild = v_target AND o.kind = v_kind AND LOWER(o.name) = LOWER(v_name)
        LIMIT 1;

        IF v_opp_id IS NULL THEN
            INSERT INTO public.war_opponents (guild, kind, name, server_number, guild_ref)
            VALUES (v_target, v_kind, v_name, v_server, v_guild_ref)
            RETURNING id INTO v_opp_id;
        ELSE
            UPDATE public.war_opponents
            SET server_number = COALESCE(v_server, server_number),
                guild_ref     = COALESCE(v_guild_ref, guild_ref),
                updated_at    = now()
            WHERE id = v_opp_id;
        END IF;

        v_opp_snap := jsonb_strip_nulls(jsonb_build_object(
            'kind', v_kind, 'name', v_name,
            'server_number', v_server, 'guild_ref', v_guild_ref
        ));
    END IF;

    -- Freeze the active chest grid (into INSERT branch on first creation).
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object('day', t.day, 'tier', t.tier,
                           'min_score', t.min_score, 'chests', t.chests)
        ORDER BY t.day, t.tier
    ), '[]'::jsonb) INTO v_chest_snap
    FROM public.event_chest_tiers t
    WHERE t.guild = v_target AND t.event_name = v_event;

    INSERT INTO public.war_sessions (
        guild, event_name, session_id, opponent_id, opponent_snapshot,
        day1_result, day2_result, day3_result, day4_result, day5_result, day6_result,
        chest_tiers_snapshot, start_at, updated_at
    ) VALUES (
        v_target, v_event, v_sid, v_opp_id, COALESCE(v_opp_snap, '{}'::jsonb),
        v_d1, v_d2, v_d3, v_d4, v_d5, v_d6,
        v_chest_snap, COALESCE(p_start_at, now()), now()
    )
    ON CONFLICT (guild, event_name, session_id) DO UPDATE SET
        opponent_id       = COALESCE(v_opp_id, war_sessions.opponent_id),
        opponent_snapshot = CASE WHEN v_opp_id IS NULL
                                 THEN war_sessions.opponent_snapshot ELSE EXCLUDED.opponent_snapshot END,
        day1_result       = COALESCE(v_d1, war_sessions.day1_result),
        day2_result       = COALESCE(v_d2, war_sessions.day2_result),
        day3_result       = COALESCE(v_d3, war_sessions.day3_result),
        day4_result       = COALESCE(v_d4, war_sessions.day4_result),
        day5_result       = COALESCE(v_d5, war_sessions.day5_result),
        day6_result       = COALESCE(v_d6, war_sessions.day6_result),
        start_at          = COALESCE(EXCLUDED.start_at, war_sessions.start_at),
        chest_tiers_snapshot = CASE
            WHEN jsonb_array_length(COALESCE(war_sessions.chest_tiers_snapshot, '[]'::jsonb)) = 0
            THEN EXCLUDED.chest_tiers_snapshot
            ELSE war_sessions.chest_tiers_snapshot END,
        updated_at = now()
    RETURNING * INTO v_sess;

    RETURN jsonb_build_object('ok', true, 'session', jsonb_build_object(
        'id', v_sess.id,
        'guild', v_sess.guild,
        'event_name', v_sess.event_name,
        'session_id', v_sess.session_id,
        'opponent_id', v_sess.opponent_id,
        'opponent_snapshot', v_sess.opponent_snapshot,
        'day1_result', v_sess.day1_result,
        'day2_result', v_sess.day2_result,
        'day3_result', v_sess.day3_result,
        'day4_result', v_sess.day4_result,
        'day5_result', v_sess.day5_result,
        'day6_result', v_sess.day6_result,
        'chest_tiers_snapshot', v_sess.chest_tiers_snapshot,
        'start_at', v_sess.start_at,
        'created_at', v_sess.created_at,
        'updated_at', v_sess.updated_at
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_war_session(text, text, text, jsonb, jsonb, timestamptz) TO authenticated;

-- 6.2 gm_get_war_session: session meta (opponent, W/L, frozen grid).
CREATE OR REPLACE FUNCTION public.gm_get_war_session(p_guild text, p_event_name text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target text := TRIM(p_guild);
    v_sess   public.war_sessions%ROWTYPE;
BEGIN
    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT * INTO v_sess
    FROM public.war_sessions
    WHERE guild = v_target AND event_name = TRIM(p_event_name) AND session_id = TRIM(p_session_id)
    LIMIT 1;

    IF v_sess.id IS NULL THEN
        RETURN jsonb_build_object('ok', true, 'session', NULL);
    END IF;

    RETURN jsonb_build_object('ok', true, 'session', jsonb_build_object(
        'id', v_sess.id,
        'guild', v_sess.guild,
        'event_name', v_sess.event_name,
        'session_id', v_sess.session_id,
        'opponent_id', v_sess.opponent_id,
        'opponent_snapshot', v_sess.opponent_snapshot,
        'day1_result', v_sess.day1_result,
        'day2_result', v_sess.day2_result,
        'day3_result', v_sess.day3_result,
        'day4_result', v_sess.day4_result,
        'day5_result', v_sess.day5_result,
        'day6_result', v_sess.day6_result,
        'chest_tiers_snapshot', v_sess.chest_tiers_snapshot,
        'start_at', v_sess.start_at,
        'created_at', v_sess.created_at,
        'updated_at', v_sess.updated_at
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_war_session(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_war_session(text, text, text) TO authenticated;

-- 6.3 gm_list_war_sessions: all sessions for a guild (+ optional event filter).
CREATE OR REPLACE FUNCTION public.gm_list_war_sessions(p_guild text, p_event_name text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target text := TRIM(p_guild);
    v_event  text := NULLIF(TRIM(p_event_name), '');
    v_items  jsonb;
BEGIN
    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
            'id', s.id,
            'guild', s.guild,
            'event_name', s.event_name,
            'session_id', s.session_id,
            'opponent_id', s.opponent_id,
            'opponent_snapshot', s.opponent_snapshot,
            'day1_result', s.day1_result,
            'day2_result', s.day2_result,
            'day3_result', s.day3_result,
            'day4_result', s.day4_result,
            'day5_result', s.day5_result,
            'day6_result', s.day6_result,
            'chest_tiers_snapshot', s.chest_tiers_snapshot,
            'start_at', s.start_at,
            'created_at', s.created_at,
            'updated_at', s.updated_at
        ) ORDER BY COALESCE(s.start_at, s.created_at) DESC
    ), '[]'::jsonb) INTO v_items
    FROM public.war_sessions s
    WHERE s.guild = v_target
      AND (v_event IS NULL OR s.event_name = v_event);

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'sessions', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_list_war_sessions(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_war_sessions(text, text) TO authenticated;

-- 6.4 gm_delete_war_session: tear down a session (daily scores cascade).
CREATE OR REPLACE FUNCTION public.gm_delete_war_session(p_guild text, p_event_name text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target  text := TRIM(p_guild);
    v_deleted boolean;
BEGIN
    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    WITH del AS (
        DELETE FROM public.war_sessions
        WHERE guild = v_target AND event_name = TRIM(p_event_name) AND session_id = TRIM(p_session_id)
        RETURNING 1
    )
    SELECT EXISTS (SELECT 1 FROM del) INTO v_deleted;

    RETURN jsonb_build_object('ok', true, 'deleted', v_deleted);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_delete_war_session(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_delete_war_session(text, text, text) TO authenticated;

-- ============================================================================
-- 7. RPC — DAILY SCORES (granular grid) + participant aggregate maintenance
-- ============================================================================

-- 7.1 gm_upsert_daily_scores: batch upsert of Day 1..6 scores, auto-computing
--     chest counts from the session's frozen grid, and maintaining
--     event_participants.score_prep (sum D1..5) / score_pvp (D6) / score NULL.
CREATE OR REPLACE FUNCTION public.gm_upsert_daily_scores(
    p_guild text,
    p_event_name text,
    p_session_id text,
    p_rows jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target       text := TRIM(p_guild);
    v_event        text := TRIM(p_event_name);
    v_sid          text := TRIM(p_session_id);
    v_snapshot     jsonb;
    v_day_tiers    jsonb;
    v_pseudos      text[] := ARRAY[]::text[];
    v_pseudo       text;
    v_day          int;
    v_score        bigint;
    v_chests       int;
    v_el           jsonb;
    v_updated      int := 0;
    v_week         date;
BEGIN
    IF v_event NOT IN ('SvS', 'GvG') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_event');
    END IF;

    IF NOT public.check_user_guild_write_access(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF NOT public.is_subscription_active(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'subscription_expired');
    END IF;

    IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'empty_rows');
    END IF;

    IF jsonb_array_length(p_rows) > 200 THEN
        RETURN jsonb_build_object('ok', false, 'error', 'too_many_rows');
    END IF;

    SELECT chest_tiers_snapshot INTO v_snapshot
    FROM public.war_sessions
    WHERE guild = v_target AND event_name = v_event AND session_id = v_sid;

    IF v_snapshot IS NULL THEN
        RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
    END IF;

    SELECT COALESCE(
        (SELECT (date_trunc('week', ws.start_at AT TIME ZONE 'UTC'))::date
         FROM public.war_sessions ws
         WHERE ws.guild = v_target AND ws.event_name = v_event AND ws.session_id = v_sid),
        (date_trunc('week', now() AT TIME ZONE 'UTC'))::date
    ) INTO v_week;

    FOR i IN 0 .. jsonb_array_length(p_rows) - 1 LOOP
        v_el := p_rows->i;

        IF jsonb_typeof(v_el) <> 'object' THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_row_shape');
        END IF;

        v_pseudo := TRIM(COALESCE(v_el->>'pseudo', ''));
        IF v_pseudo = '' OR v_el->'day' IS NULL OR v_el->'score' IS NULL
           OR jsonb_typeof(v_el->'day') <> 'number' OR jsonb_typeof(v_el->'score') <> 'number'
           OR (v_el->>'day') !~ '^[0-9]+$'
           OR (v_el->>'score') !~ '^[0-9]+$'
           OR (v_el->'chests' IS NOT NULL AND jsonb_typeof(v_el->'chests') = 'number'
               AND (v_el->>'chests') !~ '^[0-9]+$') THEN
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;

        v_day   := (v_el->>'day')::int;
        v_score := (v_el->>'score')::bigint;

        IF v_day BETWEEN 1 AND 6 AND v_score >= 0 AND v_score <= 500000000 THEN
            NULL;
        ELSE
            RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
        END IF;

        v_day_tiers := '[]'::jsonb;
        SELECT COALESCE(jsonb_agg(t ORDER BY (t->>'tier')::int), '[]'::jsonb) INTO v_day_tiers
        FROM jsonb_array_elements(v_snapshot) t
        WHERE (t->>'day')::int = v_day;

        IF v_el->'chests' IS NOT NULL AND jsonb_typeof(v_el->'chests') = 'number' THEN
            v_chests := (v_el->>'chests')::int;
            IF v_chests < 0 THEN
                RETURN jsonb_build_object('ok', false, 'error', 'invalid_input');
            END IF;
        ELSE
            v_chests := public.gm_chests_for_score(v_day_tiers, v_score);
        END IF;

        INSERT INTO public.event_daily_scores (guild, event_name, session_id, pseudo, day, score, chests_unlocked, updated_at)
        VALUES (v_target, v_event, v_sid, v_pseudo, v_day, v_score, v_chests, now())
        ON CONFLICT (guild, event_name, session_id, pseudo, day) DO UPDATE SET
            score           = EXCLUDED.score,
            chests_unlocked = EXCLUDED.chests_unlocked,
            updated_at      = now();

        v_updated := v_updated + 1;
        IF NOT v_pseudos @> ARRAY[v_pseudo] THEN
            v_pseudos := v_pseudos || ARRAY[v_pseudo];
        END IF;
    END LOOP;

    -- Ensure a participant row exists for every touched pseudo (week-derived
    -- from the session), then maintain the legacy aggregate cache columns.
    INSERT INTO public.event_participants (guild, event_name, session_id, week_start, pseudo, participated)
    SELECT v_target, v_event, v_sid, v_week, ps, 0
    FROM unnest(v_pseudos) ps
    WHERE EXISTS (
        SELECT 1 FROM public.guild_members gm
        WHERE gm.guild = v_target AND LOWER(gm.pseudo) = LOWER(ps)
    )
    ON CONFLICT (guild, event_name, session_id, pseudo) DO NOTHING;

    UPDATE public.event_participants ep
    SET score_prep   = COALESCE(d.prep, 0),
        score_pvp    = COALESCE(d.pvp, 0),
        score        = NULL,
        participated = CASE WHEN COALESCE(d.prep, 0) + COALESCE(d.pvp, 0) > 0
                            THEN 1 ELSE ep.participated END
    FROM (
        SELECT pseudo,
               SUM(CASE WHEN day <= 5 THEN score ELSE 0 END)::integer AS prep,
               SUM(CASE WHEN day = 6 THEN score ELSE 0 END)::integer AS pvp
        FROM public.event_daily_scores
        WHERE guild = v_target AND event_name = v_event AND session_id = v_sid
          AND pseudo = ANY(v_pseudos)
        GROUP BY pseudo
    ) d
    WHERE ep.guild = v_target
      AND ep.event_name = v_event
      AND ep.session_id = v_sid
      AND ep.pseudo = d.pseudo;

    RETURN jsonb_build_object('ok', true, 'updated', v_updated, 'pseudos', jsonb_build_array(v_pseudos), 'week_start', v_week);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_upsert_daily_scores(text, text, text, jsonb) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_upsert_daily_scores(text, text, text, jsonb) TO authenticated;

-- 7.2 gm_get_daily_scores: full player x day matrix for a session.
CREATE OR REPLACE FUNCTION public.gm_get_daily_scores(p_guild text, p_event_name text, p_session_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target text := TRIM(p_guild);
    v_rows   jsonb;
BEGIN
    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    SELECT COALESCE(jsonb_agg(
        jsonb_build_object('pseudo', d.pseudo, 'day', d.day,
                           'score', d.score, 'chests_unlocked', d.chests_unlocked)
        ORDER BY d.pseudo, d.day
    ), '[]'::jsonb) INTO v_rows
    FROM public.event_daily_scores d
    WHERE d.guild = v_target
      AND d.event_name = TRIM(p_event_name)
      AND d.session_id = TRIM(p_session_id);

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_get_daily_scores(text, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_get_daily_scores(text, text, text) TO authenticated;

-- ============================================================================
-- 8. RPC — OPPONENT CANDIDATES (pick list)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.gm_list_opponent_candidates(p_guild text, p_kind text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_target text := TRIM(p_guild);
    v_kind   text := LOWER(TRIM(p_kind));
    v_items  jsonb;
BEGIN
    IF v_kind NOT IN ('server', 'guild') THEN
        RETURN jsonb_build_object('ok', false, 'error', 'invalid_kind');
    END IF;

    IF NOT public.gm_can_read_guild_data(v_target) THEN
        RETURN jsonb_build_object('ok', false, 'error', 'forbidden');
    END IF;

    IF v_kind = 'server' THEN
        WITH cat AS (
            SELECT o.id::text AS id, o.kind AS kind, o.name AS name,
                   o.server_number AS server_number, o.guild_ref AS guild_ref, true AS is_existing
            FROM public.war_opponents o
            WHERE o.guild = v_target AND o.kind = 'server'
        ),
        sug AS (
            SELECT NULL::text AS id, v_kind AS kind, s.server_number AS name,
                   s.server_number AS server_number, NULL::text AS guild_ref, false AS is_existing
            FROM (SELECT DISTINCT g.server_number
                  FROM public.guilds g
                  WHERE g.server_number IS NOT NULL AND g.server_number <> '' AND g.id <> 'DEMO') s
            WHERE NOT EXISTS (SELECT 1 FROM cat c WHERE LOWER(c.name) = LOWER(s.server_number))
        ),
        merged AS (
            SELECT * FROM cat
            UNION ALL
            SELECT * FROM sug
        )
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name,
                               'server_number', m.server_number, 'guild_ref', m.guild_ref,
                               'is_existing', m.is_existing)
            ORDER BY LOWER(m.name)
        ), '[]'::jsonb) INTO v_items
        FROM merged m;
    ELSE
        WITH cat AS (
            SELECT o.id::text AS id, o.kind AS kind, o.name AS name,
                   o.server_number AS server_number, o.guild_ref AS guild_ref, true AS is_existing
            FROM public.war_opponents o
            WHERE o.guild = v_target AND o.kind = 'guild'
        ),
        sug AS (
            SELECT NULL::text AS id, v_kind AS kind, COALESCE(g.name, g.id) AS name,
                   g.server_number AS server_number, g.id AS guild_ref, false AS is_existing
            FROM public.guilds g
            WHERE g.id <> v_target AND g.id <> 'DEMO'
              AND NOT EXISTS (
                  SELECT 1 FROM cat c
                  WHERE LOWER(c.name) = LOWER(COALESCE(g.name, g.id))
                     OR c.guild_ref = g.id
              )
        ),
        merged AS (
            SELECT * FROM cat
            UNION ALL
            SELECT * FROM sug
        )
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object('id', m.id, 'kind', m.kind, 'name', m.name,
                               'server_number', m.server_number, 'guild_ref', m.guild_ref,
                               'is_existing', m.is_existing)
            ORDER BY LOWER(m.name)
        ), '[]'::jsonb) INTO v_items
        FROM merged m;
    END IF;

    RETURN jsonb_build_object('ok', true, 'guild', v_target, 'kind', v_kind, 'items', v_items);
END;
$$;

REVOKE ALL ON FUNCTION public.gm_list_opponent_candidates(text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_opponent_candidates(text, text) TO authenticated;

-- ============================================================================
-- 9. EXTEND gm_list_event_sessions WITH `granular`
--    Retro-compatible: same columns as before + granular boolean (a
--    war_sessions row exists for that guild/event/session), letting the
--    History UI switch between the legacy score_prep/score_pvp columns and
--    the per-day grid columns.
-- ============================================================================
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
    total_score bigint,
    granular boolean
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
    SELECT base.event_name,
           base.display_name,
           base.session_id,
           base.week_start,
           base.start_at,
           base.participants,
           base.participated_count,
           base.total_score,
           EXISTS (
               SELECT 1 FROM public.war_sessions ws
               WHERE ws.guild = v_target_guild
                 AND ws.event_name = base.event_name
                 AND ws.session_id = base.session_id
           ) AS granular
    FROM (
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
    ) base
    ORDER BY COALESCE(
      base.start_at,
      CASE
        WHEN base.session_id ~ '-[0-9]{8}(-[0-9]+)?$'
        THEN to_timestamp(
               substring(base.session_id FROM '-([0-9]{8})'),
               'YYYYMMDD'
             ) AT TIME ZONE 'UTC'
        ELSE NULL
      END,
      (base.week_start || 'T12:00:00')::timestamptz
    ) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_list_event_sessions(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_list_event_sessions(text) TO authenticated;

NOTIFY pgrst, 'reload schema';