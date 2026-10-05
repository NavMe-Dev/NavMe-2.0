"""FastAPI application. OpenAPI docs at /api/docs."""
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from . import __version__
from .config import get_settings
from .routers import auth, public, admin, vps, scan_plans


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Wayfinding Platform API", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url="/api/redoc")
    origins = [o.strip() for o in s.cors_origins.split(",")]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
        expose_headers=["*"],
    )
    for r in (auth.router, public.router, admin.files_router, admin.router, scan_plans.router, scan_plans.files_router, vps.router):
        app.include_router(r)

    @app.middleware("http")
    async def _dbg_http_middleware(request, call_next):
        from .services import debug_log as dbg
        try:
            resp = await call_next(request)
        except Exception as exc:
            if dbg.global_enabled():
                dbg.log_server("error", "api.exception", f"{request.method} {request.url.path}: {type(exc).__name__}: {exc}")
            raise
        if dbg.global_enabled() and resp.status_code >= 400 and request.url.path.startswith("/api/"):
            dbg.log_server(
                "error" if resp.status_code >= 500 else "warn",
                "api.http",
                f"{request.method} {request.url.path} → {resp.status_code}",
            )
        return resp

    @app.get("/api/health")
    def health():
        from sqlalchemy import text
        from .db import engine
        with engine().connect() as c:
            pg = c.execute(text("select postgis_version()")).scalar()
        return {"ok": True, "version": __version__, "postgis": pg}

    if s.worker_inline:
        from .services.jobs import start_inline_worker
        @app.on_event("startup")
        def _w(): start_inline_worker()
    # optional single-process static hosting (dev / small installs); in docker Caddy serves these
    # Shared UI locale dictionaries (viewer + admin language switchers). Prefer platform/locales,
    # else viewer/locales symlink, else admin/locales.
    locales_dir = None
    for cand in (
        Path(__file__).resolve().parents[2] / "locales",
        Path(s.viewer_dir) / "locales" if s.viewer_dir else None,
        Path(s.admin_dir) / "locales" if s.admin_dir else None,
    ):
        if cand and cand.is_dir():
            locales_dir = cand
            break
    if locales_dir:
        app.mount("/locales", StaticFiles(directory=locales_dir), name="locales")
    if s.admin_dir and Path(s.admin_dir).is_dir():
        app.mount("/admin", StaticFiles(directory=s.admin_dir, html=True), name="admin")
    # WebXR AR module (canonical source: /workspace/wayfinding/ar_webxr). Mount BEFORE the
    # viewer catch-all so /ar_webxr/* is reachable on the same HTTPS tunnel as the viewer.
    ar_dir = Path(__file__).resolve().parents[2].parent / "ar_webxr"
    if not ar_dir.is_dir():
        # fallback: copy/symlink under viewer/ar_webxr
        ar_dir = Path(s.viewer_dir) / "ar_webxr" if s.viewer_dir else None
    if ar_dir and ar_dir.is_dir():
        # Serve config.js dynamically so WF_AR_VARIANT_LAUNCH_KEY can inject variantLaunchKey
        # without committing secrets or using insecure ?vlk= query params. Registered BEFORE
        # the StaticFiles mount so this route wins.
        from fastapi.responses import Response
        import json as _json

        def _normalize_variant_launch_key(raw: str) -> str:
            """Bare SDK key only. Unwrap HTML embed / SDK URL if someone exported the snippet."""
            import re as _re
            k = (raw or "").strip()
            if not k:
                return ""
            # Accidental full <script src="…launchar.app/sdk/v1?key=…"> or bare SDK URL
            if "<script" in k.lower() or "launchar.app" in k.lower() or "key=" in k:
                m = _re.search(r"[?&]key=([A-Za-z0-9]+)", k)
                if m:
                    k = m.group(1).strip()
                else:
                    return ""  # reject unparseable embed-shaped values
            # Expect alphanumeric bare key (Variant keys are 32 chars letters/digits)
            if not k.isalnum():
                return ""
            return k

        @app.get("/ar_webxr")
        async def ar_webxr_slash_redirect(request: Request):
            """Bare /ar_webxr is not served by StaticFiles (404). Redirect so Variant/App Clip never lands on map /."""
            from fastapi.responses import RedirectResponse
            q = ("?" + request.url.query) if request.url.query else ""
            return RedirectResponse(url="/ar_webxr/" + q, status_code=307)

        @app.get("/ar_webxr/config.js")
        def ar_config_js():
            cfg_path = ar_dir / "config.js"
            body = cfg_path.read_text(encoding="utf-8") if cfg_path.is_file() else ""
            key = _normalize_variant_launch_key(s.wf_ar_variant_launch_key or "")
            if key and 'variantLaunchKey: ""' in body:
                body = body.replace('variantLaunchKey: ""', "variantLaunchKey: " + _json.dumps(key), 1)
            return Response(body, media_type="application/javascript; charset=utf-8",
                            headers={"Cache-Control": "no-store"})

        app.mount("/ar_webxr", StaticFiles(directory=str(ar_dir), html=True), name="ar_webxr")
    if s.viewer_dir and Path(s.viewer_dir).is_dir():
        app.mount("/", StaticFiles(directory=s.viewer_dir, html=True), name="viewer")
    return app


app = create_app()
