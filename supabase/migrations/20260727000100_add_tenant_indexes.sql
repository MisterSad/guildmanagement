-- Migration: Add indexes on guild column for all tenant tables
-- PERFORMANCE FIX: All RLS policies filter by guild, but no indexes exist on that column.
-- Without these indexes, every authenticated query triggers a full sequential scan.

-- guild_members
CREATE INDEX IF NOT EXISTS idx_guild_members_guild
  ON public.guild_members(guild);

-- event_participants (also index session_id for event queries)
CREATE INDEX IF NOT EXISTS idx_event_participants_guild
  ON public.event_participants(guild);

CREATE INDEX IF NOT EXISTS idx_event_participants_guild_session
  ON public.event_participants(guild, session_id);

CREATE INDEX IF NOT EXISTS idx_event_participants_guild_event
  ON public.event_participants(guild, event_name);

-- event_status
CREATE INDEX IF NOT EXISTS idx_event_status_guild
  ON public.event_status(guild);

CREATE INDEX IF NOT EXISTS idx_event_status_guild_active
  ON public.event_status(guild, is_active)
  WHERE is_active = true;

-- weekly_scores
CREATE INDEX IF NOT EXISTS idx_weekly_scores_guild
  ON public.weekly_scores(guild);

CREATE INDEX IF NOT EXISTS idx_weekly_scores_guild_week
  ON public.weekly_scores(guild, week_start);

-- sanctions
CREATE INDEX IF NOT EXISTS idx_sanctions_guild
  ON public.sanctions(guild);

-- shadowfront_squads
CREATE INDEX IF NOT EXISTS idx_shadowfront_squads_guild
  ON public.shadowfront_squads(guild);

-- push_subscriptions (for event-reminders filtering by guild)
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_guild
  ON public.push_subscriptions(guild);

-- guild_config (for config lookups by guild)
CREATE INDEX IF NOT EXISTS idx_guild_config_guild
  ON public.guild_config(guild);

-- player_name_history (for history lookups by uid)
CREATE INDEX IF NOT EXISTS idx_player_name_history_uid
  ON public.player_name_history(uid);
