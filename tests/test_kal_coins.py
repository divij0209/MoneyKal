"""
Plans & Billing, step 4 — Kal Coins.

Runs the real FastAPI app in-process against a throwaway SQLite file, like the
other tests here. Time-based rules (a friend's 30 days) are tested by moving
the stored dates back rather than by waiting.

Beyond earning and spending, this checks the properties that keep coins a
reward rather than a payment instrument: balances never go negative, the
ledger always adds up to the balance, and no route exists that could move,
sell or cash out coins.

Run with:  python tests/test_kal_coins.py
"""
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta

_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_coins_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"
os.environ.pop("PAYMENT_MODE", None)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from backend.core.config import pricing_config as pricing  # noqa: E402
from backend.core.ratelimit import register_limiter  # noqa: E402
from backend.database import Base, SessionLocal, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402
from backend.main import app  # noqa: E402
from backend.models.domain import (  # noqa: E402
    CoinTransaction, Profile, SplitInvitation, StartupProfile, StartupTransaction, Subscription, User,
)
from backend.services import kal_coins_service  # noqa: E402

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


def register(email=None, profile_key="individual", onboarded=False):
    # /auth/register allows 10 accounts an hour per connection, and every
    # account in this file comes from the one TestClient address. This file is
    # about coins, not that limit, so the window is cleared before each signup.
    for key in ("ip:testclient", "ip:unknown"):
        register_limiter.reset(key)
    email = email or f"u_{uuid.uuid4().hex[:10]}@moneykal.test"
    res = client.post("/auth/register", json={"username": email, "password": "Password123!"})
    assert res.status_code == 200, res.text
    body = res.json()
    if profile_key:
        s = SessionLocal()
        p = Profile(user_id=body["user_id"], key=profile_key, label=profile_key.title(),
                    raw_inputs={"full_name": "Test"} if (onboarded and profile_key != "startup") else {})
        s.add(p)
        s.commit()
        if onboarded and profile_key == "startup":
            s.add(StartupProfile(profile_id=p.id, company_name="Test Co"))
            s.commit()
        s.close()
    return body["user_id"], {"Authorization": f"Bearer {body['access_token']}"}, email


def coins(headers):
    return client.get("/billing/coins", headers=headers).json()


def bal(headers):
    return client.get("/billing/me", headers=headers).json()["kal_coins"]["balance"]


def grant(user_id, amount):
    """Put coins on an account for a test, through the same ledger path as any reward."""
    s = SessionLocal()
    kal_coins_service._apply(s, user_id, amount, "earn", "test_grant", f"test:{uuid.uuid4().hex}")
    s.commit()
    s.close()


def order(headers, sku, subject_ref=None, use_coins=True):
    return client.post("/billing/orders", headers=headers,
                       json={"sku": sku, "subject_ref": subject_ref, "use_coins": use_coins})


def pay(headers, order_id, method="upi_qr"):
    return client.post(f"/billing/orders/{order_id}/pay", headers=headers, json={"payment_method": method})


def reconciled(user_id):
    s = SessionLocal()
    ok = kal_coins_service.balance(s, user_id) == kal_coins_service.ledger_balance(s, user_id)
    s.close()
    return ok


# ===========================================================================
section("1. A new account")
# ===========================================================================

uid, h, _ = register()
check("Starts with 0 coins", bal(h) == 0)
state = coins(h)
check("Coin value is ₹0.10", state["coin_value_minor"] == 10)
check("History is empty", state["history"] == [])
check("Individual sees three ways to earn",
      [r["key"] for r in state["rules"]] == ["profile_completed", "friend_invite", "act_yearly"], state["rules"])
check("Profile reward not yet earned (onboarding not filled)",
      state["rules"][0]["status"] == "available")

_, sh, _ = register(profile_key="startup")
check("Startup is not offered the invite reward (Money Splits is Individual-only)",
      [r["key"] for r in coins(sh)["rules"]] == ["profile_completed", "act_yearly"])


# ===========================================================================
section("2. Profile completed: +50, once")
# ===========================================================================

pid, ph, _ = register(onboarded=True)
check("Completing onboarding earns 50", bal(ph) == 50)
check("Reading again does not earn again", bal(ph) == 50 and coins(ph)["balance"] == 50)
state = coins(ph)
check("Shown as earned", state["rules"][0]["status"] == "earned")
check("One ledger row with the balance it produced",
      len(state["history"]) == 1 and state["history"][0]["coins"] == 50
      and state["history"][0]["balance_after"] == 50 and state["history"][0]["reason"] == "profile_completed",
      state["history"])
check("Ledger adds up to the balance", reconciled(pid))

_, soh, _ = register(profile_key="startup", onboarded=True)
check("A completed Startup profile also earns 50", bal(soh) == 50)


# ===========================================================================
section("3. Using coins at checkout")
# ===========================================================================

o = order(ph, "act_monthly").json()
check("Coins are applied by default", o["coins_redeemed"] == 50 and o["coin_discount_minor"] == 500, o)
check("Total drops by ₹5", o["payable_minor"] == 19400, o)
check("Quoting spends nothing yet", bal(ph) == 50)

r = client.post(f"/billing/orders/{o['id']}/coins", headers=ph, json={"use_coins": False}).json()
check("Coins can be turned off", r["coins_redeemed"] == 0 and r["payable_minor"] == 19900, r)
r = client.post(f"/billing/orders/{o['id']}/coins", headers=ph, json={"use_coins": True}).json()
check("And back on", r["coins_redeemed"] == 50 and r["payable_minor"] == 19400, r)

res = pay(ph, o["id"])
check("Payment succeeds", res.status_code == 200, res.text)
check("Coins are spent on payment", bal(ph) == 0)
hist = coins(ph)["history"]
check("Redemption is in the ledger as -50, balance 0",
      hist[0]["type"] == "redeem" and hist[0]["coins"] == -50 and hist[0]["balance_after"] == 0, hist)
check("Order history records coins used",
      client.get("/billing/orders", headers=ph).json()[0]["coins_redeemed"] == 50)
check("A paid order cannot change its coins (409)",
      client.post(f"/billing/orders/{o['id']}/coins", headers=ph, json={"use_coins": False}).status_code == 409)
check("Ledger adds up", reconciled(pid))

check("Ordering with coins off uses none",
      order(ph, "act_monthly", use_coins=False).json()["coins_redeemed"] == 0)


# ===========================================================================
section("4. Coins covering the whole price — never more")
# ===========================================================================

fid, fh, _ = register()
grant(fid, 3000)
t = order(fh, "tax_calculator", "FY2026-27").json()
check("₹200 needs 2,000 coins and uses exactly that", t["coins_redeemed"] == 2000, t)
check("Total is ₹0, never negative", t["payable_minor"] == 0, t)
res = pay(fh, t["id"], "")
check("A fully covered order needs no payment method", res.status_code == 200, res.text)
check("It is recorded as paid with coins", res.json()["order"]["payment_method"] == "coins")
check("Only 2,000 coins were spent", bal(fh) == 1000)

os.environ["PAYMENT_MODE"] = "razorpay"
t2 = order(fh, "tax_calculator", "FY2025-26").json()
check("Leftover 1,000 coins cover ₹100 of the next ₹200", t2["coins_redeemed"] == 1000 and t2["payable_minor"] == 10000)
grant(fid, 1000)
r = client.post(f"/billing/orders/{t2['id']}/coins", headers=fh, json={"use_coins": True}).json()
check("Re-pricing picks up new coins", r["payable_minor"] == 0, r)
res = pay(fh, t2["id"], "")
check("With no gateway connected, a fully covered order still completes", res.status_code == 200, res.text)
os.environ.pop("PAYMENT_MODE", None)
check("Balance is 0, not negative", bal(fh) == 0)
check("Ledger adds up", reconciled(fid))


# ===========================================================================
section("5. Spending the same coins twice")
# ===========================================================================

did, dh, _ = register()
grant(did, 50)
a = order(dh, "act_monthly").json()
b = order(dh, "act_monthly").json()
check("Both orders were priced with the same 50 coins", a["coins_redeemed"] == 50 and b["coins_redeemed"] == 50)
check("The first pays", pay(dh, a["id"]).status_code == 200)
res = pay(dh, b["id"])
check("The second is stopped (409 coins_changed)", res.status_code == 409 and res.json()["detail"]["error"] == "coins_changed", res.text)
check("It comes back re-priced at full price", res.json()["detail"]["order"]["payable_minor"] == 19900, res.text)
check("Balance never went below zero", bal(dh) == 0)
check("The stopped order was not granted or charged",
      len(client.get("/billing/orders", headers=dh).json()) == 1)
check("Paying the re-priced order now works", pay(dh, b["id"]).status_code == 200)
check("Ledger adds up", reconciled(did))


# ===========================================================================
section("6. ACT Yearly: +100")
# ===========================================================================

yid, yh, _ = register()
y = order(yh, "act_yearly").json()
pay(yh, y["id"], "upi_qr")
check("Buying ACT Yearly earns 100", bal(yh) == 100)
check("Counted once for that purchase", [r for r in coins(yh)["rules"] if r["key"] == "act_yearly"][0]["earned_count"] == 1)
pay(yh, y["id"], "upi_qr")
check("Paying the same order again earns nothing more", bal(yh) == 100)
m = order(yh, "act_monthly").json()
pay(yh, m["id"])
check("A monthly pass earns nothing (100 coins were spent on it)", bal(yh) == 0)
check("Ledger adds up", reconciled(yid))


# ===========================================================================
section("7. Invite a friend: +50 after 30 days of real use")
# ===========================================================================

iid, ih, _ = register()
client.get("/split/me", headers=ih)


def invite_and_join(inviter_headers):
    email = f"friend_{uuid.uuid4().hex[:8]}@moneykal.test"
    r = client.post("/split/invitations", headers=inviter_headers, json={"email": email, "name": "Friend"})
    assert r.status_code == 201, r.text
    friend_id, friend_h, _ = register(email=email)
    return friend_id, friend_h


def age(friend_id, days):
    """Move a friend's sign-up, and the invite before it, `days` into the past."""
    s = SessionLocal()
    u = s.query(User).filter(User.id == friend_id).first()
    u.created_at = datetime.utcnow() - timedelta(days=days)
    inv = s.query(SplitInvitation).filter(SplitInvitation.accepted_by_user_id == friend_id).first()
    inv.created_at = u.created_at - timedelta(hours=1)
    s.commit()
    s.close()


def activity(friend_id, days, per_day):
    s = SessionLocal()
    u = s.query(User).filter(User.id == friend_id).first()
    p = s.query(Profile).filter(Profile.user_id == friend_id).first()
    for d in range(days):
        for _ in range(per_day):
            s.add(StartupTransaction(profile_id=p.id, type="out", category="Food", amount=100,
                                     description="test", created_at=u.created_at + timedelta(days=d + 1)))
    s.commit()
    s.close()


f1, _ = invite_and_join(ih)
check("A friend who just joined is waiting", [r for r in coins(ih)["rules"] if r["key"] == "friend_invite"][0]["waiting_count"] == 1)
check("Nothing is credited before 30 days", bal(ih) == 0)

activity(f1, days=5, per_day=2)
age(f1, days=10)
check("Activity alone is not enough before 30 days", bal(ih) == 0)
age(f1, days=31)
activity(f1, days=0, per_day=0)
check("After 30 days with 5 active days and 10 entries, +50", bal(ih) == 50)
rule = [r for r in coins(ih)["rules"] if r["key"] == "friend_invite"][0]
check("Shown as earned, no longer waiting", rule["earned_count"] == 1 and rule["waiting_count"] == 0, rule)
check("Checking again does not pay twice", bal(ih) == 50)

f2, _ = invite_and_join(ih)
age(f2, days=40)
activity(f2, days=4, per_day=5)
check("4 active days is not enough, even with 20 entries", bal(ih) == 50)

f3, _ = invite_and_join(ih)
age(f3, days=40)
activity(f3, days=9, per_day=1)
check("9 entries is not enough, even over 9 days", bal(ih) == 50)

# Someone who already had an account when invited.
_, _, old_email = register()
s = SessionLocal()
old = s.query(User).filter(User.username == old_email).first()
old.created_at = datetime.utcnow() - timedelta(days=400)
old_id = old.id
s.commit()
s.close()
client.post("/split/invitations", headers=ih, json={"email": old_email, "name": "Old friend"})
activity(old_id, days=6, per_day=2)
check("An existing account invited later never earns", bal(ih) == 50)

s = SessionLocal()
s.query(User).filter(User.id == old_id).update({"created_at": None})
s.commit()
s.close()
check("An account with no known sign-up date never earns", bal(ih) == 50)

# Two people invite the same friend: only the first invitation counts.
jid, jh, _ = register()
client.get("/split/me", headers=jh)
shared_email = f"shared_{uuid.uuid4().hex[:8]}@moneykal.test"
client.post("/split/invitations", headers=ih, json={"email": shared_email, "name": "Shared"})
client.post("/split/invitations", headers=jh, json={"email": shared_email, "name": "Shared"})
sf, _, _ = register(email=shared_email)
s = SessionLocal()
u = s.query(User).filter(User.id == sf).first()
u.created_at = datetime.utcnow() - timedelta(days=35)
invs = s.query(SplitInvitation).filter(SplitInvitation.accepted_by_user_id == sf).order_by(SplitInvitation.id).all()
for i, inv in enumerate(invs):
    inv.created_at = u.created_at - timedelta(hours=2 - i)   # the first inviter's is earlier
s.commit()
s.close()
activity(sf, days=5, per_day=2)
check("The first inviter is credited", bal(ih) == 100)
check("The second inviter is not", bal(jh) == 0)

# Monthly limit.
saved_limit = pricing.COIN_RULES["friend_invite"]["monthly_limit"]
pricing.COIN_RULES["friend_invite"]["monthly_limit"] = 2
f4, _ = invite_and_join(ih)
age(f4, days=40)
activity(f4, days=5, per_day=2)
check("Past the monthly limit, a qualifying friend waits", bal(ih) == 100)
check("…and is still listed as waiting", [r for r in coins(ih)["rules"] if r["key"] == "friend_invite"][0]["waiting_count"] >= 1)
pricing.COIN_RULES["friend_invite"]["monthly_limit"] = saved_limit
check("Once the limit allows, that friend is credited", bal(ih) == 150)
check("Ledger adds up", reconciled(iid))

check("Friend progress never exposes a friend's own activity",
      not any(k in [r for r in coins(ih)["rules"] if r["key"] == "friend_invite"][0]
              for k in ("friends", "active_days", "entries")))


# ===========================================================================
section("8. Coins stay a reward, not a payment instrument")
# ===========================================================================

paths = {getattr(r, "path", "") for r in app.routes}
forbidden = ("transfer", "gift", "send", "withdraw", "cashout", "cash-out", "topup", "top-up", "redeem-cash", "buy-coins")
check("No route can send, gift, sell or cash out coins",
      not [p for p in paths if "coin" in p.lower() and any(w in p.lower() for w in forbidden)],
      sorted(p for p in paths if "coin" in p.lower()))
check("The coins endpoint is read-only", client.post("/billing/coins", headers=ih, json={}).status_code == 405)
check("Coins are not for sale", order(ih, "kal_coins").status_code == 404)

s = SessionLocal()
bad = [u.id for u in s.query(User).all()
       if kal_coins_service.balance(s, u.id) != kal_coins_service.ledger_balance(s, u.id)]
negative = s.query(User).filter(User.kal_coin_balance < 0).count()
dupes = s.query(CoinTransaction.idempotency_key).count() - len({k for (k,) in s.query(CoinTransaction.idempotency_key).all()})
s.close()
check("Every account's ledger adds up to its balance", not bad, bad)
check("No balance anywhere is negative", negative == 0)
check("No reward or redemption is recorded twice", dupes == 0)


# ===========================================================================
section("9. Step 3 follow-ups: Reports lock, analytics listing")
# ===========================================================================

rid, rh, _ = register(onboarded=True)
res = client.get("/startup/reports/weekly", headers=rh)
check("Weekly health report is ACT-only (402)", res.status_code == 402, res.text)
check("It names the reports feature", res.json()["detail"]["feature"] == "reports")
check("Weekly spend report is ACT-only (402)",
      client.get("/startup/reports/weekly-suggestions", headers=rh).status_code == 402)
check("Report history is ACT-only (402)",
      client.get("/startup/reports/weekly-suggestions/history", headers=rh).status_code == 402)
check("A saved report is ACT-only (402)",
      client.get("/startup/reports/weekly-suggestions/1", headers=rh).status_code == 402)
res = client.get("/startup/overview", headers=rh)
check("The daily brief (startup overview) is not locked", res.status_code != 402, res.status_code)
s = SessionLocal()
s.add(Subscription(user_id=rid, plan="premium", status="active", expires_at=datetime.utcnow() + timedelta(days=5)))
s.commit()
s.close()
check("On ACT the weekly report opens", client.get("/startup/reports/weekly", headers=rh).status_code != 402)

ind_feats = [f["key"] for f in client.get("/billing/catalog", headers=rh).json()["tiers"]["act"]["features"]]
st_feats = [f["key"] for f in client.get("/billing/catalog", headers=sh).json()["tiers"]["act"]["features"]]
check("Individuals see Money Splits analytics in ACT", "analytics" in ind_feats)
check("Startup does not see Money Splits analytics", "analytics" not in st_feats, st_feats)
check("Both see reports", "reports" in ind_feats and "reports" in st_feats)


# ===========================================================================
section("10. Migration e3b7c5a91d24 upgrades and downgrades")
# ===========================================================================

import importlib.util  # noqa: E402

import sqlalchemy as sa  # noqa: E402
from alembic.operations import Operations  # noqa: E402
from alembic.runtime.migration import MigrationContext  # noqa: E402

spec = importlib.util.spec_from_file_location(
    "mig", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "alembic", "versions", "e3b7c5a91d24_add_kal_coins_ledger.py"))
mig = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mig)

mig_engine = sa.create_engine(f"sqlite:///{tempfile.gettempdir()}/moneykal_coins_mig_{uuid.uuid4().hex[:8]}.db")
with mig_engine.begin() as conn:
    conn.execute(sa.text("CREATE TABLE users (id INTEGER PRIMARY KEY, username VARCHAR)"))
    conn.execute(sa.text("INSERT INTO users (username) VALUES ('existing@moneykal.test')"))
    with Operations.context(MigrationContext.configure(conn)):
        mig.upgrade()
    insp = sa.inspect(conn)
    cols = {c["name"] for c in insp.get_columns("users")}
    check("Upgrade adds kal_coin_balance and created_at", {"kal_coin_balance", "created_at"} <= cols, cols)
    check("Upgrade creates coin_transactions", "coin_transactions" in insp.get_table_names())
    row = conn.execute(sa.text("SELECT kal_coin_balance, created_at FROM users")).first()
    check("An existing account starts at 0 coins with no invented sign-up date",
          row[0] == 0 and row[1] is None, row)
    with Operations.context(MigrationContext.configure(conn)):
        mig.upgrade()
    check("Upgrade is safe to re-run", True)
    with Operations.context(MigrationContext.configure(conn)):
        mig.downgrade()
    insp = sa.inspect(conn)
    check("Downgrade removes the ledger and both columns",
          "coin_transactions" not in insp.get_table_names()
          and not ({"kal_coin_balance", "created_at"} & {c["name"] for c in insp.get_columns("users")}))
mig_engine.dispose()


# ===========================================================================
print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(1)
