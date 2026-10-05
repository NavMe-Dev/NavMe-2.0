from alembic import context
from sqlalchemy import engine_from_config, pool
from wayfinding_api.config import get_settings
from wayfinding_api.db import Base
from wayfinding_api import models  # noqa: F401

config = context.config
config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    # ignore PostGIS / tiger tables
    return not (type_ == "table" and reflected and compare_to is None)


def run_migrations_online():
    eng = engine_from_config(config.get_section(config.config_ini_section), prefix="sqlalchemy.", poolclass=pool.NullPool)
    with eng.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, include_object=include_object)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    context.configure(url=config.get_main_option("sqlalchemy.url"), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
