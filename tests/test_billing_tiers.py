"""
Plans & Billing, step 1 — tiers, subscription status, usage and services.

Runs the real FastAPI app in-process against a throwaway SQLite file, like
tests/test_split_feature.py. Plan rows are inserted directly because checkout
does not exist yet; everything read back goes through the HTTP layer.

Run with:  python tests/test_billing_tiers.py
"""
import importlib.util
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta

_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_billing_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import Base, SessionLocal, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402
from backend.main import app  # noqa: E402
from backend.models.domain import (  # noqa: E402
    Profile, ServiceEntitlement, Subscription, UsageCounter, User,
)
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


def register(profile_key=None):
    email = f"u_{uuid.uuid4().hex[:10]}@moneykal.test"
    res = client.post("/auth/register", json={"username": email, "password": "Password123!"})
    assert res.status_code == 200, res.text
    body = res.json()
    if profile_key:
        s = SessionLocal()
        s.add(Profile(user_id=body["user_id"], key=profile_key, label=profile_key.title()))
        s.commit()
        s.close()
    return body["user_id"], {"Authorization": f"Bearer {body['access_token']}"}


def me(headers):
    res = client.get("/billing/me", headers=headers)
    assert res.status_code == 200, res.text
    return res.json()


def add(row):
    s = SessionLocal()
    s.add(row)
    s.commit()
    s.close()


def services_by_year(state):
    return {x["subject_ref"]: x["access"] for x in state["services"] if x["sku"] == "tax_calculator"}


# ===========================================================================
section("1. A new account is on SEE and nothing is broken")
# ===========================================================================

check("Billing requires sign-in", client.get("/billing/me").status_code == 401)

uid, h = register()
state = me(h)
check("Tier is SEE", state["tier"] == "see", state)
check("Subscription status is none", state["subscription_status"] == "none", state)
check("No plan period", state["plan"]["expires_at"] is None and state["plan"]["sku"] is None)
check("Tathya & Varta allowance is 10", state["quotas"]["ask_twin"]["limit"] == 10)
check("Simulation allowance is 3", state["quotas"]["simulations"]["limit"] == 3)
check("Nothing used yet", state["quotas"]["ask_twin"]["used"] == 0)
check("No profile means no services offered", state["services"] == [])


# ===========================================================================
section("2. Individual: prices and the Tax Calculator")
# ===========================================================================

ind_id, ind = register("individual")
cat = client.get("/billing/catalog", headers=ind).json()
passes = {p["sku"]: p for p in cat["tiers"]["act"]["passes"]}
check("ACT Monthly is ₹199 for 30 days",
      passes["act_monthly"]["price_minor"] == 19900 and passes["act_monthly"]["duration_days"] == 30)
check("ACT Yearly is ₹1,499 for 365 days",
      passes["act_yearly"]["price_minor"] == 149900 and passes["act_yearly"]["duration_days"] == 365)
tax = next((x for x in cat["services"] if x["sku"] == "tax_calculator"), None)
check("Tax Calculator is offered to an Individual", tax is not None, cat["services"])
check("Tax Calculator is ₹200", tax and tax["price_minor"] == 20000)
check("Tax Calculator is sold per tax year", tax and "FY2026-27" in tax["subjects"])
check("ACT lists the Tax Calculator as included",
      any(f["key"] == "tax_calculator" for f in cat["tiers"]["act"]["features"]))

years = services_by_year(me(ind))
check("Every tax year starts locked", years and set(years.values()) == {"locked"}, years)

# A custom_<username> key is an Individual too, as in backend/routers/tax.py.
_, custom = register(f"custom_{uuid.uuid4().hex[:6]}")
check("custom_ profiles are Individuals",
      any(x["sku"] == "tax_calculator" for x in client.get("/billing/catalog", headers=custom).json()["services"]))


# ===========================================================================
section("3. Startup: persona boundary")
# ===========================================================================

_, st = register("startup")
st_cat = client.get("/billing/catalog", headers=st).json()
check("Startup is offered ACT", len(st_cat["tiers"]["act"]["passes"]) == 2)
check("Startup is not offered the Tax Calculator", st_cat["services"] == [], st_cat["services"])
check("Startup's ACT list does not advertise the Tax Calculator",
      all(f["key"] != "tax_calculator" for f in st_cat["tiers"]["act"]["features"]))
check("Startup's billing state has no services", me(st)["services"] == [])


# ===========================================================================
section("4. Usage counts only the current month")
# ===========================================================================

period = billing_service.current_period()
add(UsageCounter(user_id=ind_id, feature_key="ask_twin", period=period, count=4))
add(UsageCounter(user_id=ind_id, feature_key="ask_twin", period="2000-01", count=9))
q = me(ind)["quotas"]["ask_twin"]
check("Used this month is 4", q["used"] == 4, q)
check("Remaining is 6", q["remaining"] == 6, q)
check("Reset date is the first of next month", q["resets_on"].endswith("-01"), q)


# ===========================================================================
section("5. A purchased tax year")
# ===========================================================================

add(ServiceEntitlement(user_id=ind_id, sku="tax_calculator", subject_ref="FY2025-26"))
years = services_by_year(me(ind))
check("The bought year is purchased", years["FY2025-26"] == "purchased", years)
check("Other years stay locked", years["FY2026-27"] == "locked", years)
s = SessionLocal()
check("has_service agrees for the bought year",
      billing_service.has_service(s, ind_id, "tax_calculator", "FY2025-26") is True)
check("has_service agrees for another year",
      billing_service.has_service(s, ind_id, "tax_calculator", "FY2026-27") is False)
s.close()


# ===========================================================================
section("6. ACT: active, expired, cancelled")
# ===========================================================================

add(Subscription(user_id=ind_id, plan="premium", status="active", source="demo",
                 billing_cycle="yearly", expires_at=datetime.utcnow() + timedelta(days=365)))
state = me(ind)
check("Tier is ACT", state["tier"] == "act", state)
check("Status is active", state["subscription_status"] == "active")
check("Plan reports the yearly pass", state["plan"]["sku"] == "act_yearly", state["plan"])
check("365 days left", state["plan"]["days_left"] == 365, state["plan"])
check("Allowances are unlimited",
      state["quotas"]["ask_twin"]["unlimited"] and state["quotas"]["ask_twin"]["limit"] is None)
years = services_by_year(state)
check("ACT includes unbought tax years", years["FY2026-27"] == "included_in_act", years)
check("A bought year still shows as purchased", years["FY2025-26"] == "purchased", years)
check("Split sees the same plan",
      client.get("/split/entitlements", headers=ind).json()["is_premium"] is True)

s = SessionLocal()
sub = s.query(Subscription).filter(Subscription.user_id == ind_id).first()
sub.expires_at = datetime.utcnow() - timedelta(minutes=1)
s.commit()
s.close()
state = me(ind)
check("An expired pass drops to SEE", state["tier"] == "see", state)
check("Status is expired", state["subscription_status"] == "expired")
check("Expired pass shows 0 days left", state["plan"]["days_left"] == 0, state["plan"])
check("Tax year no longer included", services_by_year(state)["FY2026-27"] == "locked")
check("A bought year survives expiry", services_by_year(state)["FY2025-26"] == "purchased")
check("Split sees the expiry too",
      client.get("/split/entitlements", headers=ind).json()["is_premium"] is False)

s = SessionLocal()
sub = s.query(Subscription).filter(Subscription.user_id == ind_id).first()
sub.expires_at = datetime.utcnow() + timedelta(days=3)
sub.status = "cancelled"
s.commit()
s.close()
check("Status reports cancelled", me(ind)["subscription_status"] == "cancelled")

check("A free-plan row is still status none",
      (add(Subscription(user_id=uid, plan="free", status="active")) or True)
      and me(h)["subscription_status"] == "none")


# ===========================================================================
section("7. Migration d8a2f6c41b93 upgrades and downgrades")
# ===========================================================================

import sqlalchemy as sa  # noqa: E402
from alembic.operations import Operations  # noqa: E402
from alembic.runtime.migration import MigrationContext  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "mig", os.path.join(ROOT, "alembic", "versions", "d8a2f6c41b93_add_billing_tiers.py"))
mig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mig)

mig_db = os.path.join(tempfile.gettempdir(), f"moneykal_billing_mig_{uuid.uuid4().hex[:8]}.db")
mig_engine = sa.create_engine(f"sqlite:///{mig_db}")
with mig_engine.begin() as conn:
    conn.execute(sa.text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR)"))
    conn.execute(sa.text(
        "CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, user_id INTEGER, plan VARCHAR)"))
    conn.execute(sa.text("INSERT INTO subscriptions (user_id, plan) VALUES (1, 'premium')"))

    with Operations.context(MigrationContext.configure(conn)):
        mig.upgrade()
    insp = sa.inspect(conn)
    check("Upgrade creates the three tables",
          {"billing_orders", "service_entitlements", "usage_counters"} <= set(insp.get_table_names()))
    check("Upgrade adds subscriptions.billing_cycle",
          "billing_cycle" in {c["name"] for c in insp.get_columns("subscriptions")})
    check("Existing subscription rows survive",
          conn.execute(sa.text("SELECT plan FROM subscriptions")).scalar() == "premium")

    with Operations.context(MigrationContext.configure(conn)):
        mig.upgrade()
    check("Upgrade is safe to re-run", True)

    with Operations.context(MigrationContext.configure(conn)):
        mig.downgrade()
    insp = sa.inspect(conn)
    check("Downgrade removes the tables",
          not ({"billing_orders", "service_entitlements", "usage_counters"} & set(insp.get_table_names())))
    check("Downgrade removes billing_cycle",
          "billing_cycle" not in {c["name"] for c in insp.get_columns("subscriptions")})
mig_engine.dispose()


# ===========================================================================
print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(1)
