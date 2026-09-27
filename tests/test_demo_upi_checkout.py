"""
Plans & Billing, step 3 — the demo UPI QR checkout.

Everything the Plans & Billing page does when someone extends ACT, through the
real endpoints: price the order, take its QR, confirm the payment, and check
that the database ends up exactly where a real payment would have left it.

What these tests are really guarding is that the demo is a demo of the real
thing. The QR carries the amount the order actually charges, the pass is
granted by the same code a paid gateway would reach, Kal Coins leave the ledger
once, and the whole thing refuses to run at all when demo payments are off.

Runs the real FastAPI app in-process against a throwaway SQLite file, like the
other tests here.

Run with:  python tests/test_demo_upi_checkout.py
"""
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_demo_upi_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"
os.environ.pop("PAYMENT_MODE", None)
os.environ.pop("DEMO_PAYMENTS_ENABLED", None)
for _var in ("APP_ENV", "ENVIRONMENT", "ENV", "RAILWAY_ENVIRONMENT_NAME",
             "RAILWAY_ENVIRONMENT", "VERCEL_ENV"):
    os.environ.pop(_var, None)

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from backend.core import qr  # noqa: E402
from backend.core.config import pricing_config as pricing  # noqa: E402
from backend.database import Base, SessionLocal, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402
from backend.main import app  # noqa: E402
from backend.models.domain import BillingOrder, CoinTransaction, Profile, Subscription, User  # noqa: E402

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


def order(headers, sku, subject_ref=None, use_coins=True):
    return client.post("/billing/orders", headers=headers,
                       json={"sku": sku, "subject_ref": subject_ref, "use_coins": use_coins})


def upi_qr(headers, order_id):
    return client.post(f"/billing/orders/{order_id}/upi-qr", headers=headers)


def pay(headers, order_id, method="upi_qr", reference=None):
    return client.post(f"/billing/orders/{order_id}/pay", headers=headers,
                       json={"payment_method": method, "transaction_reference": reference})


def grant_coins(user_id, coins):
    """Put coins in an account without going through an earning rule."""
    s = SessionLocal()
    s.query(User).filter(User.id == user_id).update({User.kal_coin_balance: coins})
    s.add(CoinTransaction(user_id=user_id, type="adjust", reason="test", coins=coins,
                          balance_after=coins, idempotency_key=f"test:{uuid.uuid4().hex}"))
    s.commit()
    s.close()


def upi_params(uri):
    return {k: v[0] for k, v in parse_qs(urlparse(uri).query).items()}


def parse(iso):
    return datetime.fromisoformat(iso)


def db_order(order_id):
    s = SessionLocal()
    row = s.query(BillingOrder).filter(BillingOrder.id == order_id).first()
    s.expunge_all()
    s.close()
    return row


# ===========================================================================
section("1. ACT Monthly through the QR")
# ===========================================================================

uid, h = register()
me = client.get("/billing/me", headers=h).json()
check("Checkout offers one method, UPI QR",
      [m["key"] for m in me["payment_methods"]] == ["upi_qr"], me["payment_methods"])
check("Its label is UPI QR", me["payment_methods"][0]["label"] == "UPI QR")
check("Demo payments are on by default outside production", me["demo_payments"] is True)

o = order(h, "act_monthly").json()
check("Order is ₹199", o["payable_minor"] == 19900, o)
check("Order carries its duration", o["duration_days"] == 30, o)
check("Order names its provider", o["provider"] == "demo" and o["is_demo"] is True, o)
check("A new order is 'created'", o["status"] == "created")
check("A new order has no reference yet", o["transaction_reference"] is None)

res = upi_qr(h, o["id"])
check("The QR is issued (200)", res.status_code == 200, res.text)
q = res.json()
check("It is marked as a demo", q["is_demo"] is True and "no real money" in q["notice"].lower(), q["notice"])
check("The order moves to 'processing'", q["order"]["status"] == "processing", q["order"])
check("Issuing the QR grants nothing", client.get("/billing/me", headers=h).json()["tier"] == "see")

ref = q["transaction_reference"]
check("The reference is a demo reference", ref.startswith("MK-DEMO-") and len(ref) == 16, ref)
check("It is stored on the order", q["order"]["transaction_reference"] == ref)

p = upi_params(q["upi_uri"])
check("The URI is a UPI intent", q["upi_uri"].startswith("upi://pay?"), q["upi_uri"])
check("It pays the demo VPA, not a real one", p["pa"] == "demo@moneykal", p)
check("It names MoneyKal", p["pn"] == "MoneyKal", p)
check("It carries the amount actually payable", p["am"] == "199.00", p)
check("In rupees", p["cu"] == "INR", p)
check("And the transaction reference", p["tr"] == ref, p)
check("The note names the plan", p["tn"] == "ACT Monthly", p)


# ===========================================================================
section("2. The QR really encodes that URI")
# ===========================================================================

rows = q["qr"]["rows"]
size = q["qr"]["size"]
check("The matrix is square", len(rows) == size and all(len(r) == size for r in rows), size)
check("Its size is a real QR version", (size - 17) % 4 == 0 and 21 <= size <= 57, size)
check("It re-encodes to the same matrix", qr.rows(q["upi_uri"]) == rows)

# The three finder patterns, which is what a camera looks for first.
finders = [(0, 0), (0, size - 7), (size - 7, 0)]
check("All three finder patterns are there",
      all(rows[r][c:c + 7] == "1111111" and rows[r + 6][c:c + 7] == "1111111"
          and rows[r + 3][c + 2:c + 5] == "111" for r, c in finders))
check("The timing pattern alternates",
      all(rows[6][i] == str(1 - i % 2) for i in range(8, size - 8)))

# Two different amounts must not produce the same code.
other = order(h, "act_yearly").json()
other_q = upi_qr(h, other["id"]).json()
check("A different amount gives a different QR", other_q["qr"]["rows"] != rows)
check("And its own reference", other_q["transaction_reference"] != ref)


# ===========================================================================
section("3. Confirming the payment grants ACT")
# ===========================================================================

res = pay(h, o["id"], "upi_qr", ref)
check("Payment succeeds", res.status_code == 200, res.text)
body = res.json()
paid = body["order"]
check("The order is paid", paid["status"] == "paid")
check("With the UPI QR method", paid["payment_method"] == "upi_qr")
check("Its label reads UPI QR", paid["payment_method_label"] == "UPI QR")
check("It keeps its reference", paid["transaction_reference"] == ref)
check("paid_at is set", paid["paid_at"] is not None)
check("created_at is set", paid["created_at"] is not None)

acct = body["account"]
check("The user is on ACT", acct["tier"] == "act" and acct["subscription_status"] == "active", acct)
check("On the monthly pass", acct["plan"]["sku"] == "act_monthly")
check("For 30 days", acct["plan"]["days_left"] == 30, acct["plan"])
first_expiry = parse(acct["plan"]["expires_at"])

row = db_order(o["id"])
check("The stored row has every field a transaction needs",
      row.user_id == uid and row.sku == "act_monthly" and row.kind == "act_pass"
      and row.gross_minor == 19900 and row.payable_minor == 19900
      and row.currency == "INR" and row.payment_mode == "demo"
      and row.gateway_order_id == ref and row.gateway_payment_id
      and row.paid_at and row.created_at,
      row.__dict__)
check("The subscription really moved",
      client.get("/split/entitlements", headers=h).json()["is_premium"] is True)
check("History shows the payment",
      [x["transaction_reference"] for x in client.get("/billing/orders", headers=h).json()] == [ref])


# ===========================================================================
section("4. Extending ACT adds to what is left, and never resets it")
# ===========================================================================

res = pay(h, other["id"], "upi_qr", other_q["transaction_reference"])
check("The yearly pass is paid", res.status_code == 200, res.text)
acct = res.json()["account"]
new_expiry = parse(acct["plan"]["expires_at"])
check("365 days are added on top of the 30 still to run",
      abs((new_expiry - first_expiry) - timedelta(days=365)) < timedelta(seconds=5),
      f"{first_expiry} -> {new_expiry}")
check("Which is about 395 days left", 393 <= acct["plan"]["days_left"] <= 396, acct["plan"])

# A user part-way through a pass: 12 days left, buy 30, expect about 42.
eid, eh = register()
s = SessionLocal()
s.add(Subscription(user_id=eid, plan="premium", status="active", source="demo",
                   billing_cycle="monthly", started_at=datetime.utcnow(),
                   expires_at=datetime.utcnow() + timedelta(days=12)))
s.commit()
s.close()
check("They start with 12 days", client.get("/billing/me", headers=eh).json()["plan"]["days_left"] == 12)
eo = order(eh, "act_monthly").json()
pay(eh, eo["id"], "upi_qr", upi_qr(eh, eo["id"]).json()["transaction_reference"])
left = client.get("/billing/me", headers=eh).json()["plan"]["days_left"]
check("12 remaining + 30 bought = about 42 left", left == 42, left)

# And one whose pass has lapsed.
s = SessionLocal()
s.query(Subscription).filter(Subscription.user_id == eid).update(
    {Subscription.expires_at: datetime.utcnow() - timedelta(days=20)})
s.commit()
s.close()
check("A lapsed pass is back on SEE", client.get("/billing/me", headers=eh).json()["tier"] == "see")
xo = order(eh, "act_monthly").json()
pay(eh, xo["id"], "upi_qr", upi_qr(eh, xo["id"]).json()["transaction_reference"])
left = client.get("/billing/me", headers=eh).json()["plan"]["days_left"]
check("An expired pass restarts from today, not from the lapsed date", left == 30, left)


# ===========================================================================
section("5. Kal Coins come off the price, and off the QR")
# ===========================================================================

cid, ch = register()
grant_coins(cid, 1000)                     # 1000 coins = ₹100
co = order(ch, "act_yearly").json()
check("The yearly pass is ₹1,499 before coins", co["gross_minor"] == 149900, co)
check("1000 coins are quoted", co["coins_redeemed"] == 1000, co)
check("Worth ₹100", co["coin_discount_minor"] == 10000, co)
check("Leaving ₹1,399 to pay", co["payable_minor"] == 139900, co)

cq = upi_qr(ch, co["id"]).json()
cp = upi_params(cq["upi_uri"])
check("The QR asks for the discounted total, not the list price", cp["am"] == "1399.00", cp)
check("The intent reports the same amount", cq["amount_minor"] == 139900, cq)

check("Coins are not spent before payment",
      client.get("/billing/coins", headers=ch).json()["balance"] == 1000)
res = pay(ch, co["id"], "upi_qr", cq["transaction_reference"])
check("Payment succeeds", res.status_code == 200, res.text)
coins = client.get("/billing/coins", headers=ch).json()
# 1000 spent, then 100 back as the ACT Yearly reward.
check("1000 coins were spent and the yearly reward credited", coins["balance"] == 100, coins["balance"])
check("The ledger records one redemption",
      sum(1 for x in coins["history"] if x["reason"] == "checkout") == 1, coins["history"])
check("The order stores list price, discount and final amount separately",
      res.json()["order"]["gross_minor"] == 149900
      and res.json()["order"]["coin_discount_minor"] == 10000
      and res.json()["order"]["payable_minor"] == 139900)

# Coins covering the whole price need no QR at all.
fid, fh = register()
grant_coins(fid, 2000)                     # ₹200, exactly the Tax Calculator
fo = order(fh, "tax_calculator", "FY2026-27").json()
check("Coins cover it in full", fo["payable_minor"] == 0, fo)
res = upi_qr(fh, fo["id"])
check("There is no QR to show for a free order (400)", res.status_code == 400, res.text)
check("And it says why", res.json()["detail"]["error"] == "no_payment_needed", res.text)
res = pay(fh, fo["id"], "")
check("It pays with coins and no method", res.status_code == 200, res.text)
check("Recorded as paid with coins", res.json()["order"]["payment_method"] == "coins")


# ===========================================================================
section("6. One payment per transaction, however many times it is asked for")
# ===========================================================================

did, dh = register()
do = order(dh, "act_monthly").json()
first = upi_qr(dh, do["id"]).json()
again = upi_qr(dh, do["id"]).json()
check("Asking for the QR twice returns the same reference",
      again["transaction_reference"] == first["transaction_reference"])
check("And the same QR", again["qr"]["rows"] == first["qr"]["rows"])
check("Still only one order row",
      len(client.get("/billing/orders", headers=dh).json()) == 0)

dref = first["transaction_reference"]
pay(dh, do["id"], "upi_qr", dref)
expiry = client.get("/billing/me", headers=dh).json()["plan"]["expires_at"]
for i in range(4):
    res = pay(dh, do["id"], "upi_qr", dref)
    check(f"Confirming again is harmless ({i + 1})",
          res.status_code == 200 and res.json()["order"]["status"] == "paid", res.text)
check("ACT was extended exactly once",
      client.get("/billing/me", headers=dh).json()["plan"]["expires_at"] == expiry)
check("And history holds one payment", len(client.get("/billing/orders", headers=dh).json()) == 1)

s = SessionLocal()
redemptions = s.query(CoinTransaction).filter(
    CoinTransaction.user_id == cid, CoinTransaction.reason == "checkout").count()
s.close()
check("The coin redemption is still a single ledger row", redemptions == 1, redemptions)

# A reference cannot be reused on a different order.
d2 = order(dh, "act_monthly").json()
upi_qr(dh, d2["id"])
res = pay(dh, d2["id"], "upi_qr", dref)
check("Another order's reference is refused (409)", res.status_code == 409, res.text)
check("It says the payment does not match",
      res.json()["detail"]["error"] == "reference_mismatch", res.text)
check("And that order stayed unpaid", db_order(d2["id"]).status == "processing")
check("References are unique across orders",
      db_order(d2["id"]).gateway_order_id != dref)


# ===========================================================================
section("7. Changing the total withdraws the QR that named the old one")
# ===========================================================================

tid, th = register()
grant_coins(tid, 500)
to = order(th, "act_monthly").json()
check("Coins are applied by default", to["payable_minor"] == 14900, to)
tq = upi_qr(th, to["id"]).json()
check("The QR asks for ₹149", upi_params(tq["upi_uri"])["am"] == "149.00")

off = client.post(f"/billing/orders/{to['id']}/coins", headers=th, json={"use_coins": False})
check("Turning coins off works while a QR is out (200)", off.status_code == 200, off.text)
check("The full price is back", off.json()["payable_minor"] == 19900, off.json())
check("The order waits for payment again", off.json()["status"] == "created", off.json())
check("The reference is kept — it is the same transaction",
      off.json()["transaction_reference"] == tq["transaction_reference"])

tq2 = upi_qr(th, to["id"]).json()
check("A fresh QR asks for the new total", upi_params(tq2["upi_uri"])["am"] == "199.00")
check("Under the same reference", tq2["transaction_reference"] == tq["transaction_reference"])
check("And it is a different code", tq2["qr"]["rows"] != tq["qr"]["rows"])


# ===========================================================================
section("8. Refusals")
# ===========================================================================

res = client.post(f"/billing/orders/{o['id']}/upi-qr")
check("A QR needs sign-in (401)", res.status_code == 401)
_, sh = register()
check("Someone else's order has no QR (404)", upi_qr(sh, o["id"]).status_code == 404)
check("An unknown order has no QR (404)", upi_qr(h, 999999).status_code == 404)
check("A paid order cannot be re-opened for payment (409)", upi_qr(h, o["id"]).status_code == 409)
check("An unknown plan is refused (404)", order(h, "act_lifetime").status_code == 404)

nid, nh = register()
no = order(nh, "act_monthly").json()
nq = upi_qr(nh, no["id"]).json()
check("Card is no longer a payment method (400)",
      pay(nh, no["id"], "card").status_code == 400)
check("Nor is net banking (400)", pay(nh, no["id"], "netbanking").status_code == 400)
check("Nor is plain 'upi' (400)", pay(nh, no["id"], "upi").status_code == 400)
check("A refused method leaves the order unpaid", db_order(no["id"]).status == "processing")
check("And grants nothing", client.get("/billing/me", headers=nh).json()["tier"] == "see")
check("The refusal names the only method",
      "upi qr" in pay(nh, no["id"], "card").json()["detail"]["message"].lower())

# Confirming without a reference still works — an order paid in coins never
# had one, so it cannot be required.
check("A confirmation may omit the reference",
      pay(nh, no["id"], "upi_qr").status_code == 200)


# ===========================================================================
section("9. The demo switch is a real switch")
# ===========================================================================

gid, gh = register()
go = order(gh, "act_monthly").json()
gq = upi_qr(gh, go["id"]).json()

os.environ["DEMO_PAYMENTS_ENABLED"] = "false"
check("With demo payments off, /billing/me says so",
      client.get("/billing/me", headers=gh).json()["demo_payments"] is False)
res = upi_qr(gh, go["id"])
check("No QR is issued (503)", res.status_code == 503, res.text)
res = pay(gh, go["id"], "upi_qr", gq["transaction_reference"])
check("A payment already under way cannot be confirmed (503)", res.status_code == 503, res.text)
check("No ACT was granted", client.get("/billing/me", headers=gh).json()["tier"] == "see")
check("The order is still unpaid", db_order(go["id"]).status == "processing")
res = order(gh, "act_monthly")
check("Pricing an order still works — only payment is off", res.status_code == 201, res.text)
check("Paying that one is refused too", pay(gh, res.json()["id"], "upi_qr").status_code == 503)

os.environ.pop("DEMO_PAYMENTS_ENABLED")
check("Turning it back on restores the QR", upi_qr(gh, go["id"]).status_code == 200)

# A deployment that calls itself production has to opt in by name.
os.environ["ENVIRONMENT"] = "production"
check("A production deployment has demo payments off by default",
      pricing.demo_payments_enabled() is False)
check("So it issues no QR (503)", upi_qr(gh, go["id"]).status_code == 503)
check("And grants nothing (503)", pay(gh, go["id"], "upi_qr").status_code == 503)
os.environ["DEMO_PAYMENTS_ENABLED"] = "true"
check("Unless it opts in by name", pricing.demo_payments_enabled() is True)
check("And then the demo runs there", upi_qr(gh, go["id"]).status_code == 200)
os.environ.pop("DEMO_PAYMENTS_ENABLED")
os.environ.pop("ENVIRONMENT")

# With a real gateway named but not connected, nothing is given away either.
os.environ["PAYMENT_MODE"] = "razorpay"
check("Naming a gateway turns the demo off", pricing.demo_payments_enabled() is False)
rid, rh = register()
ro = order(rh, "act_monthly").json()
check("Its orders are not demo orders", ro["provider"] == "razorpay" and ro["is_demo"] is False, ro)
check("No demo QR for them (503)", upi_qr(rh, ro["id"]).status_code == 503)
check("And no free pass (503)", pay(rh, ro["id"], "upi_qr").status_code == 503)
check("Still on SEE", client.get("/billing/me", headers=rh).json()["tier"] == "see")
os.environ.pop("PAYMENT_MODE")
check("An order priced under a gateway is not granted once demo mode returns",
      pay(rh, ro["id"], "upi_qr").status_code == 503)


# ===========================================================================
print(f"\n{PASSED} passed, {len(FAILED)} failed")
if FAILED:
    for f in FAILED:
        print(f"  - {f}")
    sys.exit(1)
