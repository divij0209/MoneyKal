"""Close the Supabase Data API over this schema.

Revision ID: f1a9c3e7b204
Revises: 1863a55d8be8
Create Date: 2026-09-10

WHY THIS EXISTS
---------------
Supabase publishes the `public` schema through PostgREST, and its default
privileges grant the `anon` and `authenticated` roles access to tables created
there. Our tables are created by Alembic connecting as `postgres`, so they land
in `public` and inherit exactly those grants — and, because nothing in this
codebase was ever written with row-level security in mind, they arrive with no
policies at all.

The result, without this migration, is that the project's anon key — which is
designed to be public and shipped to browsers — can read `users.hashed_password`
and `gmail_connections.refresh_token` straight out of the REST endpoint.

This backend never uses PostgREST. It connects to PostgreSQL directly as the
table owner, and an owner bypasses row-level security. So closing the door
costs the application nothing:

  * RLS is enabled on every table with no policies, which denies every role
    that is not the owner.
  * The grants themselves are revoked from `anon` and `authenticated`, so the
    REST layer cannot even see the tables.
  * Default privileges are altered so tables added by future migrations do not
    silently reopen the hole.

Everything is conditional on those roles existing, so this is a no-op on a
plain local PostgreSQL where `anon` and `authenticated` are not defined.
"""
from alembic import op

revision = 'f1a9c3e7b204'
down_revision = '1863a55d8be8'
branch_labels = None
depends_on = None


# alembic_version is deliberately left alone. Alembic must be able to write it
# to record this very migration, and it holds no user data worth protecting.
_ENABLE_RLS = """
DO $$
DECLARE t text;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> 'alembic_version'
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;
"""

_DISABLE_RLS = """
DO $$
DECLARE t text;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> 'alembic_version'
    LOOP
        EXECUTE format('ALTER TABLE public.%I DISABLE ROW LEVEL SECURITY', t);
    END LOOP;
END $$;
"""

_REVOKE_FROM_API_ROLES = """
DO $$
DECLARE r text;
BEGIN
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
            EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
            EXECUTE format('REVOKE USAGE ON SCHEMA public FROM %I', r);
            -- Tables created from here on, by whichever role runs migrations.
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
        END IF;
    END LOOP;
END $$;
"""


def upgrade() -> None:
    if op.get_bind().dialect.name == 'postgresql':
        op.execute(_ENABLE_RLS)
        op.execute(_REVOKE_FROM_API_ROLES)


def downgrade() -> None:
    # RLS comes back off, restoring the previous behaviour for the owner-facing
    # application (which was unaffected either way).
    #
    # The grants to `anon` and `authenticated` are deliberately NOT restored.
    # Re-granting them is what re-exposes password hashes and OAuth refresh
    # tokens to a public API key, and that is not something a routine
    # `alembic downgrade` should do silently. If you genuinely need the Data API
    # open on this schema, turn it on in the Supabase dashboard as a deliberate,
    # visible act.
    if op.get_bind().dialect.name == 'postgresql':
        op.execute(_DISABLE_RLS)
