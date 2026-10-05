-- Partner API: list POIs for a project using NavMe API key (+ optional public_id).
CREATE OR REPLACE FUNCTION public.partner_list_pois(
  p_api_key text,
  p_public_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  clean_key text := nullif(trim(p_api_key), '');
  clean_id text := lower(nullif(trim(p_public_id), ''));
  cred public.navme_project_api_credentials%ROWTYPE;
  base_url text := rtrim(public._navme_cred_share_base(), '/');
  pois jsonb;
BEGIN
  IF clean_key IS NULL OR left(clean_key, 3) <> 'nm_' THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '28000';
  END IF;

  SELECT * INTO cred
  FROM public.navme_project_api_credentials c
  WHERE c.is_active = true
    AND c.api_key = clean_key
    AND (clean_id IS NULL OR c.public_id = clean_id)
  LIMIT 1;

  IF cred.id IS NULL THEN
    RAISE EXCEPTION 'Invalid API key' USING ERRCODE = '28000';
  END IF;

  SELECT coalesce(jsonb_agg(
    jsonb_build_object(
      'id', p.id,
      'name', coalesce(nullif(trim(p.poi_name), ''), 'Untitled'),
      'description', nullif(trim(p.description), ''),
      'category_type', p.category_type,
      'pos', jsonb_build_object(
        'x', p.pos_x,
        'y', p.pos_y,
        'z', p.pos_z
      ),
      'show_in_ar', coalesce(p.show_in_ar, true),
      'updated_at', p.updated_at
    )
    ORDER BY lower(coalesce(p.poi_name, '')),
             p.created_at
  ), '[]'::jsonb)
  INTO pois
  FROM public.navme_pois p
  WHERE lower(trim(p.poi_type)) = lower(trim(cred.poi_type))
    AND coalesce(p.is_active, true) = true;

  RETURN jsonb_build_object(
    'ok', true,
    'credential', jsonb_build_object(
      'name', cred.name,
      'public_id', cred.public_id,
      'share_url', base_url || '/c/' || cred.public_id
    ),
    'project', cred.poi_type,
    'count', jsonb_array_length(pois),
    'pois', pois
  );
END;
$$;

REVOKE ALL ON FUNCTION public.partner_list_pois(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.partner_list_pois(text, text) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.partner_list_pois(text, text) IS
  'Partner POI list. Authenticate with NavMe API key (nm_…). Optional public_id must match the key.';
