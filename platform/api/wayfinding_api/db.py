from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import get_settings


class Base(DeclarativeBase):
    pass


_engine = None
_Session = None


def engine():
    global _engine, _Session
    if _engine is None:
        _engine = create_engine(get_settings().database_url, pool_pre_ping=True, future=True)
        _Session = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def SessionLocal():
    engine(); return _Session()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
