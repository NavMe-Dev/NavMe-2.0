-- The viewer's place card always shows the real Matterport-extracted scan thumbnails
-- for a POI's main photo (nearbyThumbs/photo_url) — the shop feature should not override
-- that with uploaded stock photos. Clear the placeholder logo/cover/gallery images added
-- during initial dummy-data seeding; per-dish menu item images stay (no Matterport
-- equivalent exists for an individual food photo).
UPDATE public.navme_shop
SET logo_url = NULL, cover_image_url = NULL, gallery_images = '[]'::jsonb;
