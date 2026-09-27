"""Bring the local database in line with the models.

Run this after pulling a change that touches backend/models/domain.py:

    python migrate.py

WHY THIS IS MORE THAN create_all()
----------------------------------
`create_all()` creates tables that do not exist yet. It never adds a column to
a table that already does. That difference is silent and it bites: a change
that adds a column to an existing table would leave this script printing
"Migration completed." over a database that is still missing it, and then every
request touching that table fails with "column ... does not exist" — which
looks like a broken feature rather than a schema that was never updated.

So this also adds columns the models declare and the database lacks.

It is additive only. Nothing is ever dropped, renamed or retyped, no data is
touched, and running it twice is a no-op. It is not a replacement for Alembic —
Alembic remains the record of how the schema got here, and anything that needs
a backfill, a rename or a type change still needs a real migration written by
hand. This closes the gap for the common case of a new column on an existing
table.
"""
import os
import sys

from sqlalchemy import inspect, text
from sqlalchemy.schema import CreateColumn

from backend.database import engine, Base, describe_target, is_remote
from backend.models import domain  # noqa: F401  — imported so the models register

# ---------------------------------------------------------------------------
# This script is for a database you own. It is not for the shared one.
#
# Everything below reads the models and reshapes the database to match. On a
# private local database that is a convenience. On the shared development
# database it is a schema change with no migration behind it: your teammates'
# Alembic history will not contain it, `alembic upgrade head` on their machine
# will not reproduce it, and the next real migration may fail to apply against
# a schema no revision describes. The failure lands on someone else, later,
# with no clue pointing back here.
#
# So against a remote database this refuses, and points at Alembic instead.
# ---------------------------------------------------------------------------
print(f"Target: {describe_target()}")

if is_remote() and os.getenv("ALLOW_REMOTE_SCHEMA_SYNC", "").lower() not in ("1", "true", "yes"):
    print()
    print("Refusing to run: this DATABASE_URL points at a remote (shared) database.")
    print()
    print("Schema changes there belong in an Alembic revision, so that every")
    print("teammate gets the same change by running the same command:")
    print()
    print("    alembic revision --autogenerate -m \"describe your change\"")
    print("    # review the generated file, then:")
    print("    alembic upgrade head")
    print()
    print("See SUPABASE.md > 'Changing the schema'. If you genuinely need to")
    print("force this (recovering a broken shared database, say), re-run with")
    print("ALLOW_REMOTE_SCHEMA_SYNC=true and tell the team first.")
    sys.exit(1)

# Tables first, exactly as before.
Base.metadata.create_all(bind=engine)

# Then columns. The inspector is built after create_all so it sees any table it
# just made.
inspector = inspect(engine)
live_tables = set(inspector.get_table_names())

added = []
needs_a_real_migration = []

with engine.begin() as conn:
    for table_name, table in Base.metadata.tables.items():
        if table_name not in live_tables:
            continue  # create_all just made it, so it is already correct

        live_columns = {c["name"] for c in inspector.get_columns(table_name)}

        for column in table.columns:
            if column.name in live_columns:
                continue

            # A NOT NULL column with no default cannot be added to a table that
            # already has rows — there is no value to put in them. That needs a
            # decision (a default, or a backfill), which is a migration someone
            # writes rather than something this script should guess at.
            if not column.nullable and column.server_default is None:
                needs_a_real_migration.append(f"{table_name}.{column.name}")
                continue

            # CreateColumn compiles the name, type, NOT NULL and DEFAULT for the
            # dialect in use, so this is correct on PostgreSQL and SQLite alike.
            spec = CreateColumn(column).compile(dialect=engine.dialect)
            conn.execute(text(f'ALTER TABLE "{table_name}" ADD COLUMN {spec}'))
            added.append(f"{table_name}.{column.name}")

if added:
    print(f"Added {len(added)} missing column(s):")
    for name in added:
        print(f"  + {name}")
else:
    print("Schema already matches the models; no columns to add.")

if needs_a_real_migration:
    print()
    print("These columns are NOT NULL with no default and were left alone —")
    print("they need a migration that decides what existing rows should hold:")
    for name in needs_a_real_migration:
        print(f"  ! {name}")

print("Migration completed.")
