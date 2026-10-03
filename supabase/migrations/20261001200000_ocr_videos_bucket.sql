-- ============================================================================
-- OCR video uploads: a private, per-guild staging bucket (ADR-021).
--
-- A video scan no longer goes through the browser's frame extractor: the file
-- itself is handed to Gemini. It cannot travel in the Edge Function's request
-- body -- measured against production on 2026-10-01, a 1 MB binary body hung
-- the function for 160 s and 60 MB bodies ended in a gateway 502 -- so the
-- browser stages it here, and `ocr-guild-members` reads it, forwards it to the
-- Gemini File API, and deletes it.
--
-- Authorization is RLS, under the caller's own JWT: the function signs the
-- download URL and deletes the object with a user-scoped client, so it can only
-- reach a video the caller could have uploaded. The first path segment is the
-- guild, and `check_user_guild_write_access` decides it exactly as it does for
-- every other guild-scoped write (guild_admin of that guild, server_admin of
-- its server, super_admin). Members cannot upload.
--
-- No UPDATE policy: a staged video is written once and never replaced.
-- ============================================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'ocr-videos',
    'ocr-videos',
    false,
    67108864, -- 64 MiB, the same ceiling the Edge Function enforces
    ARRAY['video/mp4', 'video/quicktime', 'video/webm']
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS ocr_videos_insert ON storage.objects;
CREATE POLICY ocr_videos_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (
        bucket_id = 'ocr-videos'
        AND public.check_user_guild_write_access((storage.foldername(name))[1])
    );

DROP POLICY IF EXISTS ocr_videos_select ON storage.objects;
CREATE POLICY ocr_videos_select ON storage.objects
    FOR SELECT TO authenticated
    USING (
        bucket_id = 'ocr-videos'
        AND public.check_user_guild_write_access((storage.foldername(name))[1])
    );

DROP POLICY IF EXISTS ocr_videos_delete ON storage.objects;
CREATE POLICY ocr_videos_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (
        bucket_id = 'ocr-videos'
        AND public.check_user_guild_write_access((storage.foldername(name))[1])
    );

-- Reload the PostgREST schema cache.
NOTIFY pgrst, 'reload schema';
