-- ============================================================================
-- Migration: 20260920010000_migration_wiki_comments.sql
-- Description: Collaborative comments thread and Zero-Trust RLS for Migration Hub notes
-- ============================================================================

-- 1. Create migration_wiki_comments table
CREATE TABLE IF NOT EXISTS public.migration_wiki_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID NOT NULL REFERENCES public.migration_wiki_pages(id) ON DELETE CASCADE,
    content TEXT NOT NULL CHECK (char_length(trim(content)) > 0 AND char_length(content) <= 2000),
    author_account_id TEXT REFERENCES public.accounts(id),
    author_pseudo TEXT NOT NULL,
    author_guild_id TEXT REFERENCES public.guilds(id),
    author_role TEXT NOT NULL DEFAULT 'guild_admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_migration_wiki_comments_page ON public.migration_wiki_comments (page_id, created_at ASC);

-- 2. Helper function to check if current user can access parent wiki page
CREATE OR REPLACE FUNCTION public.gm_can_access_wiki_page(p_page_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.migration_wiki_pages p
    WHERE p.id = p_page_id
      AND (
        (p.scope = 'guild' AND public.check_user_guild_access(p.guild_id))
        OR
        (p.scope = 'server' AND public.gm_can_access_server_wiki(p.server_number))
      )
  );
$$;

REVOKE ALL ON FUNCTION public.gm_can_access_wiki_page(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.gm_can_access_wiki_page(uuid) TO authenticated, service_role;

-- 3. Row Level Security Policies
ALTER TABLE public.migration_wiki_comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gm_migration_wiki_comments_select ON public.migration_wiki_comments;
CREATE POLICY gm_migration_wiki_comments_select ON public.migration_wiki_comments
    FOR SELECT TO authenticated
    USING (public.gm_can_access_wiki_page(page_id));

DROP POLICY IF EXISTS gm_migration_wiki_comments_insert ON public.migration_wiki_comments;
CREATE POLICY gm_migration_wiki_comments_insert ON public.migration_wiki_comments
    FOR INSERT TO authenticated
    WITH CHECK (public.gm_can_access_wiki_page(page_id));

DROP POLICY IF EXISTS gm_migration_wiki_comments_delete ON public.migration_wiki_comments;
CREATE POLICY gm_migration_wiki_comments_delete ON public.migration_wiki_comments
    FOR DELETE TO authenticated
    USING (
        public.is_super_admin()
        OR (
            author_account_id = (
                SELECT a.id FROM public.accounts a WHERE a.auth_user_id = auth.uid() AND a.status = 'active' LIMIT 1
            )
            AND public.gm_can_access_wiki_page(page_id)
        )
    );

ALTER TABLE public.migration_wiki_comments FORCE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
