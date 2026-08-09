-- 20260809110000_challenges.sql
-- Weekly challenges + season progression for the Player Portal.
--
-- Adds guild_members.power_updated_at so the "refresh your power this week"
-- challenge can be tracked (set by member-portal update-power). Glory
-- submission is already derivable from event_participants (week_start), and
-- event participation from the scoring key.

alter table public.guild_members
  add column if not exists power_updated_at timestamptz;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
