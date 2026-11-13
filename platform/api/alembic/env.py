from alembic import context
from sqlalchemy import create_engine, pool
from wayfinding_api.config import get_settings
from wayfinding_api.db import Base, connection_options
from wayfinding_api import models  # noqa: F401

config = context.config
database_url, database_options = connection_options(get_settings())
target_metadata = Base.metadata


def include_object(obj, name, type_, reflected, compare_to):
    # ignore PostGIS / tiger tables
    return not (type_ == "table" and reflected and compare_to is None)


def run_migrations_online():
    # Use the same psycopg driver and TLS settings as the API. Passing the URL
    # object directly also avoids ConfigParser interpolation of encoded passwords.
    eng = create_engine(database_url, poolclass=pool.NullPool,
                        connect_args=database_options.get("connect_args", {}), hide_parameters=True)
    with eng.connect() as conn:
        context.configure(connection=conn, target_metadata=target_metadata, include_object=include_object)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    context.configure(url=database_url, target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    run_migrations_online()
