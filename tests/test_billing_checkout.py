"""
Plans & Billing, step 2 — checkout in demo mode.

Runs the real FastAPI app in-process against a throwaway SQLite file, like the
other tests here. Every purchase goes through the same endpoints the Plans &
Billing page calls.

Run with:  python tests/test_billing_checkout.py
"""
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta

_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_checkout_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"
os.environ.pop("PAYMENT_MODE", None)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import Base, SessionLocal, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402
from backend.main import app  # noqa: E402
from backend.models.domain import Profile, Subscription  # noqa: E402

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


def register(profile_key="individual"):
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


def order(headers, sku, subject_ref=None):
    return client.post("/billing/orders", headers=headers, json={"sku": sku, "subject_ref": subject_ref})


def pay(headers, order_id, method="upi_qr"):
    return client.post(f"/billing/orders/{order_id}/pay", headers=headers, json={"payment_method": method})


def parse(iso):
    return datetime.fromisoformat(iso)


# ===========================================================================
section("1. Buying ACT Monthly")
# ===========================================================================

uid, h = register()
check("Demo mode is reported", client.get("/billing/me", headers=h).json()["payment_mode"] == "demo")
check("Checkout requires sign-in",
      client.post("/billing/orders", json={"sku": "act_monthly"}).status_code == 401)

res = order(h, "act_monthly")
check("Order is created (201)", res.status_code == 201, res.text)
o = res.json()
check("Order is priced at ₹199", o["gross_minor"] == 19900 and o["payable_minor"] == 19900, o)
check("Order starts as created", o["status"] == "created")
check("No coins used yet", o["coins_redeemed"] == 0 and o["coin_discount_minor"] == 0)
check("Creating an order grants nothing", client.get("/billing/me", headers=h).json()["tier"] == "see")
check("An unpaid order is not history", client.get("/billing/orders", headers=h).json() == [])

res = pay(h, o["id"], "bitcoin")
check("Unknown payment method is refused (400)", res.status_code == 400, res.text)

res = pay(h, o["id"], "upi_qr")
check("Payment succeeds", res.status_code == 200, res.text)
body = res.json()
check("Order is paid", body["order"]["status"] == "paid")
check("Payment method is recorded", body["order"]["payment_method"] == "upi_qr")
acct = body["account"]
check("User is now on ACT", acct["tier"] == "act" and acct["subscription_status"] == "active", acct)
check("Plan is the monthly pass", acct["plan"]["sku"] == "act_monthly")
check("30 days of ACT", acct["plan"]["days_left"] == 30, acct["plan"])
first_expiry = parse(acct["plan"]["expires_at"])

res = pay(h, o["id"], "upi_qr")
check("Paying again is harmless", res.status_code == 200 and res.json()["order"]["status"] == "paid")
check("Paying again does not add days",
      parse(client.get("/billing/me", headers=h).json()["plan"]["expires_at"]) == first_expiry)

hist = client.get("/billing/orders", headers=h).json()
check("History shows one payment", len(hist) == 1 and hist[0]["label"] == "ACT Monthly", hist)
check("Split sees ACT as premium", client.get("/split/entitlements", headers=h).json()["is_premium"] is True)


# ===========================================================================
section("2. Buying again while ACT is running adds days on top")
# ===========================================================================

o2 = order(h, "act_yearly").json()
check("ACT Yearly is ₹1,499", o2["payable_minor"] == 149900, o2)
acct = pay(h, o2["id"], "upi_qr").json()["account"]
check("Plan now reports the yearly pass", acct["plan"]["sku"] == "act_yearly")
new_expiry = parse(acct["plan"]["expires_at"])
check("365 days were added to the existing end date",
      abs((new_expiry - first_expiry) - timedelta(days=365)) < timedelta(seconds=5),
      f"{first_expiry} -> {new_expiry}")
check("History lists newest first",
      [x["sku"] for x in client.get("/billing/orders", headers=h).json()] == ["act_yearly", "act_monthly"])


# ===========================================================================
section("3. An expired pass restarts from today")
# ===========================================================================

s = SessionLocal()
sub = s.query(Subscription).filter(Subscription.user_id == uid).first()
sub.expires_at = datetime.utcnow() - timedelta(days=10)
s.commit()
s.close()
check("Expired user is back on SEE", client.get("/billing/me", headers=h).json()["tier"] == "see")
acct = pay(h, order(h, "act_monthly").json()["id"], "upi_qr").json()["account"]
check("Renewing gives a fresh 30 days, not 20", acct["plan"]["days_left"] == 30, acct["plan"])


# ===========================================================================
section("4. Tax Calculator — one tax year for ₹200")
# ===========================================================================

tid, th = register()
check("A tax year is required", order(th, "tax_calculator").status_code == 400)
check("An unknown tax year is refused", order(th, "tax_calculator", "FY1999-00").status_code == 400)

res = order(th, "tax_calculator", "FY2026-27")
check("Tax Calculator order is created", res.status_code == 201, res.text)
t = res.json()
check("It costs ₹200", t["payable_minor"] == 20000)
check("Label names the year", t["label"] == "Tax Calculator · FY2026-27", t["label"])

dup = order(th, "tax_calculator", "FY2026-27").json()
acct = pay(th, t["id"]).json()["account"]
years = {x["subject_ref"]: x["access"] for x in acct["services"]}
check("That year is unlocked", years["FY2026-27"] == "purchased", years)
check("Other years stay locked", years["FY2025-26"] == "locked", years)
check("Buying a tax year does not grant ACT", acct["tier"] == "see")

res = order(th, "tax_calculator", "FY2026-27")
check("The same year cannot be ordered twice (409)", res.status_code == 409, res.text)
res = pay(th, dup["id"])
check("A second order priced earlier cannot be paid (409)", res.status_code == 409, res.text)
check("That stale order is not in history",
      [x["id"] for x in client.get("/billing/orders", headers=th).json()] == [t["id"]])

# ACT includes every year, so there is nothing left to sell.
pay(th, order(th, "act_monthly").json()["id"])
res = order(th, "tax_calculator", "FY2025-26")
check("ACT users are not sold a tax year (409)", res.status_code == 409, res.text)
check("The refusal says it is included", "included" in res.json()["detail"]["message"].lower(), res.text)


# ===========================================================================
section("5. Boundaries")
# ===========================================================================

_, st = register("startup")
res = order(st, "tax_calculator", "FY2026-27")
check("Startup cannot buy the Tax Calculator (403)", res.status_code == 403, res.text)
check("Startup can buy ACT", pay(st, order(st, "act_monthly").json()["id"]).status_code == 200)

check("Unknown items are refused (404)", order(h, "gold_plan").status_code == 404)

_, other = register()
check("Someone else's order cannot be paid (404)", pay(other, o["id"]).status_code == 404)

lid, lh = register()
s = SessionLocal()
s.add(Subscription(user_id=lid, plan="premium", status="active", source="manual"))
s.commit()
s.close()
check("A plan with no end date is not sold a pass (409)", order(lh, "act_monthly").status_code == 409)

os.environ["PAYMENT_MODE"] = "razorpay"
pending = order(h, "act_monthly").json()
os.environ["PAYMENT_MODE"] = "demo"
res = pay(h, pending["id"])
check("An order priced outside demo mode is not granted free (503)", res.status_code == 503, res.text)
os.environ["PAYMENT_MODE"] = "razorpay"
fresh = order(h, "act_monthly").json()
res = pay(h, fresh["id"])
check("With no gateway connected, payment is refused (503)", res.status_code == 503, res.text)
os.environ.pop("PAYMENT_MODE", None)


# ===========================================================================
print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(1)
