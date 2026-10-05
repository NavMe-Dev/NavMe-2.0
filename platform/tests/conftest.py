"""Test config: uses a separate PostGIS database (TEST_DATABASE_URL, default wayfinding_test) and a temp DATA_DIR.
Integration tests that need the onboarded Greenland workspace are skipped if it is absent."""
import os, sys, tempfile, pathlib
ROOT = pathlib.Path(__file__).resolve().parents[1]
def _default_test_url():
    """TEST_DATABASE_URL, else DATABASE_URL from env/.env with the database name swapped to wayfinding_test."""
    url = os.environ.get("DATABASE_URL")
    envf = ROOT / ".env"
    if not url and envf.exists():
        for line in envf.read_text().splitlines():
            if line.startswith("DATABASE_URL="): url = line.split("=", 1)[1].strip()
    url = url or "postgresql+psycopg://wayfinding:wayfinding@localhost:5432/wayfinding"
    return url.rsplit("/", 1)[0] + "/wayfinding_test"
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or _default_test_url()
os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="wf_test_")
os.environ["JWT_SECRET"] = "test-secret-0123456789abcdef0123456789"
os.environ.setdefault("MATTERPORT_SDK_KEY", "")
sys.path[:0] = [str(ROOT / "api"), str(ROOT / "pipeline")]
GREENLAND_WS = pathlib.Path(os.environ.get("GREENLAND_WS", ROOT / "var/data/buildings/greenland"))
