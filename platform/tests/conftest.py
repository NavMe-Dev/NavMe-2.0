"""Test config: uses a separate PostGIS database (TEST_DATABASE_URL, default wayfinding_test) and a temp DATA_DIR.
Integration tests that need the onboarded Greenland workspace are skipped if it is absent."""
import os, sys, tempfile, pathlib
from sqlalchemy.engine import make_url
ROOT = pathlib.Path(__file__).resolve().parents[1]


def validate_test_database_url(value):
    """Integration fixtures rebuild tables: refuse any nonlocal or normal DB.

    Never let TEST_DATABASE_URL turn an automated test into a production reset.
    A remote destination copy must first be restored to an isolated local DB.
    """
    try:
        url = make_url(value)
    except Exception:
        raise RuntimeError("Invalid test database configuration") from None
    routing_overrides = {"host", "hostaddr", "port", "dbname", "database", "service", "servicefile"}
    if (url.drivername not in {"postgres", "postgresql", "postgresql+psycopg"}
            or url.host not in {"localhost", "127.0.0.1", "::1"}
            or not (url.database or "").endswith("_test")
            or routing_overrides.intersection(url.query)):
        raise RuntimeError("Tests require a local PostgreSQL database whose name ends in _test")
    return value


def _default_test_url():
    """TEST_DATABASE_URL, else DATABASE_URL from env/.env with the database name swapped to wayfinding_test."""
    url = os.environ.get("DATABASE_URL")
    envf = ROOT / ".env"
    if not url and envf.exists():
        for line in envf.read_text().splitlines():
            if line.startswith("DATABASE_URL="): url = line.split("=", 1)[1].strip()
    url = url or "postgresql+psycopg://wayfinding:wayfinding@localhost:5432/wayfinding"
    return make_url(url).set(database="wayfinding_test").render_as_string(hide_password=False)
os.environ["DATABASE_URL"] = validate_test_database_url(os.environ.get("TEST_DATABASE_URL") or _default_test_url())
# Do not let inherited libpq routing/service settings override the explicit
# validated local URL (PGHOSTADDR can route independently of its hostname).
for _routing_env in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
    os.environ.pop(_routing_env, None)
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="wf_test_")
os.environ["JWT_SECRET"] = "test-secret-0123456789abcdef0123456789"
os.environ.setdefault("MATTERPORT_SDK_KEY", "")
sys.path[:0] = [str(ROOT / "api"), str(ROOT / "pipeline")]
GREENLAND_WS = pathlib.Path(os.environ.get("GREENLAND_WS", ROOT / "var/data/buildings/greenland"))
