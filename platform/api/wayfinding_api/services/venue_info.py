"""Current Matterport display metadata via the platform's existing integration."""
import logging
from wfpipe.steps.fetch_mp import gql

log = logging.getLogger(__name__)
QUERY = """query($id:ID!){model(id:$id){id name address{address lines locality administrativeArea postalCode countryName}}}"""


def venue_info(building):
    mid = (building.matterport_model_id or '').strip()
    branding = building.branding or {}
    result = {"building_slug": building.slug, "model_id": mid,
              "name": (building.name or '').strip() or 'Venue information',
              "address": building.address or '', "description": branding.get('description') or '',
              "source": 'navme' if (building.name or '').strip() else 'fallback'}
    if not mid:
        return result
    # Only trust synchronized metadata if it explicitly identifies this model.
    info = building.model_info or {}
    if (info.get('model_id') or info.get('matterport_model_id')) == mid and (info.get('mp_name') or '').strip():
        result.update(name=info['mp_name'].strip(), source='synchronized-matterport')
    try:
        response = gql(QUERY, {"id": mid}, timeout=8)
        model = (response.get('data') or {}).get('model') or {}
        name = str(model.get('name') or '').strip()
        if model.get('id') == mid and name:
            result.update(name=name, source='matterport')
            address = model.get('address') or {}
            lines = [address['address']] if address.get('address') else (address.get('lines') or [])
            parts = [*lines, *(address.get(k) for k in ('locality', 'administrativeArea', 'postalCode', 'countryName'))]
            if any(parts):
                result['address'] = ', '.join(str(part) for part in parts if part)
        else:
            log.warning('Matterport venue metadata did not identify the current space for %s', building.slug)
    except Exception as exc:
        log.warning('Matterport venue metadata unavailable for %s (%s)', building.slug, type(exc).__name__)
    return result
