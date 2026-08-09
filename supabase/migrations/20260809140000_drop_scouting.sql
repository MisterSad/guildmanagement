-- 20260809140000_drop_scouting.sql
-- Remove the Scouting feature entirely: table, policies, functions, grants.
-- Scouting was a super_admin-only rival-roster tracker. The feature is no
-- longer used, so we drop every artifact it created (20260809100000).

-- Drop the RPCs (must precede the table drop).
drop function if exists public.gm_scouting_capture(text, jsonb);
drop function if exists public.gm_scouting_report(text);
drop function if exists public.gm_scouting_history(text, text);

-- Drop the policy before the table.
drop policy if exists scouting_snapshots_superadmin on public.scouting_snapshots;

-- Drop the table (indexes and identity sequence go with it).
drop table if exists public.scouting_snapshots;

-- Remove any leftover grants (safe no-ops if already gone).
revoke all on table public.scouting_snapshots from anon, authenticated;
revoke usage on sequence scouting_snapshots_id_seq from authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
