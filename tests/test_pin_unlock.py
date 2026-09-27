"""
MoneyKal PIN / device unlock — end-to-end test suite.

Runs the real FastAPI app in-process against a throwaway SQLite file, so every
assertion below goes through the actual HTTP layer: real JWT signing, real
bcrypt, real rate limiting. Nothing is mocked, and no row these tests read was
inserted directly — every one was created by calling the same endpoints the
website calls.

Run with:  python tests/test_pin_unlock.py

Written as a plain script rather than a pytest module to match the convention
already used by the other tests in this directory, but each check is an assert
and the script exits non-zero if anything fails.

WHAT THIS IS ACTUALLY TESTING
-----------------------------
The PIN is an unlock layer, not a second password, and the properties worth
pinning down are the ones that make that true:

  * neither half works alone — a device token is not a credential, and a PIN
    without a device token has nothing to unlock;
  * the three-day cap is absolute and unlocking cannot slide it forward;
  * guessing is bounded, because 10,000 candidates is small enough that the
    rate limiter IS the security boundary;
  * no response ever carries the PIN or its hash.
"""
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta

# Point the app at a scratch database *before* anything imports
# backend.database, which reads DATABASE_URL at module scope.
_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_pin_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

# backend.core.auth refuses to import without a signing key, by design. A test
# run needs one that is real but disposable; an existing JWT_SECRET in the
# environment is left alone so this can also run against a configured checkout.
os.environ.setdefault("JWT_SECRET", "test-only-signing-key-" + uuid.uuid4().hex)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from jose import jwt  # noqa: E402

from backend.database import Base, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402  (registers the tables)
from backend.main import app  # noqa: E402
from backend.core.auth import (  # noqa: E402
    ALGORITHM, SECRET_KEY, TYP_DEVICE, TYP_REFRESH,
    DEVICE_TOKEN_EXPIRE_MINUTES, create_device_token,
)
from backend.routers.auth import pin_limiter  # noqa: E402
from backend.core.ratelimit import login_ip_limiter, login_limiter  # noqa: E402

Base.metadata.create_all(bind=engine)
client = TestClient(app)

PASSED = 0
FAILED = []


def check(label, condition, detail=""):
    global PASSED
    if condition:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}" + (f"\n        {detail}" if detail else ""))


def section(title):
    print(f"\n{title}\n" + "-" * len(title))


PASSWORD = "correct-horse-battery"


def clear_limiters(username=None, user_id=None):
    """The limiters are in-process and shared across every test in this file,
    so a test that deliberately triggers a lockout would otherwise poison the
    ones after it. Cleared between scenarios rather than disabled, so the
    lockout tests still exercise the real limiter."""
    login_ip_limiter.reset("ip:testclient")
    login_ip_limiter.reset("ip:unknown")
    if username:
        login_limiter.reset(f"user:{username}")
    if user_id is not None:
        pin_limiter.reset(f"pin:{user_id}")


def new_account(remember_device=True):
    """A fresh account, and a sign-in that asks to be remembered.

    Returns (username, register_body, login_body).
    """
    username = f"pin_{uuid.uuid4().hex[:10]}@moneykal.test"
    reg = client.post("/auth/register", json={"username": username, "password": PASSWORD})
    assert reg.status_code == 200, f"register failed: {reg.status_code} {reg.text}"

    clear_limiters(username)
    login = client.post("/auth/login", json={
        "username": username,
        "password": PASSWORD,
        "remember_device": remember_device,
    })
    assert login.status_code == 200, f"login failed: {login.status_code} {login.text}"
    return username, reg.json(), login.json()


def auth(token):
    return {"Authorization": f"Bearer {token}"}


# ===========================================================================
section("1. Login — the device token is additive and opt-in")
# ===========================================================================

_u, _reg, plain = new_account(remember_device=False)
check("no device token when the box is not ticked",
      plain.get("device_token") is None,
      f"got {plain.get('device_token')!r}")
check("login still returns an access token as it always did",
      bool(plain.get("access_token")))
check("login reports whether the account has a PIN",
      plain.get("pin_set") is False,
      f"pin_set={plain.get('pin_set')!r}")

username, _reg, remembered = new_account(remember_device=True)
device_token = remembered.get("device_token")
check("a device token is issued when the box is ticked", bool(device_token))
check("its lifetime is reported to the client",
      remembered.get("device_expires_in") == DEVICE_TOKEN_EXPIRE_MINUTES * 60,
      f"got {remembered.get('device_expires_in')!r}")
check("the cap is three days",
      DEVICE_TOKEN_EXPIRE_MINUTES == 60 * 24 * 3,
      f"got {DEVICE_TOKEN_EXPIRE_MINUTES} minutes")

access_token = remembered["access_token"]
user_id = remembered["user_id"]

# ===========================================================================
section("2. A device token is not a credential")
# ===========================================================================

r = client.get("/auth/pin/status", headers=auth(device_token))
check("a device token is rejected as a bearer token", r.status_code == 401,
      f"got {r.status_code} {r.text}")

r = client.get("/profile/me", headers=auth(device_token))
check("...on an ordinary data route too", r.status_code == 401,
      f"got {r.status_code} {r.text}")

r = client.post("/auth/refresh", json={"refresh_token": device_token})
check("a device token cannot stand in for a refresh token", r.status_code == 401,
      f"got {r.status_code} {r.text}")

r = client.post("/auth/pin/unlock", json={"device_token": access_token, "pin": "4917"})
check("an access token cannot stand in for a device token", r.status_code == 401,
      f"got {r.status_code} {r.text}")

r = client.post("/auth/pin/unlock",
                json={"device_token": remembered["refresh_token"], "pin": "4917"})
check("a refresh token cannot stand in for a device token", r.status_code == 401,
      f"got {r.status_code} {r.text}")

r = client.post("/auth/pin/unlock", json={"device_token": "not-a-jwt", "pin": "4917"})
check("garbage is rejected", r.status_code == 401, f"got {r.status_code}")

# ===========================================================================
section("3. Unlock is impossible before a PIN exists")
# ===========================================================================

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("a valid device token alone unlocks nothing", r.status_code == 401,
      f"got {r.status_code} {r.text}")
check("...and is told to use the password",
      "password" in r.json().get("detail", "").lower(),
      r.text)

r = client.get("/auth/pin/status", headers=auth(access_token))
check("status reports no PIN", r.status_code == 200 and r.json()["pin_set"] is False, r.text)
check("status reports the device window", r.json().get("device_days") == 3, r.text)

# ===========================================================================
section("4. Setting a PIN")
# ===========================================================================

clear_limiters(username, user_id)

r = client.post("/auth/pin/set", json={"pin": "4917", "password": PASSWORD})
check("setting a PIN requires a signed-in session", r.status_code == 401,
      f"got {r.status_code}")

clear_limiters(username, user_id)
r = client.post("/auth/pin/set", json={"pin": "4917", "password": "wrong-password"},
                headers=auth(access_token))
check("setting a PIN requires the account password", r.status_code == 401,
      f"got {r.status_code} {r.text}")

clear_limiters(username, user_id)
for bad, why in [
    ("1234", "an obvious sequence"),
    ("0000", "all the same digit"),
    ("111111", "all the same digit, six long"),
    ("123456", "an obvious sequence, six long"),
    ("12345", "five digits"),
    ("123", "three digits"),
    ("12a4", "not digits"),
    ("", "empty"),
]:
    r = client.post("/auth/pin/set", json={"pin": bad, "password": PASSWORD},
                    headers=auth(access_token))
    check(f"rejects {why} ({bad!r})", r.status_code == 422, f"got {r.status_code} {r.text}")

r = client.post("/auth/pin/set", json={"pin": "4917", "password": PASSWORD},
                headers=auth(access_token))
check("accepts a good 4-digit PIN", r.status_code == 200, f"got {r.status_code} {r.text}")
check("reports when it was set", bool(r.json().get("pin_set_at")), r.text)
check("the response carries no hash and no PIN",
      "pin_hash" not in r.text and "4917" not in r.text, r.text)

r = client.get("/auth/pin/status", headers=auth(access_token))
check("status now reports a PIN", r.json()["pin_set"] is True, r.text)
check("status carries no hash", "pin_hash" not in r.text, r.text)

# ===========================================================================
section("5. Unlocking")
# ===========================================================================

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("the right PIN and device token unlock", r.status_code == 200,
      f"got {r.status_code} {r.text}")

unlocked = r.json()
check("an access token comes back", bool(unlocked.get("access_token")), r.text)
check("the response carries no hash and no PIN",
      "pin_hash" not in r.text and '"4917"' not in r.text, r.text)

r = client.get("/auth/pin/status", headers=auth(unlocked["access_token"]))
check("the unlocked token really is an access token", r.status_code == 200,
      f"got {r.status_code} {r.text}")

# Not 200: this account never completed onboarding, so /profile/me answers 404.
# That is the point — a 404 is the ROUTE talking, which means the token got past
# authentication. A 401 would mean it had not.
r = client.get("/profile/me", headers=auth(unlocked["access_token"]))
check("...and it authenticates on ordinary data routes", r.status_code != 401,
      f"got {r.status_code} {r.text}")

# --- the three-day cap must not slide ---------------------------------------
original_exp = jwt.decode(device_token, SECRET_KEY, algorithms=[ALGORITHM])["exp"]
check("unlocking does not hand back a new device token",
      unlocked.get("device_token") is None,
      f"got {unlocked.get('device_token')!r}")
check("the reported expiry is the ORIGINAL one, not a renewed one",
      unlocked.get("device_expires_at", "").startswith(
          datetime.utcfromtimestamp(original_exp).isoformat()[:16]),
      f"expires_at={unlocked.get('device_expires_at')!r} vs exp={original_exp}")

clear_limiters(username, user_id)
again = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("a second unlock also leaves the window where it was",
      again.status_code == 200 and again.json().get("device_expires_at") ==
      unlocked.get("device_expires_at"),
      f"{again.json().get('device_expires_at')!r} vs {unlocked.get('device_expires_at')!r}")

# ===========================================================================
section("6. A wrong PIN, and the limit on guessing")
# ===========================================================================

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4918"})
check("a wrong PIN is refused", r.status_code == 401, f"got {r.status_code}")
check("...without saying which half was wrong",
      "4918" not in r.text and "pin_hash" not in r.text, r.text)

clear_limiters(username, user_id)
statuses = []
for i in range(7):
    rr = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4918"})
    statuses.append(rr.status_code)

check("guessing is cut off — 5 wrong PINs then 429",
      statuses[:5] == [401] * 5 and 429 in statuses[5:],
      f"statuses={statuses}")

last = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4918"})
check("the lockout names Retry-After", "Retry-After" in last.headers,
      dict(last.headers))

# The lockout must hold even for the CORRECT PIN — otherwise a limiter that
# only counts failures is trivially sidestepped by the attacker who guesses
# right on attempt six.
locked = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("the lockout holds even against the right PIN", locked.status_code == 429,
      f"got {locked.status_code} {locked.text}")

# ...and a malformed PIN must not be a free probe that skips the counter.
clear_limiters(username, user_id)
for _ in range(5):
    client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "!!!!"})
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("a malformed PIN still costs an attempt", r.status_code == 429,
      f"got {r.status_code} {r.text}")

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("the right PIN works again once the counter is cleared", r.status_code == 200,
      f"got {r.status_code} {r.text}")

# ===========================================================================
section("7. The three-day cap is enforced")
# ===========================================================================

expired = jwt.encode(
    {"sub": str(user_id), "typ": TYP_DEVICE,
     "exp": datetime.utcnow() - timedelta(minutes=1)},
    SECRET_KEY, algorithm=ALGORITHM,
)
clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": expired, "pin": "4917"})
check("an expired device token is refused", r.status_code == 401, f"got {r.status_code}")
check("...and says the password is needed",
      "password" in r.json().get("detail", "").lower(), r.text)

# A token signed with the wrong key — the forgery case.
forged = jwt.encode(
    {"sub": str(user_id), "typ": TYP_DEVICE,
     "exp": datetime.utcnow() + timedelta(days=3)},
    "a-different-signing-key", algorithm=ALGORITHM,
)
r = client.post("/auth/pin/unlock", json={"device_token": forged, "pin": "4917"})
check("a forged device token is refused", r.status_code == 401, f"got {r.status_code}")

# A token for somebody else's account must unlock somebody else's account and
# nothing more — the subject is what decides, not the caller.
other_user, _, other_login = new_account(remember_device=True)
other_id = other_login["user_id"]
clear_limiters(other_user, other_id)
r = client.post("/auth/pin/unlock",
                json={"device_token": create_device_token(other_id), "pin": "4917"})
check("this account's PIN does not open another account",
      r.status_code == 401, f"got {r.status_code} {r.text}")

# ===========================================================================
section("8. Changing and turning off the PIN")
# ===========================================================================

clear_limiters(username, user_id)
r = client.post("/auth/pin/set", json={"pin": "836254", "password": PASSWORD},
                headers=auth(access_token))
check("a 6-digit PIN is accepted", r.status_code == 200, f"got {r.status_code} {r.text}")

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"})
check("the replaced PIN stops working", r.status_code == 401, f"got {r.status_code}")

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "836254"})
check("the new PIN works", r.status_code == 200, f"got {r.status_code} {r.text}")

r = client.delete("/auth/pin", headers=auth(access_token))
check("the PIN can be turned off", r.status_code == 200 and r.json()["pin_set"] is False, r.text)

clear_limiters(username, user_id)
r = client.post("/auth/pin/unlock", json={"device_token": device_token, "pin": "836254"})
check("a device token is inert once the PIN is off", r.status_code == 401,
      f"got {r.status_code} {r.text}")

r = client.delete("/auth/pin", headers=auth(access_token))
check("turning it off twice is harmless", r.status_code == 200, f"got {r.status_code}")

r = client.get("/auth/pin/status", headers=auth(access_token))
check("status agrees the PIN is gone", r.json()["pin_set"] is False, r.text)
check("...and the timestamp is cleared", r.json().get("pin_set_at") is None, r.text)

# ===========================================================================
section("9. Nothing about the password path changed")
# ===========================================================================

clear_limiters(username, user_id)
r = client.post("/auth/login", json={"username": username, "password": PASSWORD})
check("a login that never mentions the PIN still works", r.status_code == 200,
      f"got {r.status_code} {r.text}")
body = r.json()
check("...and gets no device token", body.get("device_token") is None, r.text)
check("...and still gets a refresh token", bool(body.get("refresh_token")), r.text)

clear_limiters(username, user_id)
r = client.post("/auth/login", json={"username": username, "password": "wrong"})
check("a wrong password is still refused", r.status_code == 401, f"got {r.status_code}")

clear_limiters(username, user_id)
r = client.post("/auth/refresh", json={"refresh_token": body["refresh_token"]})
check("refresh still works", r.status_code == 200, f"got {r.status_code} {r.text}")

# The refresh path must not have become a way to skip the PIN: a refresh token
# is issued at password login and is a credential in its own right, so it is
# only ever stored by the mobile client, never by the browser that uses a PIN.
check("refresh returns an access token as before",
      bool(r.json().get("access_token")), r.text)

# ===========================================================================
section("10. The PIN and its hash never leave the server")
# ===========================================================================

clear_limiters(username, user_id)
client.post("/auth/pin/set", json={"pin": "4917", "password": PASSWORD},
            headers=auth(access_token))

bodies = {
    "login": client.post("/auth/login", json={
        "username": username, "password": PASSWORD, "remember_device": True}).text,
    "pin/status": client.get("/auth/pin/status", headers=auth(access_token)).text,
    "profile/me": client.get("/profile/me", headers=auth(access_token)).text,
}
clear_limiters(username, user_id)
bodies["pin/unlock"] = client.post(
    "/auth/pin/unlock", json={"device_token": device_token, "pin": "4917"}).text

for name, text in bodies.items():
    check(f"{name} leaks no hash", "pin_hash" not in text, text[:200])
    check(f"{name} leaks no PIN", "4917" not in text, text[:200])
    check(f"{name} leaks no bcrypt hash", "$2b$" not in text, text[:200])

# ===========================================================================
section("11. The database change is the approved one")
# ===========================================================================

from sqlalchemy import inspect as sa_inspect  # noqa: E402

cols = {c["name"]: c for c in sa_inspect(engine).get_columns("users")}
check("users.pin_hash exists", "pin_hash" in cols)
check("users.pin_set_at exists", "pin_set_at" in cols)
check("pin_hash is nullable — every existing account has no PIN",
      cols.get("pin_hash", {}).get("nullable") is True, str(cols.get("pin_hash")))
check("pin_set_at is nullable",
      cols.get("pin_set_at", {}).get("nullable") is True, str(cols.get("pin_set_at")))

tables = set(sa_inspect(engine).get_table_names())
check("no device_pins table was created", "device_pins" not in tables, str(sorted(tables)))

migration = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "alembic", "versions", "c5d8f1a4b209_add_user_pin_columns.py",
)
check("the migration exists", os.path.exists(migration), migration)
if os.path.exists(migration):
    src = open(migration, encoding="utf-8").read()
    check("it only adds columns — no create_table, no drop, no alter",
          "create_table" not in src and "drop_table" not in src
          and "alter_column" not in src,
          "migration does more than add the two columns")
    check("it adds exactly the two approved columns",
          src.count("op.add_column") == 2, f"add_column count={src.count('op.add_column')}")

# ===========================================================================
section("12. The client never stores the PIN")
# ===========================================================================
# The rule is a property of the frontend source, so it is checked against the
# frontend source: a grep is the honest test here, and it fails loudly the day
# someone adds a convenient localStorage cache.

WEB = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "twin-app")
pin_files = ["js/pin.js", "js/pin-gate.js", "js/unlock.js", "js/auth.js", "js/account.js"]

for rel in pin_files:
    path = os.path.join(WEB, rel)
    if not os.path.exists(path):
        check(f"{rel} exists", False, path)
        continue
    src = open(path, encoding="utf-8").read()

    # Any storage write whose key mentions a PIN, in either storage.
    import re
    writes = re.findall(r"(?:local|session)Storage\.setItem\(\s*['\"]([^'\"]+)['\"]", src)
    offenders = [k for k in writes if "pin" in k.lower()]
    check(f"{rel} writes no PIN-keyed storage entry", not offenders, str(offenders))

    check(f"{rel} never logs a pin variable",
          not re.search(r"console\.(log|warn|error|info)\([^)]*\bpin\b", src, re.I),
          "a console call mentions pin")

    check(f"{rel} stores no pin_hash", "pin_hash" not in src)

# The device token IS stored, deliberately, and only under its own key.
src = open(os.path.join(WEB, "js/pin.js"), encoding="utf-8").read()
check("pin.js stores the device record under one known key",
      "moneykal_device" in src)

# ===========================================================================
print("\n" + "=" * 60)
print(f"{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    print("\nFailures:")
    for name in FAILED:
        print(f"  - {name}")
print("=" * 60)

try:
    os.remove(_TEST_DB)
except OSError:
    pass

sys.exit(1 if FAILED else 0)
