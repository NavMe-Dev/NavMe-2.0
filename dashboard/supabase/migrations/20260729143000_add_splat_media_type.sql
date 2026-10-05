-- Allow Splat uploads (`.ply`) in navme_media.
ALTER TABLE public.navme_media
  DROP CONSTRAINT IF EXISTS navme_media_media_type_check;

ALTER TABLE public.navme_media
  ADD CONSTRAINT navme_media_media_type_check
  CHECK (
    media_type = ANY (ARRAY['image'::text, 'video'::text, 'model'::text, 'splat'::text])
  );
