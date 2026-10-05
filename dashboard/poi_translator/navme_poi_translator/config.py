"""Environment-driven configuration for the POI translator."""

import os
from dataclasses import dataclass
from typing import Optional

from dotenv import load_dotenv

load_dotenv()

# Shared organization used by all NavMe projects (mirrors the JS dashboard
# default in src/config/organization.js). navme_pois.organization_id is NOT NULL.
DEFAULT_ORGANIZATION_ID = "db204331-02bd-4fa4-9c5d-569ea1d9329f"


def _first_env(*names: str, default: str = "") -> str:
    for name in names:
        value = os.getenv(name)
        if value:
            return value
    return default


@dataclass
class Settings:
    supabase_url: str
    supabase_key: str
    organization_id: str
    poi_type: Optional[str]
    translator_backend: str
    source_language: str
    deepl_api_key: Optional[str]

    @classmethod
    def from_env(cls) -> "Settings":
        url = _first_env("SUPABASE_URL", "VITE_SUPABASE_URL").rstrip("/")
        key = _first_env(
            "SUPABASE_KEY",
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_ANON_KEY",
            "VITE_SUPABASE_ANON_KEY",
        )
        return cls(
            supabase_url=url,
            supabase_key=key,
            organization_id=_first_env(
                "NAVME_ORGANIZATION_ID", default=DEFAULT_ORGANIZATION_ID
            ),
            poi_type=os.getenv("NAVME_POI_TYPE") or None,
            translator_backend=os.getenv("TRANSLATOR_BACKEND", "google").lower(),
            source_language=os.getenv("SOURCE_LANGUAGE", "auto"),
            deepl_api_key=os.getenv("DEEPL_API_KEY") or None,
        )

    def validate(self) -> None:
        missing = []
        if not self.supabase_url:
            missing.append("SUPABASE_URL")
        if not self.supabase_key:
            missing.append("SUPABASE_KEY")
        if missing:
            raise ValueError(
                "Missing required environment variables: "
                + ", ".join(missing)
                + ". Copy poi_translator/.env.example to .env and fill them in."
            )
