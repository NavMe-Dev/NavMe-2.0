-- Multilingual POI descriptions (mirrors poi_name_* / poi_names).
ALTER TABLE public.navme_pois
  ADD COLUMN IF NOT EXISTS description_en text,
  ADD COLUMN IF NOT EXISTS description_es text,
  ADD COLUMN IF NOT EXISTS description_fr text,
  ADD COLUMN IF NOT EXISTS description_ar text,
  ADD COLUMN IF NOT EXISTS description_zh text,
  ADD COLUMN IF NOT EXISTS description_ja text,
  ADD COLUMN IF NOT EXISTS description_hi text,
  ADD COLUMN IF NOT EXISTS description_kn text,
  ADD COLUMN IF NOT EXISTS description_pt text,
  ADD COLUMN IF NOT EXISTS description_ta text,
  ADD COLUMN IF NOT EXISTS description_ml text,
  ADD COLUMN IF NOT EXISTS description_te text,
  ADD COLUMN IF NOT EXISTS description_bn text,
  ADD COLUMN IF NOT EXISTS descriptions jsonb;

-- Seed English from the existing description column where present.
UPDATE public.navme_pois
SET
  description_en = COALESCE(description_en, description),
  descriptions = COALESCE(
    descriptions,
    CASE
      WHEN description IS NOT NULL AND btrim(description) <> ''
        THEN jsonb_build_object('en', description)
      ELSE NULL
    END
  )
WHERE description IS NOT NULL AND btrim(description) <> '';
