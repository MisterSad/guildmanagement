-- Migration: restore SELECT grant on accounts for authenticated users.
-- The accounts table had RLS policies (self-select, super-admin update) but
-- lost its SELECT grant, so EVERY authenticated user (including guild admins)
-- hit "permission denied for table accounts". This broke the login flow:
-- supabase.from('accounts').select('guild') failed, the guild restriction
-- stayed null, and canWriteGuild() then treated the admin as unrestricted
-- (writing only allowed on ALPHA) -> "Read-only access" everywhere outside
-- ALPHA, plus the ".eq is not a function" error from the read-only stub.
-- RLS still restricts reads to the caller's own account (or super admin).

grant select on table public.accounts to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
