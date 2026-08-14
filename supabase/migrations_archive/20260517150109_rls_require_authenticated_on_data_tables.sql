-- Lock the 6 guild-data tables behind a real authenticated session.
-- anon (the publishable key without a session) loses all access.
do $$
declare
  tbl text;
  tables text[] := array[
    'guild_members','event_participants','event_status',
    'shadowfront_squads','weekly_scores','sanctions'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table public.%I enable row level security;', tbl);
    execute format('drop policy if exists gm_authenticated_all on public.%I;', tbl);
    execute format(
      'create policy gm_authenticated_all on public.%I
         for all to authenticated using (true) with check (true);', tbl);
    execute format('revoke all on table public.%I from anon;', tbl);
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated;', tbl);
  end loop;
end $$;

-- Sequences used by bigserial PKs must be usable by authenticated, not anon
revoke all on all sequences in schema public from anon;
grant usage, select on all sequences in schema public to authenticated;

-- The 3 app RPCs were anon-executable SECURITY DEFINER (flagged by advisor).
-- Restrict them to authenticated only, closing the anon bypass.
revoke all on function public.list_event_sessions() from anon, public;
revoke all on function public.list_event_weeks() from anon, public;
revoke all on function public.populate_event_participants(text, text, date) from anon, public;

grant execute on function public.list_event_sessions() to authenticated;
grant execute on function public.list_event_weeks() to authenticated;
grant execute on function public.populate_event_participants(text, text, date) to authenticated;;
