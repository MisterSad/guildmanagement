-- 20260920130000_ocr_cache_table.sql
-- TICKET-10 [PERF-03]: Cache de déduplication SHA-256 pour l'OCR Gemini Vision
-- Stores extracted OCR structured data by deterministic SHA-256 hash of image and metadata.

CREATE TABLE IF NOT EXISTS public.ocr_cache (
    hash text PRIMARY KEY,
    guild_id text REFERENCES public.guilds(id) ON DELETE CASCADE,
    metric_type text NOT NULL,
    players jsonb NOT NULL,
    ending_rank text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days')
);

-- Zero-Trust: Force RLS to prevent bypass
ALTER TABLE public.ocr_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ocr_cache FORCE ROW LEVEL SECURITY;

-- Indexes for performance and expiration cleanup
CREATE INDEX IF NOT EXISTS idx_ocr_cache_hash_expires ON public.ocr_cache(hash, expires_at);
CREATE INDEX IF NOT EXISTS idx_ocr_cache_expires_at ON public.ocr_cache(expires_at);

-- RLS Policy: Authenticated admins can view cached OCR results for their guild (or multi-guild)
CREATE POLICY ocr_cache_admin_select ON public.ocr_cache
    FOR SELECT
    TO authenticated
    USING (
        guild_id IS NULL
        OR guild_id = (SELECT a.guild FROM public.accounts a WHERE a.auth_user_id = auth.uid())
        OR EXISTS (
            SELECT 1 FROM public.accounts a
            WHERE a.auth_user_id = auth.uid() AND a.role = 'super_admin'
        )
    );

-- Periodic cleanup function for expired cache rows
CREATE OR REPLACE FUNCTION public.gm_cleanup_expired_ocr_cache()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    DELETE FROM public.ocr_cache WHERE expires_at < now();
END;
$$;

-- Refresh PostgREST schema cache
NOTIFY pgrst, 'reload schema';

