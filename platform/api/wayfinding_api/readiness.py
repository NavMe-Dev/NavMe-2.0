"""Read-only startup gate for hosts using TCP health checks.

No migrations or table writes. Failure prevents the HTTP listener from opening.
"""
import argparse
import logging
import time

from sqlalchemy import text

from .config import get_settings
from .db import build_engine


class DatabaseNotReady(RuntimeError):
    pass


def inspect_readiness(database, *, require_read_only=False):
    with database.connect() as connection:
        row = connection.execute(text("""
            SELECT postgis_version() AS postgis,
                   current_setting('transaction_read_only') AS read_only,
                   ARRAY(SELECT name FROM unnest(ARRAY[
                       'users','venues','buildings','floors','pois','control_points',
                       'nav_graphs','map_versions','jobs','alembic_version'
                   ]) AS name WHERE to_regclass(name) IS NULL) AS missing
        """)).mappings().one()
        if not row["postgis"] or row["missing"] or (require_read_only and row["read_only"] != "on"):
            raise DatabaseNotReady("Required database readiness checks did not pass")
        revisions = connection.execute(text("SELECT version_num FROM public.alembic_version")).scalars().all()
        if revisions != ["0001"]:
            raise DatabaseNotReady("Required database migration revision is unavailable")


def wait_for_database(settings, *, timeout=60, interval=2, clock=time.monotonic,
                      sleep=time.sleep, engine_factory=build_engine):
    # Keep each attempt bounded as well as the overall retry window. The final
    # attempt may finish after the window only within its connection/query bounds.
    bounded = settings.model_copy(update={
        "db_connect_timeout_seconds": min(settings.db_connect_timeout_seconds, 10),
        "db_statement_timeout_ms": min(settings.db_statement_timeout_ms, 3000),
        "db_lock_timeout_ms": min(settings.db_lock_timeout_ms, 1000),
    })
    database = engine_factory(bounded)
    deadline = clock() + timeout
    try:
        while clock() < deadline:
            try:
                inspect_readiness(database, require_read_only=settings.wf_read_only or settings.db_read_only)
                return
            except Exception as exc:
                # Never interpolate driver errors or connection values.
                logging.getLogger(__name__).warning("Database startup readiness pending (%s)", type(exc).__name__)
                remaining = deadline - clock()
                if remaining > 0:
                    sleep(min(interval, remaining))
        raise DatabaseNotReady("Database startup readiness timed out") from None
    finally:
        database.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=60)
    args = parser.parse_args()
    if not 1 <= args.timeout <= 120:
        parser.error("Startup timeout must be between 1 and 120 seconds")
    try:
        wait_for_database(get_settings(), timeout=args.timeout)
    except Exception as exc:
        print(f"Database startup readiness failed ({type(exc).__name__}); listener not started")
        return 1
    print("Database startup readiness passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
