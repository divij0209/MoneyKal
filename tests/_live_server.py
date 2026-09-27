"""Guard for tests that talk to a running server over HTTP.

Most tests here are self-contained: they set DATABASE_URL to a throwaway
SQLite file before importing the backend, so they cannot touch anything real.

A handful are different. They use `requests` against BASE_URL and exercise a
server that is already running, which means they write to whatever database
THAT process was started with — not to anything this test process configures.
On a developer machine the running backend is started from backend/.env, which
points at the shared Supabase database, so these tests silently register real
accounts in production. Several `clean_test_*@zenith.com` and
`excel_test_*@zenith.com` rows accumulated there before this guard existed.

Setting DATABASE_URL in the test does not help, because the writes happen in
the server process. The only safe rule is: do not run these unless someone has
said the target server is disposable.

Usage, at the top of the test function:

    from tests._live_server import require_live_server_optin
    if not require_live_server_optin(BASE_URL):
        return

Run them deliberately with:

    E2E_ALLOW_LIVE_SERVER=true python tests/test_section5_excel.py
"""
import os
import sys

ENV_FLAG = "E2E_ALLOW_LIVE_SERVER"


def live_server_allowed() -> bool:
    return os.getenv(ENV_FLAG, "").lower() in ("1", "true", "yes")


def skip_reason(base_url: str) -> str:
    return (
        f"Skipped: this test registers real accounts against the server at "
        f"{base_url}. That server writes to the database IT was started with, "
        f"which on a developer machine is the shared Supabase one. "
        f"Set {ENV_FLAG}=true only when that server is backed by a disposable "
        f"database."
    )


def require_live_server_optin(base_url: str) -> bool:
    """True if the test may run. Otherwise reports the skip and returns False."""
    if live_server_allowed():
        return True
    reason = skip_reason(base_url)
    # pytest.skip() raises, which is right under pytest and wrong when the file
    # is run as a plain script — there the exception would surface as a crash.
    # sys.modules is the reliable tell: pytest is only imported when it is the
    # thing running us.
    if "pytest" in sys.modules:
        import pytest
        pytest.skip(reason)
    print(reason)
    return False
