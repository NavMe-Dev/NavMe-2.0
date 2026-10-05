let poiType = '';
let mapCode = '';
let organizationId = null;

export function setPoiSession({ poiType: nextPoiType, mapCode: nextMapCode, organizationId: nextOrganizationId }) {
  poiType = String(nextPoiType ?? '').trim();
  mapCode = String(nextMapCode ?? '').trim();
  organizationId = nextOrganizationId ?? null;
}

export function getPoiType() {
  return poiType;
}

export function getMapCode() {
  return mapCode;
}

export function getOrganizationId() {
  return organizationId;
}

export function clearPoiSession() {
  poiType = '';
  mapCode = '';
  organizationId = null;
}
