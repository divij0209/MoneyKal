"""Database engine and session factory.

One engine, configured entirely from `DATABASE_URL` in backend/.env, so the
same code runs against a developer's local PostgreSQL and against the shared
Supabase development database with nothing changed but that one variable.

WHY THERE IS NO LONGER A DEFAULT URL
------------------------------------
This used to fall back to `sqlite:///./twin.db` when DATABASE_URL was unset.
That fallback was silent, and silence is the problem: a teammate whose .env was
missing or misspelt did not get an error, they got a private, empty SQLite file
and an app that appeared to work. On a shared team database that failure mode
is worse than a crash — they would be developing against data nobody else can
see and reporting bugs nobody else can reproduce. A missing DATABASE_URL now
stops the process with an explanation.
"""
import os
import socket
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '.env'))

SQLALCHEMY_DATABASE_URL = os.getenv("DATABASE_URL", "").strip()

if not SQLALCHEMY_DATABASE_URL:
    raise RuntimeError(
        "DATABASE_URL is not set.\n\n"
        "Copy backend/.env.example to backend/.env and fill in DATABASE_URL.\n"
        "For the shared Supabase development database, use the Session Pooler\n"
        "connection string — see SUPABASE.md for where to find it.\n"
    )

_parts = urlsplit(SQLALCHEMY_DATABASE_URL)
_is_sqlite = _parts.scheme.startswith("sqlite")
_host = (_parts.hostname or "").lower()
_is_local = _host in ("", "localhost", "127.0.0.1", "::1")


def _ensure_sslmode(url: str) -> str:
    """Require TLS when talking to a database that is not on this machine.

    Every row this connection carries — bcrypt password hashes, Gmail OAuth
    refresh tokens — is worth protecting in transit, and a developer who forgets
    `?sslmode=require` on their Supabase URL would otherwise not find out. Local
    connections are left exactly as written, because requiring TLS against a
    default local PostgreSQL install would break every existing setup.
    """
    if _is_sqlite or _is_local:
        return url
    query = dict(parse_qsl(_parts.query, keep_blank_values=True))
    if "sslmode" in query:
        return url
    query["sslmode"] = "require"
    return urlunsplit(_parts._replace(query=urlencode(query)))


SQLALCHEMY_DATABASE_URL = _ensure_sslmode(SQLALCHEMY_DATABASE_URL)

# `application_name` is what Supabase's dashboard shows next to each open
# connection. With several developers on one database, an anonymous list of
# connections is useless; this makes it obvious whose backend is holding what.
_app_name = os.getenv("DB_APP_NAME") or f"moneykal-{socket.gethostname()}"

if _is_sqlite:
    connect_args = {"check_same_thread": False}
    engine_kwargs = {}
else:
    connect_args = {
        "connect_timeout": int(os.getenv("DB_CONNECT_TIMEOUT", "10")),
        "application_name": _app_name[:63],
    }
    engine_kwargs = {
        # A remote database closes idle connections without telling the client.
        # Without pre_ping the first query on a dead connection fails with
        # "SSL connection has been closed unexpectedly" — an error that looks
        # like a bug in whatever feature happened to run it.
        "pool_pre_ping": True,
        # Recycle below any intermediary idle timeout so we retire connections
        # before the far end does.
        "pool_recycle": int(os.getenv("DB_POOL_RECYCLE", "1800")),
        # Deliberately small. A hosted database has a connection budget shared
        # by the whole team, and each developer runs a backend with a scheduler.
        "pool_size": int(os.getenv("DB_POOL_SIZE", "5")),
        "max_overflow": int(os.getenv("DB_MAX_OVERFLOW", "5")),
        "pool_timeout": int(os.getenv("DB_POOL_TIMEOUT", "30")),
    }

engine = create_engine(
    SQLALCHEMY_DATABASE_URL,
    connect_args=connect_args,
    echo=os.getenv("DB_ECHO", "").lower() in ("1", "true", "yes"),
    **engine_kwargs,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()


def describe_target() -> str:
    """Host and database name, never the password. For startup logs and scripts."""
    if _is_sqlite:
        return f"sqlite:{_parts.path}"
    return f"{_host}:{_parts.port or 5432}/{(_parts.path or '/').lstrip('/')}"


def is_remote() -> bool:
    """True when DATABASE_URL points somewhere other than this machine.

    Used by the schema tools to refuse operations that are safe on a private
    local database and unsafe on one the whole team shares.
    """
    return not (_is_sqlite or _is_local)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def auto_create_all() -> None:
    """Create missing tables from the models — only when explicitly allowed.

    This used to run unconditionally on every backend start. On a database that
    belongs to one developer that is a harmless convenience. On a database the
    whole team shares it is the single most likely way for two people's work to
    collide: whoever starts their backend first mints tables straight from
    whatever `domain.py` their branch happens to have, Alembic has no record
    that it happened, and the next person's migration runs against a schema
    that does not match any revision. The damage is silent and shows up later
    as a migration that will not apply.

    So the default is now off, and Alembic is the only thing that changes a
    shared schema. `DB_AUTO_CREATE=true` re-enables it for a private local
    database, where the old convenience is still worth having.

    Callers must import the models before calling this, so the metadata is
    populated.
    """
    allowed = os.getenv("DB_AUTO_CREATE", "").lower() in ("1", "true", "yes")
    if not allowed:
        return
    if is_remote():
        raise RuntimeError(
            f"DB_AUTO_CREATE is set, but DATABASE_URL points at a remote database "
            f"({describe_target()}).\n"
            "Refusing: creating tables straight from the models on a shared database "
            "puts it out of step with Alembic for everyone.\n"
            "Use 'alembic upgrade head' instead — see SUPABASE.md."
        )
    Base.metadata.create_all(bind=engine)
