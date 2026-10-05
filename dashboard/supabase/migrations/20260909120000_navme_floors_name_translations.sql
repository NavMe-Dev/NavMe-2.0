-- Multilingual floor names (mirrors navme_categories name_* + jsonb bag).
ALTER TABLE public.navme_floors
  ADD COLUMN IF NOT EXISTS name_en text,
  ADD COLUMN IF NOT EXISTS name_enus text,
  ADD COLUMN IF NOT EXISTS name_es text,
  ADD COLUMN IF NOT EXISTS name_fr text,
  ADD COLUMN IF NOT EXISTS name_ar text,
  ADD COLUMN IF NOT EXISTS name_zh text,
  ADD COLUMN IF NOT EXISTS name_ja text,
  ADD COLUMN IF NOT EXISTS name_hi text,
  ADD COLUMN IF NOT EXISTS name_kn text,
  ADD COLUMN IF NOT EXISTS name_pt text,
  ADD COLUMN IF NOT EXISTS name_ta text,
  ADD COLUMN IF NOT EXISTS name_ml text,
  ADD COLUMN IF NOT EXISTS name_te text,
  ADD COLUMN IF NOT EXISTS name_bn text,
  ADD COLUMN IF NOT EXISTS floor_names jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Seed English from canonical name for existing rows.
UPDATE public.navme_floors
SET
  name_en = COALESCE(NULLIF(TRIM(name_en), ''), name),
  name_enus = COALESCE(NULLIF(TRIM(name_enus), ''), name),
  floor_names = CASE
    WHEN floor_names IS NULL OR floor_names = '{}'::jsonb
      THEN jsonb_build_object('en', name)
    ELSE floor_names || jsonb_build_object('en', COALESCE(floor_names->>'en', name))
  END
WHERE TRUE;
