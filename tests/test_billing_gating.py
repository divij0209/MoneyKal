"""
Plans & Billing, step 3 — feature gating.

Runs the real FastAPI app in-process against a throwaway SQLite file, like the
other tests here. The AI calls behind Tathya and Simulate are replaced with
stubs, so the test measures the gate and not a language model, and spends no
API quota.

Checks the rule the whole model rests on as much as the gates: seeing is free.
A SEE user who has used every allowance can still open every screen.

Run with:  python tests/test_billing_gating.py
"""
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta

_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_gating_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import Base, SessionLocal, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402
from backend.main import app  # noqa: E402
from backend.models.domain import GmailConnection, Profile, Subscription, UsageCounter  # noqa: E402
from backend.routers import twin as twin_router  # noqa: E402
from backend.routers import voice as voice_router  # noqa: E402
from backend.routers.whatsapp import _whatsapp_locked  # noqa: E402
from backend.scheduler import _gmail_sync_allowed  # noqa: E402
from backend.schemas.api_models import ChatResponse, ScenarioSimulateResponse  # noqa: E402
from backend.services import billing_service  # noqa: E402

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
    print(f"\n{'=' * 70}\n{name}\n{'=' * 70}")


# ---- stubs for the AI calls ----
AI_CALLS = {"chat": 0, "simulate": 0}


def fake_discovery_turn(profile, message, chat_history, session_id, db):
    AI_CALLS["chat"] += 1
    return ChatResponse(session_id=session_id, answer="Stub answer", confidence="high",
                        sources=[], reasoning_trace=[], disclaimer="")


def fake_simulation(profile, scenario, decision_context=None):
    AI_CALLS["simulate"] += 1
    return ScenarioSimulateResponse(
        scenario=scenario, scenario_type="general", parsed_params={}, stages=[],
        financial_impact={}, timeline=[], recommendation="Stub recommendation", why="",
        risks=[], assumptions=[], teaching="", disclaimer="")


twin_router.run_discovery_turn = fake_discovery_turn
twin_router.orchestrator.run_scenario_simulation = fake_simulation
voice_router.vapi.voice_enabled = lambda: False


def register(profile_key="individual"):
    email = f"u_{uuid.uuid4().hex[:10]}@moneykal.test"
    res = client.post("/auth/register", json={"username": email, "password": "Password123!"})
    assert res.status_code == 200, res.text
    body = res.json()
    s = SessionLocal()
    profile = Profile(user_id=body["user_id"], key=profile_key, label=profile_key.title())
    s.add(profile)
    s.commit()
    pid = profile.id
    s.close()
    return body["user_id"], pid, body["access_token"], {"Authorization": f"Bearer {body['access_token']}"}


def grant_act(user_id):
    s = SessionLocal()
    s.add(Subscription(user_id=user_id, plan="premium", status="active", source="demo",
                       billing_cycle="monthly", expires_at=datetime.utcnow() + timedelta(days=30)))
    s.commit()
    s.close()


def set_used(user_id, key, count):
    """Set this month's count, whether or not a real use already created the row."""
    s = SessionLocal()
    period = billing_service.current_period()
    row = s.query(UsageCounter).filter(UsageCounter.user_id == user_id, UsageCounter.feature_key == key,
                                       UsageCounter.period == period).first()
    if row:
        row.count = count
    else:
        s.add(UsageCounter(user_id=user_id, feature_key=key, period=period, count=count))
    s.commit()
    s.close()


def used(headers, key):
    return client.get("/billing/me", headers=headers).json()["quotas"][key]["used"]


def chat(headers):
    return client.post("/twin/chat", headers=headers, json={"message": "Can I afford a new phone?"})


def simulate(headers):
    return client.post("/twin/simulate-scenario", headers=headers, json={"scenario": "Buy a car for 8 lakh"})


# ===========================================================================
section("1. Tathya: 10 free questions a month")
# ===========================================================================

uid, pid, token, h = register()
res = chat(h)
check("A free question is answered", res.status_code == 200, res.text)
check("It is counted", used(h, "ask_twin") == 1)

set_used(uid, "ask_twin", 9)
check("The 10th question is still answered", chat(h).status_code == 200)
check("Count reaches 10", used(h, "ask_twin") == 10)

calls_before = AI_CALLS["chat"]
res = chat(h)
check("The 11th question is refused (402)", res.status_code == 402, res.text)
detail = res.json()["detail"]
check("Refusal says quota_exceeded", detail["error"] == "quota_exceeded" and detail["feature"] == "ask_twin", detail)
check("Refusal carries the limit and reset date", detail["limit"] == 10 and detail["resets_on"].endswith("-01"), detail)
check("A refused question never reaches the AI", AI_CALLS["chat"] == calls_before)
check("A refused question is not counted", used(h, "ask_twin") == 10)

grant_act(uid)
check("On ACT the same user is answered again", chat(h).status_code == 200)
check("ACT usage is still counted, never limited", used(h, "ask_twin") == 11)


# ===========================================================================
section("2. Varta shares the allowance")
# ===========================================================================

vid, _, _, vh = register()
set_used(vid, "ask_twin", 10)
res = client.post("/voice/session", headers=vh)
check("Varta is refused once questions are used up (402)", res.status_code == 402, res.text)
check("Varta uses the ask_twin allowance", res.json()["detail"]["feature"] == "ask_twin")

v2, _, _, v2h = register()
res = client.post("/voice/session", headers=v2h)
check("Under the limit, Varta passes the gate (voice not configured here: 503)", res.status_code == 503, res.text)
check("A call that never started is not counted", used(v2h, "ask_twin") == 0)


# ===========================================================================
section("3. Simulate: 3 free simulations a month")
# ===========================================================================

sid, _, _, sh = register()
for i in range(3):
    check(f"Simulation {i + 1} runs", simulate(sh).status_code == 200)
check("Three are counted", used(sh, "simulations") == 3)
res = simulate(sh)
check("The 4th is refused (402)", res.status_code == 402, res.text)
check("Refusal names simulations", res.json()["detail"]["feature"] == "simulations")
check("Past simulations are still listed", client.get("/twin/simulations", headers=sh).status_code == 200)
check("Questions and simulations are separate allowances", chat(sh).status_code == 200)


# ===========================================================================
section("4. ACT-only actions: auto-sweep and Gmail")
# ===========================================================================

aid, apid, atoken, ah = register()
res = client.post("/live-life/sweep", headers=ah)
check("Auto-sweep is refused on SEE (402)", res.status_code == 402, res.text)
check("Refusal says upgrade_required", res.json()["detail"]["error"] == "upgrade_required")

res = client.post("/gmail/sync-now", headers=ah)
check("Gmail sync is refused on SEE (402)", res.status_code == 402, res.text)
check("Gmail refusal names gmail_ingest", res.json()["detail"]["feature"] == "gmail_ingest")
check("Mobile Gmail ticket is refused on SEE (402)",
      client.post("/gmail/oauth-ticket", headers=ah).status_code == 402)
res = client.get(f"/gmail/auth?token={atoken}", follow_redirects=False)
check("Web Gmail connect sends the user back with a reason, not raw JSON",
      res.status_code in (302, 307) and "upgrade_required" in res.headers.get("location", ""),
      f"{res.status_code} {res.headers.get('location')}")
check("Gmail status stays visible on SEE", client.get("/gmail/status", headers=ah).status_code == 200)

s = SessionLocal()
conn = GmailConnection(profile_id=apid, email_address="a@example.com", is_active=True)
s.add(conn)
s.commit()
check("The hourly Gmail import skips a SEE user", _gmail_sync_allowed(s, conn) is False)
s.close()

grant_act(aid)
res = client.post("/live-life/sweep", headers=ah)
check("On ACT, auto-sweep runs", res.status_code == 200, res.text)
res = client.post("/gmail/sync-now", headers=ah)
check("On ACT, Gmail sync passes the gate", res.status_code != 402, res.text)
res = client.get(f"/gmail/auth?token={atoken}", follow_redirects=False)
check("On ACT, Gmail connect is not turned away",
      "upgrade_required" not in res.headers.get("location", ""), res.headers.get("location"))
s = SessionLocal()
conn = s.query(GmailConnection).filter(GmailConnection.profile_id == apid).first()
check("The hourly Gmail import runs for an ACT user", _gmail_sync_allowed(s, conn) is True)
s.close()


# ===========================================================================
section("5. WhatsApp logging")
# ===========================================================================

wid, wpid, _, _ = register()
s = SessionLocal()
s.query(Profile).filter(Profile.id == wpid).update({"whatsapp_phone": "919800000001"})
s.commit()
check("A linked SEE number is locked", _whatsapp_locked(s, "919800000001") is True)
check("An unlinked number is left to the existing reply", _whatsapp_locked(s, "919800000999") is False)
s.close()
grant_act(wid)
s = SessionLocal()
check("A linked ACT number is not locked", _whatsapp_locked(s, "919800000001") is False)
s.close()


# ===========================================================================
section("6. Tax Calculator: results wait for the tax year to be unlocked")
# ===========================================================================

tid, _, _, th = register()
payload = {"taxpayer": {"tax_year": "FY2026-27", "age": 30}}

res = client.post("/tax/collect", headers=th, json=payload)
check("Results are refused for a locked year (402)", res.status_code == 402, res.text)
d = res.json()["detail"]
check("Refusal is purchase_required for that year",
      d["error"] == "purchase_required" and d["sku"] == "tax_calculator" and d["subject_ref"] == "FY2026-27", d)
check("Refusal carries the price and that ACT includes it", d["price_minor"] == 20000 and d["included_in_act"] is True)
check("The tax form's configuration stays open", client.get("/tax/config", headers=th).status_code == 200)

res = client.put("/tax/profile?tax_year=FY2026-27", headers=th, json=payload)
check("Inputs can still be saved on a locked year", res.status_code == 200, res.text)
check("Saving a locked year returns no result", res.json()["result"] is None and res.json()["locked"] is True)
res = client.get("/tax/profile?tax_year=FY2026-27", headers=th).json()
check("Saved inputs come back", res["exists"] is True and res["inputs"]["taxpayer"]["tax_year"] == "FY2026-27")
check("The cached result is withheld while locked", res["last_result"] is None and res["locked"] is True)

order = client.post("/billing/orders", headers=th, json={"sku": "tax_calculator", "subject_ref": "FY2026-27"}).json()
client.post(f"/billing/orders/{order['id']}/pay", headers=th, json={"payment_method": "upi_qr"})
res = client.post("/tax/collect", headers=th, json=payload)
check("After buying the year, results are returned", res.status_code == 200, res.text)
check("The result is for that year", res.json()["tax_year"] == "FY2026-27")
res = client.get("/tax/profile?tax_year=FY2026-27", headers=th).json()
check("The saved result is shown once unlocked", res["last_result"] is not None and res["locked"] is False)
res = client.post("/tax/collect", headers=th, json={"taxpayer": {"tax_year": "FY2025-26", "age": 30}})
check("Another year stays locked (402)", res.status_code == 402, res.text)

grant_act(tid)
res = client.post("/tax/collect", headers=th, json={"taxpayer": {"tax_year": "FY2025-26", "age": 30}})
check("ACT unlocks every year", res.status_code == 200, res.text)

_, _, _, st = register("startup")
res = client.post("/tax/collect", headers=st, json=payload)
check("Startup still gets the persona refusal (403), not a sales pitch", res.status_code == 403, res.text)


# ===========================================================================
section("7. Seeing is free — a SEE user with every allowance used")
# ===========================================================================

fid, _, _, fh = register()
set_used(fid, "ask_twin", 10)
set_used(fid, "simulations", 3)
for path in ["/billing/me", "/billing/catalog", "/twin/chats", "/twin/simulations",
             "/gmail/status", "/tax/config", "/split/me", "/notifications/unread-count"]:
    res = client.get(path, headers=fh)
    check(f"GET {path} still opens", res.status_code == 200, f"{res.status_code} {res.text[:120]}")
res = client.get("/home", headers=fh)
check("The Overview (GET /home) still opens", res.status_code == 200, f"{res.status_code} {res.text[:160]}")


# ===========================================================================
print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(1)
