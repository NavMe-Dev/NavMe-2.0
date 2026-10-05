-- Optional HEVC/MOV URL for transparent video on iOS (WebM stays in media_url for Android).
ALTER TABLE public.navme_media
  ADD COLUMN IF NOT EXISTS media_url_ios text;

COMMENT ON COLUMN public.navme_media.media_url_ios IS
  'Optional HEVC .mov URL for iPhone/iPad AR. media_url remains the Android/default source (usually WebM).';
