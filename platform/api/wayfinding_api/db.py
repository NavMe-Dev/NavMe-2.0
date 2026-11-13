from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import get_settings


class Base(DeclarativeBase):
    pass


_engine = None
_Session = None


def connection_options(settings):
    """Build bounded psycopg connections without logging or interpolating secrets.

    Render/Connect-panel URLs commonly omit the SQLAlchemy driver name. This
    service installs psycopg 3, so select it explicitly instead of requiring
    psycopg2. Direct and session-pooler connections retain normal session state.
    """
    url = make_url(settings.database_url)
    if url.drivername in {"postgres", "postgresql"}:
        url = url.set(drivername="postgresql+psycopg")
    options = {"pool_pre_ping": True, "future": True, "hide_parameters": True}
    if url.get_backend_name() == "postgresql":
        args = {"connect_timeout": settings.db_connect_timeout_seconds}
        if settings.db_sslmode:
            args["sslmode"] = settings.db_sslmode
        # Keep any URL-provided startup options, then set the reviewed bounds.
        startup = url.query.get("options", "")
        args["options"] = (f"{startup} -c statement_timeout={settings.db_statement_timeout_ms} "
                           f"-c lock_timeout={settings.db_lock_timeout_ms}").strip()
        if settings.db_read_only or settings.wf_read_only:
            args["options"] += " -c default_transaction_read_only=on"
        options.update(connect_args=args, pool_size=settings.db_pool_size,
                       max_overflow=settings.db_max_overflow,
                       pool_timeout=settings.db_pool_timeout_seconds,
                       pool_recycle=settings.db_pool_recycle_seconds)
    return url, options


def configure_database_session(connection, settings):
    """Enforce session limits even when a pooler ignores libpq startup options.

    SET statements run in autocommit before any application transaction. Without
    this, a SET inside an implicit transaction could be rolled back by pooling.
    No application table is modified and a failed read-only assertion fails closed.
    """
    previous_autocommit = connection.autocommit
    connection.autocommit = True
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_config('statement_timeout', %s, false), "
                           "set_config('lock_timeout', %s, false)",
                           (str(settings.db_statement_timeout_ms), str(settings.db_lock_timeout_ms)))
            if settings.db_read_only or settings.wf_read_only:
                cursor.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY")
                cursor.execute("SHOW default_transaction_read_only")
                if cursor.fetchone()[0] != "on":
                    raise RuntimeError("Database read-only mode could not be established")
    finally:
        connection.autocommit = previous_autocommit


def build_engine(settings, **overrides):
    url, options = connection_options(settings)
    options.update(overrides)
    result = create_engine(url, **options)
    if url.get_backend_name() == "postgresql":
        event.listen(result, "connect", lambda connection, record: configure_database_session(connection, settings))
    return result


def engine():
    global _engine, _Session
    if _engine is None:
        _engine = build_engine(get_settings())
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def SessionLocal():
    engine(); return _Session()


def dispose_engine():
    """Release idle pooled connections during a graceful process shutdown."""
    global _engine, _Session
    if _engine is not None:
        _engine.dispose()
    _engine = _Session = None


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
