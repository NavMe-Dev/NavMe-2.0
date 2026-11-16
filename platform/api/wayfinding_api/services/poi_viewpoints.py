"""Admin-only look targets, saved without granting the application table writes."""
from __future__ import annotations

import logging
import os
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.engine import make_url

logger = logging.getLogger(__name__)
ROLE = "navme_poi_viewpoint_writer"
SCHEMA = "navme_viewpoint_private"
SLUG = "uncc-main-campus"


class Target(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    x: float = Field(ge=-100000, le=100000)
    y: float = Field(ge=-100000, le=100000)
    z: float = Field(ge=-100000, le=100000)

    @field_validator("x", "y", "z", mode="before")
    @classmethod
    def real_number(cls, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Coordinates must be numbers")
        return value


class ViewpointUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target: Target | None
    revision: str = Field(max_length=40)

    @field_validator("revision")
    @classmethod
    def valid_revision(cls, value):
        if value != "default":
            try:
                if str(UUID(value)) != value:
                    raise ValueError()
            except ValueError:
                raise ValueError("Invalid viewpoint revision") from None
        return value


class ViewpointError(Exception):
    def __init__(self, status, message):
        self.status, self.message = status, message
        super().__init__(message)


def enabled(cfg, building):
    allowed = {s.strip() for s in str(getattr(cfg, "poi_viewpoint_buildings", "") or "").split(",")}
    return (getattr(building, "slug", "") == SLUG and SLUG in allowed
            and getattr(building, "matterport_model_id", "") == "kQBN52JqFE9")


def stored(extra):
    value = (extra or {}).get("directions_viewpoint")
    if not isinstance(value, dict):
        return None
    try:
        return ViewpointUpdate.model_validate(value)
    except ValueError:
        return None


def revision(extra):
    value = stored(extra)
    return value.revision if value else "default"


def get_target(extra):
    value = stored(extra)
    return value.target.model_dump() if value and value.target else None


def connection_arguments(value):
    """Accept only this role at the reviewed destination, never a general writer."""
    try:
        url = make_url(value)
        direct = url.host == "db.kzpvhzyefdtrtidrbuxb.supabase.co" and url.username == ROLE
        pooled = (url.host == "aws-0-ap-southeast-1.pooler.supabase.com"
                  and url.username == ROLE + ".kzpvhzyefdtrtidrbuxb")
        if (url.drivername not in {"postgres", "postgresql", "postgresql+psycopg"}
                or not (direct or pooled) or url.database != "postgres"
                or (url.port or 5432) != 5432 or not url.password
                or set(url.query) - {"sslmode"}
                or url.query.get("sslmode", "require") not in {"require", "verify-full"}):
            raise ValueError()
        return dict(host=url.host, port=url.port or 5432, dbname=url.database,
                    user=url.username, password=url.password, sslmode=url.query.get("sslmode", "require"),
                    connect_timeout=8, options="-c statement_timeout=8000 -c lock_timeout=3000",
                    application_name="navme-poi-viewpoint", prepare_threshold=None)
    except Exception:
        raise ViewpointError(503, "Viewpoint saving is not configured") from None


def write(cfg, building, poi_id, update):
    if not enabled(cfg, building):
        raise ViewpointError(404, "Viewpoint editing is unavailable for this building")
    args = connection_arguments(getattr(cfg, "poi_viewpoint_database_url", ""))
    try:
        # Explicit connection parameters prevent inherited libpq routing options
        # from overriding this host or login. No connection pool or owner key.
        if any(os.environ.get(key) for key in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")):
            raise ViewpointError(503, "Viewpoint saving is unavailable")
        with psycopg.connect(**args) as connection:
            if not connection.pgconn.ssl_in_use:
                raise ViewpointError(503, "Viewpoint saving is unavailable")
            result = connection.execute(
                "SELECT navme_viewpoint_private.set_viewpoint(%s,%s,%s,%s)",
                (building.slug, poi_id, Jsonb(update.target.model_dump()) if update.target else None,
                 update.revision)).fetchone()[0]
        return result
    except ViewpointError:
        raise
    except psycopg.Error as error:
        messages = {"P0002": (404, "Published POI not found"),
                    "40001": (409, "This POI was updated in another tab. Click Reload POIs, then select your point and save again."),
                    "22023": (422, "Invalid viewpoint")}
        status, message = messages.get(error.sqlstate, (503, "Could not save the viewpoint. Please retry."))
        logger.warning("POI viewpoint write unavailable: %s", type(error).__name__)
        raise ViewpointError(status, message) from None


FUNCTION_SQL = r"""
CREATE FUNCTION navme_viewpoint_private.set_viewpoint(
    p_slug text, p_id integer, p_target jsonb, p_revision text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
SET statement_timeout = '8s'
SET lock_timeout = '3s'
AS $function$
DECLARE
    existing jsonb;
    next_value jsonb;
    current_revision text;
    field_name text;
BEGIN
    IF p_slug IS DISTINCT FROM 'uncc-main-campus' THEN
        RAISE EXCEPTION 'Published POI not found' USING ERRCODE='P0002';
    END IF;
    IF p_target IS NOT NULL THEN
        IF jsonb_typeof(p_target) IS DISTINCT FROM 'object'
            OR (SELECT count(*) FROM jsonb_object_keys(p_target)) <> 3
            OR NOT (p_target ?& ARRAY['x','y','z']) THEN
            RAISE EXCEPTION 'Invalid viewpoint' USING ERRCODE='22023';
        END IF;
        FOREACH field_name IN ARRAY ARRAY['x','y','z'] LOOP
            IF jsonb_typeof(p_target->field_name) IS DISTINCT FROM 'number'
                OR abs((p_target->>field_name)::numeric) > 100000 THEN
                RAISE EXCEPTION 'Invalid viewpoint' USING ERRCODE='22023';
            END IF;
        END LOOP;
    END IF;
    SELECT p.extra INTO existing FROM public.pois p
    JOIN public.buildings b ON b.id=p.building_id
    WHERE p.id=p_id AND p.building_id=3 AND p.source='supabase' AND p.published
      AND b.slug=p_slug AND b.matterport_model_id='kQBN52JqFE9'
      AND b.pipeline_config->>'navme_poi_type'='Uncc_Navme'
      AND EXISTS (SELECT 1 FROM public.map_versions v WHERE v.building_id=b.id AND v.is_current)
      AND EXISTS (SELECT 1 FROM public.navme_pois n
                  WHERE n.id::text=p.extra->>'gmap_src_id' AND n.poi_type='Uncc_Navme')
    FOR UPDATE OF p;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Published POI not found' USING ERRCODE='P0002';
    END IF;
    current_revision := coalesce(existing->'directions_viewpoint'->>'revision','default');
    IF p_revision IS DISTINCT FROM current_revision THEN
        RAISE EXCEPTION 'Viewpoint changed' USING ERRCODE='40001';
    END IF;
    IF p_target IS NULL THEN
        next_value := NULL;
    ELSIF existing->'directions_viewpoint'->'target'=p_target THEN
        next_value := existing->'directions_viewpoint';
    ELSE
        next_value := jsonb_build_object('target',p_target,'revision',gen_random_uuid()::text);
    END IF;
    IF next_value IS DISTINCT FROM existing->'directions_viewpoint' THEN
        UPDATE public.pois SET extra=CASE WHEN next_value IS NULL
            THEN coalesce(extra,'{}'::jsonb)-'directions_viewpoint'
            ELSE jsonb_set(coalesce(extra,'{}'::jsonb),'{directions_viewpoint}',next_value,true) END
        WHERE id=p_id AND building_id=3 AND source='supabase' AND published;
    END IF;
    RETURN jsonb_build_object('id',p_id,'target',next_value->'target',
        'override',next_value IS NOT NULL,'revision',coalesce(next_value->>'revision','default'));
END;
$function$;
REVOKE ALL ON FUNCTION navme_viewpoint_private.set_viewpoint(text,integer,jsonb,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION navme_viewpoint_private.set_viewpoint(text,integer,jsonb,text)
    TO navme_poi_viewpoint_writer;
"""
