"""Exercise the SELECT-only role in a fresh private synthetic PostgreSQL cluster."""
import os
from pathlib import Path
import sys
import time
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
ROLE = "navme_wayfinding_public_reader_v1"
LOGIN = "navme_wayfinding_live_v1"
FIXTURE_PASSWORD = "synthetic-reader-login-fixture-only"


class ReaderRoleCandidateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dsn = os.environ.get("NAVME_SECURITY_TEST_DSN", "")
        if not cls.dsn:
            raise unittest.SkipTest("Explicit disposable security staging DSN not supplied")
        config = conninfo_to_dict(cls.dsn)
        if (config.get("dbname") != "navme_security_test"
                or not config.get("host", "").startswith("/tmp/navme-security-")
                or "," in config.get("host", "")
                or set(config) - {"host", "port", "user", "dbname"}):
            raise RuntimeError("Reader tests refuse non-disposable/nonlocal staging")
        with psycopg.connect(cls.dsn, autocommit=True) as connection:
            if connection.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'").fetchone()[0]:
                raise RuntimeError("Reader staging must initially be empty")
            connection.execute("CREATE EXTENSION postgis")
            connection.execute("CREATE ROLE anon NOLOGIN")
            connection.execute("CREATE ROLE authenticated NOLOGIN")
        engine = create_engine("postgresql+psycopg://", creator=lambda: psycopg.connect(cls.dsn))
        Base.metadata.create_all(engine)
        with Session(engine) as session:
            session.add(models.User(email="synthetic-reader-fixture@example.invalid", password_hash="synthetic-test-hash", is_admin=True))
            session.add(models.Building(slug="synthetic-building", name="Synthetic public fixture"))
            session.commit()
        engine.dispose()
        candidate = (Path(__file__).parent / "reader_role_candidate.sql").read_text()
        with psycopg.connect(cls.dsn, autocommit=True) as connection:
            connection.execute("CREATE TABLE public.alembic_version (version_num varchar(32) PRIMARY KEY)")
            connection.execute("INSERT INTO public.alembic_version VALUES ('0001')")
            connection.execute("CREATE TABLE public.navme_users (id integer PRIMARY KEY, fixture text)")
            connection.execute("INSERT INTO public.navme_users VALUES (1,'synthetic-preserve-legacy')")
            connection.execute("GRANT USAGE ON SCHEMA public TO anon,authenticated")
            connection.execute("GRANT SELECT,INSERT,UPDATE,DELETE ON public.navme_users TO anon,authenticated")
            connection.execute("CREATE FUNCTION public.synthetic_admin_write() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN INSERT INTO public.navme_users VALUES (99,'must-not-execute'); RETURN 1; END $$")
            cls.baseline = cls.snapshot(connection)
            connection.execute("SET navme.reader_role_staging='enabled'")
            cls.unsafe_function_rejected = False
            try:
                connection.execute(candidate)
            except psycopg.errors.RaiseException as exc:
                if "SECURITY DEFINER" not in str(exc):
                    raise
                connection.execute("ROLLBACK")
                cls.unsafe_function_rejected = True
            assert cls.unsafe_function_rejected
            assert not connection.execute("SELECT 1 FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone()
            connection.execute("REVOKE EXECUTE ON FUNCTION public.synthetic_admin_write() FROM PUBLIC")
            connection.execute("GRANT EXECUTE ON FUNCTION public.synthetic_admin_write() TO anon,authenticated")
            connection.execute("GRANT UPDATE ON public.users TO PUBLIC")
            cls.inherited_write_rejected = False
            try:
                connection.execute(candidate)
            except psycopg.errors.RaiseException as exc:
                if "Inherited table mutation privilege" not in str(exc):
                    raise
                connection.execute("ROLLBACK")
                cls.inherited_write_rejected = True
            assert cls.inherited_write_rejected
            connection.execute("REVOKE UPDATE ON public.users FROM PUBLIC")
            connection.execute("GRANT CREATE ON SCHEMA public TO PUBLIC")
            cls.inherited_schema_create_rejected = False
            try:
                connection.execute(candidate)
            except psycopg.errors.RaiseException as exc:
                if "Inherited schema/database creation privilege" not in str(exc):
                    raise
                connection.execute("ROLLBACK")
                cls.inherited_schema_create_rejected = True
            assert cls.inherited_schema_create_rejected
            connection.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
            connection.execute(candidate)
            verifier=connection.pgconn.encrypt_password(FIXTURE_PASSWORD.encode(),LOGIN.encode(),b"scram-sha-256").decode()
            assert verifier.startswith("SCRAM-SHA-256$")
            connection.execute(sql.SQL("CREATE ROLE {} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD {}").format(sql.Identifier(LOGIN),sql.Literal(verifier)))
            connection.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(ROLE),sql.Identifier(LOGIN)))
            connection.execute(sql.SQL("ALTER ROLE {} SET default_transaction_read_only=on").format(sql.Identifier(LOGIN)))
            hba=Path(connection.execute("SHOW hba_file").fetchone()[0])
            if not hba.resolve().is_relative_to(Path(config["host"]).parent.resolve()):
                raise RuntimeError("Reader auth test refuses an HBA file outside its disposable staging")
            hba.write_text(f"local navme_security_test {LOGIN} scram-sha-256\n"+hba.read_text())
            connection.execute("SELECT pg_reload_conf()")
        cls.login_options={**config,"user":LOGIN,"password":FIXTURE_PASSWORD}
        # Wait only for this disposable server's HBA reload; no real secrets or
        # production endpoint are involved. A wrong password must be rejected.
        cls.scram_required=False
        deadline=time.monotonic()+3
        while time.monotonic()<deadline:
            try:
                with psycopg.connect(**{**cls.login_options,"password":"synthetic-wrong-password"}):
                    pass
            except psycopg.OperationalError:
                cls.scram_required=True
                break
            time.sleep(0.05)
        assert cls.scram_required

    @staticmethod
    def snapshot(connection):
        result = {}
        for table in TABLES + ["navme_users"]:
            result[table] = connection.execute(sql.SQL("SELECT count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) FROM public.{} t").format(sql.Identifier(table))).fetchone()
        return result

    def test_all_existing_fixture_rows_preserved(self):
        with psycopg.connect(self.dsn) as connection:
            self.assertEqual(self.baseline, self.snapshot(connection))

    def test_candidate_rejects_inherited_public_write_and_privileged_rpc(self):
        self.assertTrue(self.unsafe_function_rejected)
        self.assertTrue(self.inherited_write_rejected)

    def test_candidate_rejects_inherited_schema_creation(self):
        self.assertTrue(self.inherited_schema_create_rejected)

    def test_reader_selects_all_scoped_tables_with_rls(self):
        with psycopg.connect(self.dsn) as connection:
            connection.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(ROLE)))
            for table in TABLES:
                connection.execute(sql.SQL("SELECT count(*) FROM public.{}").format(sql.Identifier(table)))

    def test_reader_has_no_data_schema_or_sequence_mutation_privilege(self):
        statements = ["INSERT INTO public.venues(slug,name,branding,created_at) VALUES('unsafe','unsafe','{}',now())",
                      "UPDATE public.users SET is_admin=false", "DELETE FROM public.users", "TRUNCATE public.users",
                      "UPDATE public.alembic_version SET version_num='unsafe'", "SELECT nextval('public.users_id_seq')",
                      "CREATE TABLE public.unsafe_reader_table(id integer)"]
        for statement in statements:
            with self.subTest(statement=statement), psycopg.connect(self.dsn) as connection:
                connection.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(ROLE)))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    connection.execute(statement)

    def test_reader_cannot_invoke_privileged_legacy_rpc_or_read_legacy_table(self):
        for statement in ["SELECT public.synthetic_admin_write()", "SELECT * FROM public.navme_users"]:
            with self.subTest(statement=statement), psycopg.connect(self.dsn) as connection:
                connection.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(ROLE)))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    connection.execute(statement)

    def test_legacy_consumer_grants_remain_unchanged(self):
        with psycopg.connect(self.dsn) as connection:
            for role in ["anon", "authenticated"]:
                self.assertTrue(connection.execute("SELECT has_function_privilege(%s,'public.synthetic_admin_write()','EXECUTE')", (role,)).fetchone()[0])
                self.assertTrue(connection.execute("SELECT has_table_privilege(%s,'public.navme_users','UPDATE')", (role,)).fetchone()[0])

    def test_reader_has_no_login_bypass_or_role_memberships(self):
        with psycopg.connect(self.dsn) as connection:
            self.assertEqual(connection.execute("SELECT rolcanlogin,rolbypassrls,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=%s", (ROLE,)).fetchone(), (False,False,False,False,False))
            self.assertEqual(connection.execute("SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=%s)", (ROLE,)).fetchone()[0], 0)

    def test_dedicated_scram_login_inherits_only_reader_and_starts_readonly(self):
        self.assertTrue(self.scram_required)
        with psycopg.connect(**self.login_options) as connection:
            self.assertEqual(connection.execute("SELECT current_user").fetchone()[0],LOGIN)
            self.assertEqual(connection.execute("SHOW transaction_read_only").fetchone()[0],"on")
            self.assertTrue(connection.execute("SELECT pg_has_role(current_user,%s,'USAGE')",(ROLE,)).fetchone()[0])
            self.assertEqual(connection.execute("SELECT count(*) FROM public.buildings").fetchone()[0],1)
            self.assertFalse(connection.execute("SELECT has_function_privilege(current_user,'public.synthetic_admin_write()','EXECUTE')").fetchone()[0])
            self.assertEqual(connection.execute("SELECT count(*) FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)").fetchone()[0],1)

    def test_login_cannot_write_even_when_session_readonly_is_explicitly_disabled(self):
        with psycopg.connect(**self.login_options,autocommit=True) as connection:
            connection.execute("SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE")
            self.assertEqual(connection.execute("SHOW transaction_read_only").fetchone()[0],"off")
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                connection.execute("UPDATE public.users SET is_admin=false")


if __name__ == "__main__":
    unittest.main(verbosity=2)
