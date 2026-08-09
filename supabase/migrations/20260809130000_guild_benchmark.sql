-- 20260809130000_guild_benchmark.sql
-- Super-admin benchmark: one row per guild with health + engagement numbers
-- side by side, so a consolidated view of every tenant is easy to read.
--
--   members, total_power, max_power, avg_power
--   active_events, participation_rate (8 weeks), inactive_members (2 weeks)
--   subscription_type, subscriptions (push_subscriptions count)
--
-- super_admin only (gm_cross_guild_ranking style).

create or replace function public.gm_guild_benchmark()
 returns table(
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
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
begin
  if not public.is_super_admin() then
    return;
  end if;

  return query
  with guilds as (
    select g.id as guild, g.server_number, g.subscription_type
    from public.guilds g
  ),
  members as (
    select m.guild,
           count(*)::int as members,
           coalesce(sum(m.overall_power), 0)::bigint as total_power,
           coalesce(max(m.overall_power), 0)::bigint as max_power,
           coalesce(round(avg(m.overall_power)), 0)::bigint as avg_power
    from public.guild_members m
    group by m.guild
  ),
  active_events as (
    select es.guild, count(*)::int as active_events
    from public.event_status es
    where es.is_active = true
    group by es.guild
  ),
  -- Participation over the last 8 distinct weeks (distinct members attending).
  participation as (
    select
      wk.guild,
      round(avg(wk.rate) * 100)::numeric as participation_rate
    from (
      select
        ep0.guild,
        ep0.week_start,
        count(distinct ep0.pseudo)::numeric /
          nullif((select count(*) from public.guild_members gm where gm.guild = ep0.guild), 0) as rate,
        row_number() over (
          partition by ep0.guild
          order by ep0.week_start desc
        ) as rn
      from public.event_participants ep0
      where ep0.event_name <> 'Glory'
        and ep0.is_pending = false
        and (ep0.participated > 0 or ep0.sub_present = true)
      group by ep0.guild, ep0.week_start
    ) wk
    where wk.rn <= 8
    group by wk.guild
  ),
  inactive as (
    select
      gm.guild,
      count(*)::int as inactive_members
    from public.guild_members gm
    where not exists (
      select 1 from public.event_participants ep
      where ep.guild = gm.guild
        and ep.pseudo = gm.pseudo
        and ep.event_name <> 'Glory'
        and (ep.participated > 0 or ep.sub_present = true)
        and ep.week_start >= (
          select (max(w.week_start) - interval '7 days')::date
          from public.event_participants w
          where w.guild = gm.guild and w.event_name <> 'Glory'
        )
    )
    group by gm.guild
  ),
  push as (
    select p.guild, count(*)::int as push_subs
    from public.push_subscriptions p
    group by p.guild
  )
  select
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
  from guilds g
  left join members m on m.guild = g.guild
  left join active_events ae on ae.guild = g.guild
  left join participation p on p.guild = g.guild
  left join inactive i on i.guild = g.guild
  left join push pu on pu.guild = g.guild
  order by coalesce(m.total_power, 0) desc;
end
$fn$;

revoke all on function public.gm_guild_benchmark() from public, anon;
grant execute on function public.gm_guild_benchmark() to authenticated;

-- Force PostgREST schema cache reload
notify pgrst, 'reload schema';
