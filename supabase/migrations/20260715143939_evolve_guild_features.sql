-- 1. Add sub_present column to event_participants
ALTER TABLE public.event_participants 
  ADD COLUMN IF NOT EXISTS sub_present boolean DEFAULT false;

-- 2. Add power and fleet columns to guild_members
ALTER TABLE public.guild_members 
  ADD COLUMN IF NOT EXISTS overall_power bigint DEFAULT 0,
  ADD COLUMN IF NOT EXISTS strongest_fleet bigint DEFAULT 0;

-- 3. Create shadowfront_signups table for manual prep-phase registrations
CREATE TABLE IF NOT EXISTS public.shadowfront_signups (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    guild text NOT NULL DEFAULT 'ALPHA',
    week_start text NOT NULL,
    pseudo text NOT NULL,
    availability text NOT NULL CHECK (availability IN ('squad1', 'squad2', 'both', 'none')),
    updated_at timestamptz DEFAULT now(),
    CONSTRAINT shadowfront_signups_pseudo_fkey FOREIGN KEY (guild, pseudo) REFERENCES public.guild_members(guild, pseudo) ON DELETE CASCADE ON UPDATE CASCADE,
    UNIQUE(guild, week_start, pseudo)
);

-- 4. Create player_name_history table to trace player name updates
CREATE TABLE IF NOT EXISTS public.player_name_history (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    guild text NOT NULL DEFAULT 'ALPHA',
    uid text NOT NULL,
    old_pseudo text NOT NULL,
    new_pseudo text NOT NULL,
    changed_by text NOT NULL,
    changed_at timestamptz DEFAULT now()
);

-- 5. Enable Row Level Security (RLS)
ALTER TABLE public.shadowfront_signups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_name_history ENABLE ROW LEVEL SECURITY;

-- 6. Setup RLS Policies (checks active subscription)
-- For public.shadowfront_signups
DROP POLICY IF EXISTS gm_authenticated_select ON public.shadowfront_signups;
DROP POLICY IF EXISTS gm_authenticated_insert ON public.shadowfront_signups;
DROP POLICY IF EXISTS gm_authenticated_update ON public.shadowfront_signups;
DROP POLICY IF EXISTS gm_authenticated_delete ON public.shadowfront_signups;

CREATE POLICY gm_authenticated_select ON public.shadowfront_signups FOR SELECT TO authenticated USING (true);
CREATE POLICY gm_authenticated_insert ON public.shadowfront_signups FOR INSERT TO authenticated WITH CHECK (public.is_subscription_active(guild));
CREATE POLICY gm_authenticated_update ON public.shadowfront_signups FOR UPDATE TO authenticated USING (public.is_subscription_active(guild)) WITH CHECK (public.is_subscription_active(guild));
CREATE POLICY gm_authenticated_delete ON public.shadowfront_signups FOR DELETE TO authenticated USING (public.is_subscription_active(guild));

-- For public.player_name_history
DROP POLICY IF EXISTS gm_authenticated_select ON public.player_name_history;
DROP POLICY IF EXISTS gm_authenticated_insert ON public.player_name_history;
DROP POLICY IF EXISTS gm_authenticated_update ON public.player_name_history;
DROP POLICY IF EXISTS gm_authenticated_delete ON public.player_name_history;

CREATE POLICY gm_authenticated_select ON public.player_name_history FOR SELECT TO authenticated USING (true);
CREATE POLICY gm_authenticated_insert ON public.player_name_history FOR INSERT TO authenticated WITH CHECK (public.is_subscription_active(guild));
CREATE POLICY gm_authenticated_update ON public.player_name_history FOR UPDATE TO authenticated USING (public.is_subscription_active(guild)) WITH CHECK (public.is_subscription_active(guild));
CREATE POLICY gm_authenticated_delete ON public.player_name_history FOR DELETE TO authenticated USING (public.is_subscription_active(guild));

-- 7. Performance Indexes
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_week_start ON public.shadowfront_signups(week_start);
CREATE INDEX IF NOT EXISTS idx_shadowfront_signups_pseudo ON public.shadowfront_signups(pseudo);
CREATE INDEX IF NOT EXISTS idx_player_name_history_uid ON public.player_name_history(uid);
