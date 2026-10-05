-- Log partner API create/update/delete into navme_user_logs (same table as dashboard User logs).

CREATE OR REPLACE FUNCTION public._navme_log_partner_activity(
  p_cred public.navme_project_api_credentials,
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_entity_label text,
  p_details jsonb DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  actor text := 'api:' || coalesce(nullif(trim(p_cred.name), ''), p_cred.public_id);
  summary text;
BEGIN
  summary := actor || ' ' || p_action || ' ' || p_entity_type
    || CASE WHEN nullif(trim(p_entity_label), '') IS NOT NULL
         THEN ' "' || trim(p_entity_label) || '"'
         ELSE '' END
    || ' (API)';

  INSERT INTO public.navme_user_logs (
    poi_type,
    actor_email,
    actor_role,
    actor_account_id,
    action,
    entity_type,
    entity_id,
    entity_label,
    summary,
    details
  ) VALUES (
    p_cred.poi_type,
    actor,
    'api_credential',
    p_cred.created_by,
    p_action,
    p_entity_type,
    p_entity_id,
    nullif(trim(p_entity_label), ''),
    summary,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object(
      'source', 'partner_api',
      'credential_id', p_cred.id,
      'credential_name', p_cred.name,
      'credential_public_id', p_cred.public_id
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_upsert_poi(
  p_api_key text,
  p_public_id text DEFAULT NULL,
  p_poi jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  cred public.navme_project_api_credentials%ROWTYPE;
  poi_id uuid;
  clean_name text;
  row public.navme_pois%ROWTYPE;
  is_create boolean := false;
  log_action text;
BEGIN
  cred := public._navme_cred_auth_key(p_api_key, p_public_id);
  IF NOT coalesce(cred.scope_write, false) THEN
    RAISE EXCEPTION 'Write scope required' USING ERRCODE = '42501';
  END IF;

  clean_name := nullif(trim(coalesce(p_poi->>'name', p_poi->>'poi_name', '')), '');
  IF clean_name IS NULL THEN
    RAISE EXCEPTION 'POI name is required';
  END IF;

  BEGIN
    poi_id := nullif(trim(coalesce(p_poi->>'id', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    RAISE EXCEPTION 'Invalid POI id';
  END;

  IF poi_id IS NOT NULL THEN
    UPDATE public.navme_pois p
    SET
      poi_name = clean_name,
      description = coalesce(nullif(trim(p_poi->>'description'), ''), p.description),
      pos_x = coalesce((p_poi->'pos'->>'x')::numeric, (p_poi->>'pos_x')::numeric, p.pos_x),
      pos_y = coalesce((p_poi->'pos'->>'y')::numeric, (p_poi->>'pos_y')::numeric, p.pos_y),
      pos_z = coalesce((p_poi->'pos'->>'z')::numeric, (p_poi->>'pos_z')::numeric, p.pos_z),
      updated_at = now()
    WHERE p.id = poi_id
      AND lower(trim(p.poi_type)) = lower(trim(cred.poi_type))
    RETURNING * INTO row;

    IF row.id IS NULL THEN
      RAISE EXCEPTION 'POI not found';
    END IF;
    log_action := 'updated';
  ELSE
    is_create := true;
    INSERT INTO public.navme_pois (
      poi_name, poi_type, description, pos_x, pos_y, pos_z, is_active, show_in_ar
    )
    VALUES (
      clean_name,
      cred.poi_type,
      nullif(trim(p_poi->>'description'), ''),
      coalesce((p_poi->'pos'->>'x')::numeric, (p_poi->>'pos_x')::numeric, 0),
      coalesce((p_poi->'pos'->>'y')::numeric, (p_poi->>'pos_y')::numeric, 0),
      coalesce((p_poi->'pos'->>'z')::numeric, (p_poi->>'pos_z')::numeric, 0),
      true,
      true
    )
    RETURNING * INTO row;
    log_action := 'created';
  END IF;

  PERFORM public._navme_log_partner_activity(
    cred,
    log_action,
    'poi',
    row.id::text,
    row.poi_name,
    jsonb_build_object(
      'via', CASE WHEN is_create THEN 'partner_api_create' ELSE 'partner_api_update' END,
      'pos', jsonb_build_object('x', row.pos_x, 'y', row.pos_y, 'z', row.pos_z)
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'poi', jsonb_build_object(
      'id', row.id,
      'name', row.poi_name,
      'description', row.description,
      'pos', jsonb_build_object('x', row.pos_x, 'y', row.pos_y, 'z', row.pos_z)
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_delete_poi(
  p_api_key text,
  p_public_id text DEFAULT NULL,
  p_poi_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  cred public.navme_project_api_credentials%ROWTYPE;
  removed int := 0;
  old_name text;
BEGIN
  cred := public._navme_cred_auth_key(p_api_key, p_public_id);
  IF NOT coalesce(cred.scope_delete, false) THEN
    RAISE EXCEPTION 'Delete scope required' USING ERRCODE = '42501';
  END IF;
  IF p_poi_id IS NULL THEN
    RAISE EXCEPTION 'POI id is required';
  END IF;

  SELECT p.poi_name INTO old_name
  FROM public.navme_pois p
  WHERE p.id = p_poi_id
    AND lower(trim(p.poi_type)) = lower(trim(cred.poi_type))
  LIMIT 1;

  DELETE FROM public.navme_pois p
  WHERE p.id = p_poi_id
    AND lower(trim(p.poi_type)) = lower(trim(cred.poi_type));

  GET DIAGNOSTICS removed = ROW_COUNT;
  IF removed = 0 THEN
    RAISE EXCEPTION 'POI not found';
  END IF;

  PERFORM public._navme_log_partner_activity(
    cred,
    'deleted',
    'poi',
    p_poi_id::text,
    coalesce(old_name, 'POI'),
    jsonb_build_object('via', 'partner_api_delete')
  );

  RETURN jsonb_build_object('ok', true, 'deleted_id', p_poi_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public._navme_log_partner_activity(public.navme_project_api_credentials, text, text, text, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.partner_upsert_poi(text, text, jsonb) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.partner_delete_poi(text, text, uuid) TO anon, authenticated, service_role;
