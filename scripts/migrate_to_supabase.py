"""Copy the `public` schema's data from one PostgreSQL database into another.

Used once, to move this project's data from a developer's local PostgreSQL onto
the shared Supabase development database. Safe to re-run: it refuses to touch a
target that already holds data unless you say so explicitly.

    python scripts/migrate_to_supabase.py check      # connectivity + row counts, changes nothing
    python scripts/migrate_to_supabase.py copy       # source -> target
    python scripts/migrate_to_supabase.py verify     # per-table row-count parity
    python scripts/migrate_to_supabase.py sequences  # re-sync id sequences only

Both URLs are read from backend/.env, never from the command line, so database
passwords stay out of your shell history and out of the process list:

    DATABASE_URL            the TARGET (Supabase, once you have switched over)
    MIGRATION_SOURCE_URL    the SOURCE (your existing local PostgreSQL)

WHY NOT pg_dump | psql
----------------------
Because of ordering. A `--data-only` dump does not order rows by foreign-key
dependency, so restoring one into a schema whose constraints already exist --
which is exactly what `alembic upgrade head` gives you -- fails partway through
on tables like split_expense_shares whose parents have not been loaded yet. The
usual escape is `SET session_replication_role = replica`, which needs
privileges Supabase does not grant.

SQLAlchemy already knows the dependency order (`metadata.sorted_tables`), the
whole schema is under two thousand rows, and doing it here means the copy, the
sequence reset and the verification are one reviewable thing that runs the same
way on every developer's machine.

The `evolution` schema is deliberately not touched. It belongs to the
self-hosted Evolution API (WhatsApp), is managed by that service's own Prisma
migrations, and carries device-bound session state that several developers must
not share. This backend reaches it over HTTP, never over SQL.
"""
import os
import sys
from urllib.parse import urlsplit

from dotenv import load_dotenv
from sqlalchemy import create_engine, select, func, text

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

load_dotenv(os.path.join(os.path.dirname(__file__), "..", "backend", ".env"))

from backend.database import Base  # noqa: E402
from backend.models import domain  # noqa: F401,E402  -- registers every table

BATCH = 500


def _redact(url):
    """host:port/dbname -- never the password."""
    p = urlsplit(str(url))
    return "{}:{}/{}".format(p.hostname, p.port or 5432, (p.path or "/").lstrip("/"))


def _engines():
    target = (os.getenv("DATABASE_URL") or "").strip()
    source = (os.getenv("MIGRATION_SOURCE_URL") or "").strip()
    if not target:
        sys.exit("DATABASE_URL is not set in backend/.env (this is the TARGET).")
    if not source:
        sys.exit(
            "MIGRATION_SOURCE_URL is not set in backend/.env.\n"
            "Set it to your existing local database, e.g.\n"
            "  MIGRATION_SOURCE_URL=postgresql://postgres:PASSWORD@localhost:5432/zenith"
        )
    if source == target:
        sys.exit("MIGRATION_SOURCE_URL and DATABASE_URL are the same database. Refusing.")
    return (
        create_engine(source, connect_args={"connect_timeout": 10}),
        create_engine(target, connect_args={"connect_timeout": 10}),
    )


def _counts(engine):
    out = {}
    with engine.connect() as c:
        for t in Base.metadata.sorted_tables:
            try:
                out[t.name] = c.execute(select(func.count()).select_from(t)).scalar()
            except Exception:
                out[t.name] = None  # table absent on this side
    return out


def cmd_check():
    src, tgt = _engines()
    print("SOURCE {}".format(_redact(src.url)))
    print("TARGET {}\n".format(_redact(tgt.url)))

    s, t = _counts(src), _counts(tgt)
    missing = [n for n, v in t.items() if v is None]
    if missing:
        print("!! TARGET is missing {} table(s) -- run 'alembic upgrade head' first.".format(len(missing)))
        print("   e.g. {} ...\n".format(", ".join(missing[:6])))

    print("{:34}{:>9}{:>9}".format("table", "source", "target"))
    print("-" * 52)
    for name in sorted(s, key=lambda n: -(s[n] or 0)):
        if s[name] or t.get(name):
            print("{:34}{:>9}{:>9}".format(name, str(s[name]), str(t[name])))
    print("-" * 52)
    print("{:34}{:>9}{:>9}".format(
        "TOTAL",
        sum(v or 0 for v in s.values()),
        sum(v or 0 for v in t.values()),
    ))
    return s, t


def cmd_copy(force=False):
    src, tgt = _engines()
    print("SOURCE {}".format(_redact(src.url)))
    print("TARGET {}\n".format(_redact(tgt.url)))

    tcounts = _counts(tgt)
    if any(v is None for v in tcounts.values()):
        sys.exit("TARGET is missing tables. Run 'alembic upgrade head' against it first.")

    occupied = {n: v for n, v in tcounts.items() if v}
    if occupied and not force:
        print("TARGET already holds data:")
        for n, v in sorted(occupied.items(), key=lambda kv: -kv[1])[:10]:
            print("   {}: {} rows".format(n, v))
        sys.exit(
            "\nRefusing to copy into a non-empty database -- this is how a teammate's\n"
            "work gets duplicated or clobbered. If you are certain, re-run with --force."
        )

    total = 0
    # sorted_tables is ordered parents-before-children, so every foreign key
    # already has its target row by the time a child row is inserted.
    with src.connect() as sc, tgt.begin() as tc:
        for table in Base.metadata.sorted_tables:
            rows = [dict(r) for r in sc.execute(select(table)).mappings()]
            if not rows:
                continue
            for i in range(0, len(rows), BATCH):
                tc.execute(table.insert(), rows[i:i + BATCH])
            total += len(rows)
            print("  copied {:>6}  {}".format(len(rows), table.name))
    print("\n{} rows copied.".format(total))
    _reset_sequences(tgt)


def _reset_sequences(engine):
    """Point every id sequence past the highest id that was just inserted.

    Rows are copied with their original primary keys, which leaves each sequence
    still sitting at 1. Without this the very next INSERT the app performs
    collides on a key that already exists -- and it does so on a user action,
    not here, which makes it look like an application bug.
    """
    print("\nResetting id sequences:")
    fixed = 0
    with engine.begin() as c:
        for table in Base.metadata.sorted_tables:
            for col in table.primary_key.columns:
                seq = c.execute(
                    text("SELECT pg_get_serial_sequence(:t, :c)"),
                    {"t": "public." + table.name, "c": col.name},
                ).scalar()
                if not seq:
                    continue  # UUID / text primary key -- no sequence to move
                c.execute(
                    text(
                        'SELECT setval(:seq, COALESCE((SELECT MAX({}) FROM public."{}"), 0) + 1, false)'
                        .format(col.name, table.name)
                    ),
                    {"seq": seq},
                )
                fixed += 1
    print("  {} sequence(s) re-synced.".format(fixed))


def cmd_sequences():
    _, tgt = _engines()
    print("TARGET {}".format(_redact(tgt.url)))
    _reset_sequences(tgt)


def cmd_verify():
    s, t = cmd_check()
    bad = [n for n in s if (s[n] or 0) != (t.get(n) or 0)]
    print()
    if bad:
        print("MISMATCH on {} table(s): {}".format(len(bad), ", ".join(bad)))
        sys.exit(1)
    print("OK -- all {} tables match ({} rows).".format(
        len(s), sum(v or 0 for v in s.values())))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "check":
        cmd_check()
    elif cmd == "copy":
        cmd_copy(force="--force" in sys.argv)
    elif cmd == "verify":
        cmd_verify()
    elif cmd == "sequences":
        cmd_sequences()
    else:
        sys.exit("Unknown command '{}'. Use: check | copy | verify | sequences".format(cmd))
