"""Minimal Supabase REST client for the `navme_pois` table.

Uses PostgREST (the `/rest/v1` endpoint) directly via `requests`, matching how
the JS dashboard talks to Supabase in src/services/supabase.js.
"""

from typing import Any, Dict, List, Optional

import requests


class SupabaseError(RuntimeError):
    pass


class SupabaseClient:
    def __init__(self, url: str, key: str, timeout: int = 30) -> None:
        if not url or not key:
            raise SupabaseError("Supabase URL and key are required.")
        self._rest = f"{url.rstrip('/')}/rest/v1"
        self._timeout = timeout
        self._headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def _post(self, path: str, body: Any) -> Any:
        res = requests.post(
            f"{self._rest}/{path}",
            headers={**self._headers, "Prefer": "return=representation"},
            json=body,
            timeout=self._timeout,
        )
        return self._handle(res, "POST", path)

    def _patch(self, path: str, body: Any) -> Any:
        res = requests.patch(
            f"{self._rest}/{path}",
            headers={**self._headers, "Prefer": "return=representation"},
            json=body,
            timeout=self._timeout,
        )
        return self._handle(res, "PATCH", path)

    def _get(self, path: str) -> Any:
        res = requests.get(
            f"{self._rest}/{path}", headers=self._headers, timeout=self._timeout
        )
        return self._handle(res, "GET", path)

    @staticmethod
    def _handle(res: requests.Response, method: str, path: str) -> Any:
        if not res.ok:
            raise SupabaseError(
                f"Supabase {method} {path} -> {res.status_code}: {res.text}"
            )
        if not res.content:
            return None
        try:
            return res.json()
        except ValueError:
            return None

    def insert_poi(self, row: Dict[str, Any]) -> Dict[str, Any]:
        """Insert one POI row and return the created record."""
        data = self._post("navme_pois", row)
        if isinstance(data, list):
            return data[0] if data else {}
        return data or {}

    def update_poi(self, poi_id: str, patch: Dict[str, Any]) -> Dict[str, Any]:
        data = self._patch(f"navme_pois?id=eq.{poi_id}", patch)
        if isinstance(data, list):
            return data[0] if data else {}
        return data or {}

    def fetch_pois(
        self, poi_type: Optional[str] = None, select: str = "*"
    ) -> List[Dict[str, Any]]:
        query = f"navme_pois?select={select}&order=poi_name.asc"
        if poi_type:
            query += f"&poi_type=ilike.{requests.utils.quote(poi_type)}"
        data = self._get(query)
        return data if isinstance(data, list) else []
