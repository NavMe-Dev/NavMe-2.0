"""Settings from environment (.env). Secrets are never logged.

Runtime overlay (Config Option 2): var/runtime_settings.json (non-secrets) and
var/runtime_secrets.env (0600, write-only) merge on top of env after load.
get_settings() is lru_cached — call get_settings.cache_clear() after overlay saves
(or restart via scripts/dev_server.sh restart).
"""
from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    database_url: str = "postgresql+psycopg://wayfinding:wayfinding_dev@localhost:5432/wayfinding"
    jwt_secret: str = "change-me"
    jwt_expire_minutes: int = 720
    data_dir: Path = Path("./var/data")
    matterport_sdk_key: str = ""          # Showcase SDK application key (never returned in full to clients)
    matterport_token_id: str = ""         # Model API (GraphQL) token id — server-only, never returned to clients
    matterport_token_secret: str = ""     # Model API token secret — server-only, never returned/logged
    vps_url: str = ""                     # optional visual positioning service (POST /localize)
    public_base_url: str = "http://localhost:8780"
    cors_origins: str = "*"
    viewer_dir: Path | None = None        # serve viewer static files at /  (dev / single-process mode)
    admin_dir: Path | None = None         # serve admin static files at /admin
    geocoder: str = "esri"                # esri | nominatim
    worker_inline: bool = False           # run onboarding jobs in a thread of the API process (no separate worker)
    max_upload_mb: int = 8192
    # Variant Launch SDK key for iOS App Clip WebXR (injected into /ar_webxr/config.js). Never commit real keys.
    wf_ar_variant_launch_key: str = ""
    # Public viewer chat (Option 3 phase 1). Keys never returned to clients.
    wf_chat_enabled: bool = False
    wf_chat_llm_base_url: str = ""       # OpenAI-compatible base, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1
    wf_chat_llm_api_key: str = ""
    wf_chat_llm_model: str = "gpt-4o-mini"
    wf_chat_rate_limit_per_min: int = 20
    supabase_url: str = ""
    supabase_anon_key: str = ""
    # Backend-only secret — bypasses RLS, never sent to any client. Used solely to upload
    # published bundles to Supabase Storage so they survive a Render free-tier disk wipe
    # (see services/bundle_storage.py). Empty disables that fallback entirely (local disk
    # only), which is what local dev always uses.
    supabase_service_role_key: str = ""
    supabase_storage_bucket: str = "wayfinding-bundles"
    # One-time HTTP admin bootstrap for hosts with no Shell access (e.g. Render free
    # plan) — see routers/auth.py:bootstrap_admin. Empty disables the endpoint.
    bootstrap_secret: str = ""

    @property
    def buildings_dir(self) -> Path: return self.data_dir / "buildings"
    @property
    def published_dir(self) -> Path: return self.data_dir / "published"
    @property
    def uploads_dir(self) -> Path: return self.data_dir / "uploads"
    @property
    def scan_plans_dir(self) -> Path: return self.data_dir / "scan_plans"


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    try:
        from .services import runtime_config as rt
        rt.apply_overlays_to_settings(s)
    except Exception:
        pass
    for d in (s.buildings_dir, s.published_dir, s.uploads_dir, s.scan_plans_dir):
        d.mkdir(parents=True, exist_ok=True)
    return s


def reload_settings() -> Settings:
    """Clear lru_cache and rebuild Settings with current overlays."""
    get_settings.cache_clear()
    return get_settings()
