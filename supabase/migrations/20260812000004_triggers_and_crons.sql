-- ============================================================================
-- FGF GUILD MANAGEMENT — CANONICAL TRIGGERS & AUTOMATION (Migration 4 of 4)
-- Migration: 20260812000004_triggers_and_crons.sql
-- Description: Automated timestamp triggers, UID integrity, and reminders.
-- ============================================================================

-- 1. UPDATED_AT TRIGGER FUNCTION
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

-- 2. ATTACH UPDATED_AT TRIGGERS
DROP TRIGGER IF EXISTS trg_guild_config_updated_at ON public.guild_config;
CREATE TRIGGER trg_guild_config_updated_at
    BEFORE UPDATE ON public.guild_config
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_player_absences_updated_at ON public.player_absences;
CREATE TRIGGER trg_player_absences_updated_at
    BEFORE UPDATE ON public.player_absences
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_player_push_prefs_updated_at ON public.player_push_prefs;
CREATE TRIGGER trg_player_push_prefs_updated_at
    BEFORE UPDATE ON public.player_push_prefs
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_gm_payments_updated_at ON public.gm_payments;
CREATE TRIGGER trg_gm_payments_updated_at
    BEFORE UPDATE ON public.gm_payments
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

DROP TRIGGER IF EXISTS trg_event_status_updated_at ON public.event_status;
CREATE TRIGGER trg_event_status_updated_at
    BEFORE UPDATE ON public.event_status
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_updated_at();

-- 3. PREVENT DUPLICATE MEMBER UID TRIGGER
CREATE OR REPLACE FUNCTION public.prevent_duplicate_member_uid()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
    v_banned_id bigint;
BEGIN
    IF NEW.uid IS NOT NULL AND TRIM(NEW.uid) <> '' THEN
        NEW.uid := TRIM(NEW.uid);

        -- Check if banned
        SELECT bp.id INTO v_banned_id
        FROM public.banned_players bp
        WHERE bp.guild = NEW.guild AND bp.uid = NEW.uid
        LIMIT 1;

        IF v_banned_id IS NOT NULL THEN
            RAISE EXCEPTION 'Player UID % is banned in guild %', NEW.uid, NEW.guild;
        END IF;

        -- Check duplicate in same guild
        IF TG_OP = 'INSERT' THEN
            IF EXISTS (
                SELECT 1 FROM public.guild_members gm
                WHERE gm.guild = NEW.guild AND gm.uid = NEW.uid
            ) THEN
                RAISE EXCEPTION 'Player UID % already exists in guild %', NEW.uid, NEW.guild;
            END IF;
        ELSIF TG_OP = 'UPDATE' THEN
            IF NEW.uid <> OLD.uid AND EXISTS (
                SELECT 1 FROM public.guild_members gm
                WHERE gm.guild = NEW.guild AND gm.uid = NEW.uid AND gm.id <> OLD.id
            ) THEN
                RAISE EXCEPTION 'Player UID % already exists in guild %', NEW.uid, NEW.guild;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_duplicate_member_uid ON public.guild_members;
CREATE TRIGGER trg_prevent_duplicate_member_uid
    BEFORE INSERT OR UPDATE ON public.guild_members
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_duplicate_member_uid();
