"""Outbound phone call (Varta over the telephone, via Omnidim) - end to end.

Runs the real FastAPI app in-process against a throwaway SQLite file. No
Omnidim account and no network access are needed, and no real call can be
placed: the API key is blanked before the backend is imported and the HTTP
dispatch itself is replaced with a recorder.

What this pins down, beyond "does it return 200":

  * The destination is ALWAYS the caller's own saved number. A client-supplied
    number is ignored, because the assistant reads the caller's balances,
    transactions and upcoming bills aloud, so an attacker-chosen destination
    would be a data-exfiltration route.
  * There is no fallback number. A user with no phone gets a clear 400 rather
    than having their finances read out to some default handset.
  * A call costs the same free allowance as Tathya and Varta, so it cannot be
    an unlimited billable feature for SEE users.
  * A call that fails does not consume the allowance.

Run with:  python tests/test_voice_call.py
"""
import os
import re
import sys
import tempfile
import uuid

# --- Before importing the backend ------------------------------------------
# omnidim_service calls load_dotenv(backend/.env), which on a developer machine
# holds a REAL Omnidim key. load_dotenv does not override variables that are
# already set, so blanking these here guarantees the module reads an empty key
# and no test run can dial a real telephone.
os.environ["OMNIDIM_API_KEY"] = ""
os.environ["OMNIDIM_AGENT_ID"] = ""
os.environ["OMNIDIM_FROM_NUMBER_ID"] = ""
os.environ["ALERT_PHONE_NUMBER"] = ""

_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_voicecall_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from backend.core.config import pricing_config as pricing  # noqa: E402
from backend.database import Base, SessionLocal, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402
from backend.main import app  # noqa: E402
from backend.models.domain import Profile, VoiceCallLog  # noqa: E402
from backend.services import omnidim_service  # noqa: E402

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
        print(f"  FAIL  {label}  {detail}")


def section(name):
    print("\n" + "=" * 70 + "\n" + name + "\n" + "=" * 70)


def register(phone=None):
    email = f"u_{uuid.uuid4().hex[:10]}@moneykal.test"
    res = client.post("/auth/register", json={"username": email, "password": "Password123!"})
    assert res.status_code == 200, res.text
    body = res.json()
    s = SessionLocal()
    s.add(Profile(user_id=body["user_id"], key="individual", label="Individual",
                  raw_inputs={"full_name": "Test"}, whatsapp_phone=phone))
    s.commit()
    s.close()
    return body["user_id"], {"Authorization": f"Bearer {body['access_token']}"}


# --- Fake dispatcher --------------------------------------------------------
DISPATCHED = []


class _FakeResponse:
    status_code = 200
    text = '{"requestId": "req_test_1"}'

    @staticmethod
    def json():
        return {"requestId": "req_test_1"}


def _fake_post(url, json=None, headers=None, timeout=None):
    DISPATCHED.append(json)
    return _FakeResponse()


def _failing_post(url, json=None, headers=None, timeout=None):
    class R:
        status_code = 500
        text = "upstream exploded"

        @staticmethod
        def json():
            return {}
    return R()


def configure_provider(enabled=True):
    """Turn the provider on/off the way the environment would."""
    omnidim_service.OMNIDIM_API_KEY = "test_key" if enabled else ""
    omnidim_service.OMNIDIM_AGENT_ID = "test_agent_id" if enabled else ""
    omnidim_service.OMNIDIM_FROM_NUMBER_ID = "test_from_number_id" if enabled else ""


# ===========================================================================
section("Authentication")

configure_provider(True)
omnidim_service.httpx.post = _fake_post

r = client.post("/voice/omnidim/call", json={})
check("Unauthenticated call is refused", r.status_code == 401, f"got {r.status_code}")

r = client.post("/voice/omnidim/call", json={},
                headers={"Authorization": "Bearer not-a-real-token"})
check("Forged bearer token is refused", r.status_code == 401, f"got {r.status_code}")


# ===========================================================================
section("No phone number on the profile")

_, no_phone = register(phone=None)
DISPATCHED.clear()
r = client.post("/voice/omnidim/call", json={}, headers=no_phone)
check("User with no phone gets 400, not a call", r.status_code == 400, f"got {r.status_code}")
check("Error identifies the missing number",
      (r.json().get("detail") or {}).get("error") == "no_phone_number", r.text[:120])
check("Nothing was dispatched", len(DISPATCHED) == 0, f"{len(DISPATCHED)} dispatched")


# ===========================================================================
section("Destination is always the caller's own number")

_, owner = register(phone="+919000000001")
DISPATCHED.clear()
r = client.post("/voice/omnidim/call",
                json={"phone": "+919999999999", "reason": "attacker supplied"},
                headers=owner)
check("Call succeeds for a user with a phone", r.status_code == 200, r.text[:160])
check("Exactly one dispatch", len(DISPATCHED) == 1, f"{len(DISPATCHED)}")
if DISPATCHED:
    to = DISPATCHED[0].get("to_number")
    check("Client-supplied number is IGNORED", to != "+919999999999", f"dialled {to}")
    check("Caller's own number is dialled", to == "+919000000001", f"dialled {to}")
    check("Caller-supplied reason is honoured",
          DISPATCHED[0]["variables"].get("alert_reason") == "attacker supplied",
          str(DISPATCHED[0]["variables"].get("alert_reason")))


# ===========================================================================
section("Call is logged and attributed to the profile")

s = SessionLocal()
logs = s.query(VoiceCallLog).all()
check("A VoiceCallLog row was written", len(logs) >= 1, f"{len(logs)} rows")
if logs:
    row = logs[-1]
    check("Log is attached to a profile (not orphaned)", row.profile_id is not None)
    check("Log records the provider", row.provider == "omnidim", str(row.provider))
    check("Log records an outbound call", row.call_type == "outbound", str(row.call_type))
s.close()


# ===========================================================================
section("Free-tier allowance")

limit = pricing.FREE_QUOTAS["ask_twin"]["limit"]
_, quota_user = register(phone="+919000000002")
DISPATCHED.clear()
codes = []
for _ in range(limit + 2):
    codes.append(client.post("/voice/omnidim/call", json={}, headers=quota_user).status_code)

check(f"First {limit} calls are allowed", codes[:limit] == [200] * limit, str(codes))
check("Calls past the free allowance are refused with 402",
      all(c == 402 for c in codes[limit:]), str(codes[limit:]))
check("No dispatch happens after the allowance is spent",
      len(DISPATCHED) == limit, f"{len(DISPATCHED)} dispatched for a limit of {limit}")


# ===========================================================================
section("A failed call does not consume allowance")

_, fail_user = register(phone="+919000000003")
omnidim_service.httpx.post = _failing_post


def used_of(payload):
    for row in (payload.get("allowances") or payload.get("usage") or []):
        if row.get("feature") == "ask_twin" or row.get("key") == "ask_twin":
            return row.get("used")
    return None


before = client.get("/billing/me", headers=fail_user).json()
r = client.post("/voice/omnidim/call", json={}, headers=fail_user)
after = client.get("/billing/me", headers=fail_user).json()

check("Provider failure is reported, not raised",
      r.status_code == 200 and r.json().get("success") is False, r.text[:160])
check("A failed call did not spend the allowance",
      used_of(before) == used_of(after), f"{used_of(before)} -> {used_of(after)}")

omnidim_service.httpx.post = _fake_post


# ===========================================================================
section("Provider not configured")

configure_provider(False)
_, unconf = register(phone="+919000000004")
r = client.post("/voice/omnidim/call", json={}, headers=unconf)
check("Unconfigured provider returns 503", r.status_code == 503, f"got {r.status_code}")
check("Error identifies the configuration gap",
      (r.json().get("detail") or {}).get("error") == "voice_not_configured", r.text[:120])

r = client.get("/voice/status", headers=unconf)
check("/voice/status reports calling as unavailable",
      r.status_code == 200 and r.json().get("calling_enabled") is False, r.text[:120])

configure_provider(True)
r = client.get("/voice/status", headers=unconf)
check("/voice/status reports calling as available once configured",
      r.json().get("calling_enabled") is True, r.text[:120])
check("/voice/status reports whether a phone is saved",
      r.json().get("has_phone") is True, r.text[:120])


# ===========================================================================
section("No hardcoded number anywhere in the call path")

# Matched by SHAPE rather than by value. Asserting against one specific number
# would only catch that number, and would put a real personal phone number into
# the repository to do it. This catches any E.164-looking literal.
PHONE_LITERAL = re.compile(r"""['"]\+?\d{10,15}['"]""")

for mod in ("backend/services/omnidim_service.py", "backend/routers/voice.py"):
    src = open(mod, encoding="utf-8").read()
    found = PHONE_LITERAL.findall(src)
    check(f"{os.path.basename(mod)} contains no hardcoded phone number",
          not found, f"found {found}")

check("omnidim_service has no ALERT_PHONE_NUMBER fallback in dispatch",
      "to_phone or ALERT_PHONE_NUMBER" not in
      open("backend/services/omnidim_service.py", encoding="utf-8").read())


# ===========================================================================
print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(1)
