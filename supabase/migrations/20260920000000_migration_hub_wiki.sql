-- ============================================================================
-- Migration: 20260920000000_migration_hub_wiki.sql
-- Description: Schema and Zero-Trust RLS for Migration Hub (Wiki & Compressed Intel)
-- ============================================================================

-- 1. Create migration_wiki_pages table
CREATE TABLE IF NOT EXISTS public.migration_wiki_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scope TEXT NOT NULL CHECK (scope IN ('guild', 'server')),
    server_number TEXT NOT NULL,
    guild_id TEXT REFERENCES public.guilds(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('general', 'recruitment', 'diplomacy', 'blacklist', 'strategy', 'agreements')),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    is_pinned BOOLEAN NOT NULL DEFAULT false,
    attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by_account_id TEXT REFERENCES public.accounts(id),
    created_by_pseudo TEXT NOT NULL,
    updated_by_account_id TEXT REFERENCES public.accounts(id),
    updated_by_pseudo TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT migration_wiki_scope_guild_check CHECK (scope <> 'guild' OR guild_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_migration_wiki_scope_server ON public.migration_wiki_pages (scope, server_number);
CREATE INDEX IF NOT EXISTS idx_migration_wiki_guild ON public.migration_wiki_pages (guild_id);
CREATE INDEX IF NOT EXISTS idx_migration_wiki_category ON public.migration_wiki_pages (category);
CREATE INDEX IF NOT EXISTS idx_migration_wiki_pinned ON public.migration_wiki_pages (is_pinned, updated_at DESC);

-- 2. Access Helper Function for Server Scope
CREATE OR REPLACE FUNCTION public.gm_can_access_server_wiki(p_server_number text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_role text;
  v_guild text;
  v_server text;
BEGIN
  IF p_server_number IS NULL OR p_server_number = '' THEN
    RETURN false;
  END IF;

  SELECT a.role, a.guild, COALESCE(a.server_number, g.server_number)
  INTO v_role, v_guild, v_server
  FROM public.accounts a
  LEFT JOIN public.guilds g ON g.id = a.guild
  WHERE a.auth_user_id = auth.uid() AND a.status = 'active'
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- super_admin has global access
  IF v_role = 'super_admin' THEN
    RETURN true;
  END IF;

  -- server_admin of this server
  IF v_role = 'server_admin' THEN
    RETURN (v_server IS NOT NULL AND v_server = p_server_number);
  END IF;

  -- guild_admin of any guild belonging to this server_number
  IF v_role = 'guild_admin' THEN
    RETURN (v_server IS NOT NULL AND v_server = p_server_number);
  END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION public.gm_can_access_server_wiki(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_can_access_server_wiki(text) TO authenticated, service_role;

-- 3. Row Level Security Policies
ALTER TABLE public.migration_wiki_pages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gm_migration_wiki_select ON public.migration_wiki_pages;
CREATE POLICY gm_migration_wiki_select ON public.migration_wiki_pages
    FOR SELECT TO authenticated
    USING (
        (scope = 'guild' AND public.check_user_guild_access(guild_id))
        OR
        (scope = 'server' AND public.gm_can_access_server_wiki(server_number))
    );

DROP POLICY IF EXISTS gm_migration_wiki_insert ON public.migration_wiki_pages;
CREATE POLICY gm_migration_wiki_insert ON public.migration_wiki_pages
    FOR INSERT TO authenticated
    WITH CHECK (
        (scope = 'guild' AND public.check_user_guild_access(guild_id))
        OR
        (scope = 'server' AND public.gm_can_access_server_wiki(server_number))
    );

DROP POLICY IF EXISTS gm_migration_wiki_update ON public.migration_wiki_pages;
CREATE POLICY gm_migration_wiki_update ON public.migration_wiki_pages
    FOR UPDATE TO authenticated
    USING (
        (scope = 'guild' AND public.check_user_guild_access(guild_id))
        OR
        (scope = 'server' AND public.gm_can_access_server_wiki(server_number))
    )
    WITH CHECK (
        (scope = 'guild' AND public.check_user_guild_access(guild_id))
        OR
        (scope = 'server' AND public.gm_can_access_server_wiki(server_number))
    );

DROP POLICY IF EXISTS gm_migration_wiki_delete ON public.migration_wiki_pages;
CREATE POLICY gm_migration_wiki_delete ON public.migration_wiki_pages
    FOR DELETE TO authenticated
    USING (
        public.is_super_admin()
        OR (
            created_by_account_id = (
                SELECT a.id FROM public.accounts a WHERE a.auth_user_id = auth.uid() AND a.status = 'active' LIMIT 1
            )
            AND (
                (scope = 'guild' AND public.check_user_guild_access(guild_id))
                OR
                (scope = 'server' AND public.gm_can_access_server_wiki(server_number))
            )
        )
    );

ALTER TABLE public.migration_wiki_pages FORCE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

