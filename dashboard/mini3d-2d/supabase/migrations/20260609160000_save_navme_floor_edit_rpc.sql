-- Fast save for large floor_data JSONB (avoids default statement_timeout on huge upserts).
CREATE OR REPLACE FUNCTION public.save_navme_floor_edit(
  p_poi_type text,
  p_map_code text,
  p_floor_slice_y double precision,
  p_floor_data jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM set_config('statement_timeout', '120s', true);
  INSERT INTO public.navme_floor_edits (poi_type, map_code, floor_slice_y, floor_data, updated_at)
  VALUES (trim(p_poi_type), upper(trim(p_map_code)), p_floor_slice_y, p_floor_data, now())
  ON CONFLICT (poi_type, map_code) DO UPDATE SET
    floor_slice_y = EXCLUDED.floor_slice_y,
    floor_data = EXCLUDED.floor_data,
    updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.save_navme_floor_edit(text, text, double precision, jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.save_navme_floor_edit(text, text, double precision, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_navme_floor_edit(text, text, double precision, jsonb) TO service_role;
