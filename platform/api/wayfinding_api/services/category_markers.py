"""Read-only, venue-scoped data for optional dollhouse category labels."""
from . import navme, navme_sync


def marker_data(cfg, building):
    # Legacy buildings can fall back to a lowercase URL slug ("gcu") while the
    # Dashboard stores the same venue as "GCU". Venue identifiers are otherwise
    # exact, so a case-insensitive comparison fixes those records without widening
    # the query to another venue.
    filters = {"poi_type": "ilike." + navme.pg_value(navme.poi_type(building))}
    categories = navme_sync.fetch_rows(cfg, "navme_categories", {
        **filters, "select": "id,name,icon_key,sort_order,category_names"})
    rows = navme_sync.fetch_rows(cfg, "navme_pois", {
        **filters, "is_active": "is.true", "select":
        "id,pos_x,pos_y,pos_z,is_active,category_type,category_types"})
    # This mirrored table has no FK constraints, so PostgREST cannot embed it.
    # Read only links belonging to this venue's active IDs, in bounded batches.
    links = {}
    ids = [str(row["id"]) for row in rows]
    for start in range(0, len(ids), 100):
        batch = ",".join(ids[start:start + 100])
        linked = navme_sync.fetch_rows(cfg, "navme_poi_categories", {
            "poi_id": f"in.({batch})", "select": "poi_id,category_id"}, order="poi_id.asc,category_id.asc")
        for link in linked:
            links.setdefault(str(link.get("poi_id")), []).append(link.get("category_id"))
    known = {str(c["id"]) for c in categories}
    pois = []
    for row in rows:
        memberships = [row.get("category_type"), *(row.get("category_types") or []),
                       *links.get(str(row["id"]), [])]
        ids = sorted({str(cid) for cid in memberships if cid and str(cid) in known})
        pois.append({"id": str(row["id"]), "venue": building.slug, "category_ids": ids,
                     "x": row.get("pos_x"), "y": row.get("pos_y"), "z": row.get("pos_z"),
                     "is_active": row.get("is_active") is True})
    return {"building_slug": building.slug, "coordinate_system": "matterport-sdk-y-up",
            "categories": categories, "pois": pois}
