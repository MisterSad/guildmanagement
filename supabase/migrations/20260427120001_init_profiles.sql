-- ===========================================================================
-- 20260427120001_init_profiles.sql
-- Crée la table `profiles` liée à `auth.users` + helpers RLS.
-- ===========================================================================

-- ─── Table profiles ────────────────────────────────────────────────────────
-- Une ligne par utilisateur authentifié. Stocke pseudo in-game, UID,
-- rôle (R5/R4/member) et préférence de langue.
create table if not exists public.profiles (
  id          uuid        primary key references auth.users(id) on delete cascade,
  pseudo      text        unique not null,
  uid         text        unique,
  role        text        not null default 'member' check (role in ('R5','R4','member')),
  locale      text        not null default 'en'    check (locale in ('en','fr')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table  public.profiles        is 'User profiles linked to auth.users — pseudo, role (R5/R4/member), locale.';
comment on column public.profiles.role   is 'R5 = guild leader (admin), R4 = officer, member = regular member.';
comment on column public.profiles.locale is 'UI language preference: en (default) or fr.';

-- ─── Index ──────────────────────────────────────────────────────────────────
create index if not exists profiles_role_idx on public.profiles (role);

-- ─── Trigger updated_at ─────────────────────────────────────────────────────
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.tg_set_updated_at();

-- ─── Helpers RLS ────────────────────────────────────────────────────────────
-- `current_user_role()` retourne le rôle de l'utilisateur authentifié courant.
-- Utilisé dans les policies pour éviter les jointures répétées.
-- SECURITY DEFINER + search_path verrouillé = pas d'injection via search_path.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.profiles where id = auth.uid()
$$;

revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated;

-- ─── RLS sur profiles ───────────────────────────────────────────────────────
alter table public.profiles enable row level security;

-- Tous les utilisateurs authentifiés peuvent lire les profils (besoin pour
-- afficher la liste des membres).
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles
  for select
  to authenticated
  using (true);

-- Un utilisateur peut modifier son propre profil (pseudo, UID, locale).
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));
-- Note : la check empêche un user de promouvoir son propre rôle.

-- Les R5 peuvent modifier n'importe quel profil (y compris les rôles).
drop policy if exists "profiles_update_r5" on public.profiles;
create policy "profiles_update_r5"
  on public.profiles
  for update
  to authenticated
  using (public.current_user_role() = 'R5');

-- Les R5 peuvent insérer manuellement (cas seed initial / inscription
-- exceptionnelle). L'inscription standard passera par un trigger sur auth.users.
drop policy if exists "profiles_insert_r5" on public.profiles;
create policy "profiles_insert_r5"
  on public.profiles
  for insert
  to authenticated
  with check (public.current_user_role() = 'R5');

-- Les R5 peuvent supprimer un profil (= retirer un membre de la guilde).
drop policy if exists "profiles_delete_r5" on public.profiles;
create policy "profiles_delete_r5"
  on public.profiles
  for delete
  to authenticated
  using (public.current_user_role() = 'R5');

-- ─── Trigger d'auto-création du profil à l'inscription ─────────────────────
-- Quand un user est créé dans auth.users, on crée automatiquement une ligne
-- dans profiles avec rôle 'member' par défaut. Le pseudo doit être fourni dans
-- raw_user_meta_data au moment de l'invitation/inscription.
create or replace function public.tg_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pseudo text;
  v_uid    text;
  v_role   text;
  v_locale text;
begin
  v_pseudo := coalesce(new.raw_user_meta_data->>'pseudo', new.email);
  v_uid    := new.raw_user_meta_data->>'uid';
  v_role   := coalesce(new.raw_user_meta_data->>'role', 'member');
  v_locale := coalesce(new.raw_user_meta_data->>'locale', 'en');

  -- Garde-fou : seuls les rôles valides sont acceptés.
  if v_role not in ('R5','R4','member') then
    v_role := 'member';
  end if;
  if v_locale not in ('en','fr') then
    v_locale := 'en';
  end if;

  insert into public.profiles (id, pseudo, uid, role, locale)
  values (new.id, v_pseudo, v_uid, v_role, v_locale)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_handle_new_user on auth.users;
create trigger trg_handle_new_user
  after insert on auth.users
  for each row execute function public.tg_handle_new_user();
