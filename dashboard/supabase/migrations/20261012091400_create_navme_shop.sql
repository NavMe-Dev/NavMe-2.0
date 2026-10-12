-- NavMe Shop feature: extends a navme_pois row with shop-specific data (menu, hours,
-- images, rating, open/close) when that POI is turned into a "shop". One shop profile
-- per POI (poi_id UNIQUE) — adding a POI to navme_shop is what "makes it a shop".
--
-- navme_pois has no primary key / unique constraint on id (verified: pg_constraint is
-- empty for it), so poi_id is a plain indexed uuid rather than a DB-enforced FK —
-- consistent with how navme_pois itself references categories/floors without FKs.

CREATE TABLE IF NOT EXISTS public.navme_shop (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_id            uuid        NOT NULL UNIQUE,
  organization_id   uuid        NOT NULL,
  poi_type          text        NOT NULL,
  shop_name         text        NOT NULL,
  shop_category     text,
  tagline           text,
  description       text,
  logo_url          text,
  cover_image_url   text,
  gallery_images    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  rating            numeric(2,1),
  rating_count      integer     NOT NULL DEFAULT 0,
  price_range       text,
  phone             text,
  website_url       text,
  tags              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  hours             jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_open_override  boolean,
  menu              jsonb       NOT NULL DEFAULT '[]'::jsonb,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_navme_shop_poi_type ON public.navme_shop (poi_type);
CREATE INDEX IF NOT EXISTS ix_navme_shop_organization ON public.navme_shop (organization_id);

-- Same open anon/authenticated CRUD access as navme_pois / navme_facilities — the
-- dashboard talks to these tables directly with the Supabase anon key, no server auth.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_shop TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.navme_shop TO authenticated;

-- Supabase auto-enables RLS on newly created tables; navme_pois/navme_facilities both
-- have it off and rely purely on the GRANTs above, so match that or anon/authenticated
-- get zero rows despite the GRANTs (verified live: RLS on + zero policies = empty reads).
ALTER TABLE public.navme_shop DISABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';
