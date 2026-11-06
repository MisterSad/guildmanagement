-- The OCR video bucket's ceiling drops from 64 MiB to 20 MiB (ADR-024).
--
-- The recording is no longer uploaded to the Gemini File API: OpenRouter's
-- Google endpoints take a video only inline, as base64 in the request, which is
-- a third larger than the file. 20 MiB keeps that request within reach of the
-- Edge Function and of the provider.
--
-- Measured on production before the change (function logs, 2026-11-05/06):
-- the recordings actually scanned weighed 13.9 to 17.3 MB for 50 to 148 s, so
-- the new ceiling refuses none of them. The bucket holds no object between
-- scans (each is deleted after its reading), so nothing stored is affected.
-- Mirrored in ocr-guild-members/video.ts and src/modules/app/ocr/ocr.controller.ts.

UPDATE storage.buckets
   SET file_size_limit = 20971520 -- 20 MiB
 WHERE id = 'ocr-videos';

DO $check$
BEGIN
    IF (SELECT file_size_limit FROM storage.buckets WHERE id = 'ocr-videos') IS DISTINCT FROM 20971520 THEN
        RAISE EXCEPTION 'ocr-videos is not capped at 20 MiB';
    END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';
