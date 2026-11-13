"""Real authorization checks on an explicit disposable local PostgreSQL cluster.

Run only with NAVME_SECURITY_TEST_DSN pointing at its Unix socket and the exact
navme_security_test DB. Fixtures below are synthetic and never production data.
The tests apply the review-only candidate locally, never to hosted Supabase.
"""
import os
from pathlib import Path
import sys
import unittest

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "platform/api"))
from wayfinding_api import models  # noqa: E402
from wayfinding_api.db import Base  # noqa: E402

TABLES = ["users", "venues", "buildings", "floors", "pois", "control_points",
          "nav_graphs", "map_versions", "jobs", "alembic_version"]


class SecurityCandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dsn = os.environ.get("NAVME_SECURITY_TEST_DSN", "")
        if not cls.dsn:
            raise unittest.SkipTest("Explicit disposable local security staging DSN not supplied")
        config = conninfo_to_dict(cls.dsn)
        if (config.get("dbname") != "navme_security_test"
                or not config.get("host", "").startswith("/tmp/navme-security-")
                or "," in config.get("host", "")
                or set(config) - {"host", "port", "user", "dbname"}):
            raise RuntimeError("Refusing security tests outside the named disposable local Unix-socket cluster")
        with psycopg.connect(cls.dsn, autocommit=True) as connection:
            if connection.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'").fetchone()[0]:
                raise RuntimeError("Security staging must be empty before this test fixture creates objects")
            connection.execute("CREATE EXTENSION postgis")
            connection.execute("CREATE ROLE anon NOLOGIN")
            connection.execute("CREATE ROLE authenticated NOLOGIN")
        engine = create_engine("postgresql+psycopg://", creator=lambda: psycopg.connect(cls.dsn))
        Base.metadata.create_all(engine)
        with Session(engine) as session:
            session.add(models.User(email="synthetic-admin@example.invalid", password_hash="synthetic-test-hash", is_admin=True))
            venue = models.Venue(slug="synthetic-venue", name="Synthetic fixture venue")
            session.add(venue)
            session.flush()
            building = models.Building(slug="synthetic-building", name="Synthetic fixture building", venue_id=venue.id)
            session.add(building)
            session.commit()
        engine.dispose()
        with psycopg.connect(cls.dsn, autocommit=True) as connection:
            connection.execute("CREATE TABLE public.alembic_version (version_num varchar(32) PRIMARY KEY)")
            connection.execute("INSERT INTO public.alembic_version VALUES ('0001')")
            connection.execute("CREATE TABLE public.navme_users (id integer PRIMARY KEY, private_field text)")
            connection.execute("CREATE TABLE public.spatial_spaces (id integer PRIMARY KEY, name text)")
            connection.execute("INSERT INTO public.navme_users VALUES (1, 'synthetic-preserve-legacy')")
            connection.execute("INSERT INTO public.spatial_spaces VALUES (1, 'synthetic-preserve-connectlabs')")
            connection.execute("GRANT USAGE ON SCHEMA public TO anon, authenticated")
            connection.execute("GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated")
            connection.execute("GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated")
            # Independent column grant must be removed as well as table grants.
            connection.execute("GRANT SELECT(email) ON public.users TO anon")
            cls.baseline = cls.snapshot(connection)
            connection.execute("SET navme.security_candidate_staging = 'enabled'")
            connection.execute((Path(__file__).parent / "security_candidate.sql").read_text())

    @staticmethod
    def snapshot(connection):
        out = {}
        for table in TABLES + ["navme_users", "spatial_spaces"]:
            query = sql.SQL("SELECT count(*), md5(coalesce(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text), '')) FROM public.{} t").format(sql.Identifier(table))
            out[table] = connection.execute(query).fetchone()
        return out

    def test_all_baseline_rows_preserved_exactly(self):
        with psycopg.connect(self.dsn) as connection:
            self.assertEqual(self.baseline, self.snapshot(connection))

    def test_anonymous_identity_cannot_read_write_or_use_sequence(self):
        self.assert_browser_denied("anon")

    def test_authenticated_identity_cannot_read_write_or_use_sequence(self):
        self.assert_browser_denied("authenticated")

    def assert_browser_denied(self, role):
        for statement in ["SELECT email FROM public.users", "SELECT * FROM public.buildings",
                          "UPDATE public.users SET is_admin=true", "DELETE FROM public.users",
                          "INSERT INTO public.users(email,password_hash,is_admin,created_at) VALUES ('injected@example.invalid','fixture',true,now())",
                          "SELECT nextval('public.users_id_seq')"]:
            with self.subTest(role=role, statement=statement):
                with psycopg.connect(self.dsn) as connection:
                    connection.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        connection.execute(statement)

    def test_backend_service_principal_reads_scoped_tables_and_performs_crud(self):
        with psycopg.connect(self.dsn) as connection:
            connection.execute("SET LOCAL ROLE navme_wayfinding_backend")
            for table in TABLES:
                connection.execute(sql.SQL("SELECT count(*) FROM public.{}").format(sql.Identifier(table)))
            inserted = connection.execute("INSERT INTO public.users(email,password_hash,is_admin,created_at) VALUES ('new-fixture@example.invalid','fixture',false,now()) RETURNING id").fetchone()[0]
            self.assertEqual(connection.execute("UPDATE public.users SET email='updated-fixture@example.invalid' WHERE id=%s RETURNING id", (inserted,)).fetchone()[0], inserted)
            self.assertEqual(connection.execute("DELETE FROM public.users WHERE id=%s RETURNING id", (inserted,)).fetchone()[0], inserted)
            connection.rollback()

    def test_backend_cannot_mutate_migration_history_or_truncate_application(self):
        for statement in ["UPDATE public.alembic_version SET version_num='unsafe'", "TRUNCATE public.users", "SELECT * FROM public.navme_users"]:
            with self.subTest(statement=statement), psycopg.connect(self.dsn) as connection:
                connection.execute("SET LOCAL ROLE navme_wayfinding_backend")
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    connection.execute(statement)

    def test_rls_and_backend_role_are_narrowly_scoped(self):
        with psycopg.connect(self.dsn) as connection:
            rows = connection.execute("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relname=ANY(%s)", (TABLES,)).fetchall()
            self.assertEqual(len(rows), len(TABLES))
            self.assertTrue(all(enabled for _, enabled in rows))
            role = connection.execute("SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname='navme_wayfinding_backend'").fetchone()
            self.assertEqual(role, (False, False, False, False, False))
            policies = connection.execute("SELECT tablename, roles FROM pg_policies WHERE policyname='wayfinding_backend_access'").fetchall()
            self.assertEqual(len(policies), len(TABLES))
            self.assertTrue(all(roles == ["navme_wayfinding_backend"] for _, roles in policies))

    def test_legacy_compatibility_is_explicitly_unresolved_not_claimed_fixed(self):
        # The narrow candidate intentionally leaves the legacy broad grants alone.
        # This confirms that passing these tests does not resolve the shared app risk.
        with psycopg.connect(self.dsn) as connection:
            self.assertTrue(connection.execute("SELECT has_table_privilege('anon','public.navme_users','SELECT')").fetchone()[0])
            self.assertFalse(connection.execute("SELECT relrowsecurity FROM pg_class WHERE oid='public.navme_users'::regclass").fetchone()[0])
            self.assertFalse(connection.execute("SELECT relrowsecurity FROM pg_class WHERE oid='public.spatial_spaces'::regclass").fetchone()[0])


if __name__ == "__main__":
    unittest.main(verbosity=2)
