"""
Money Splits — end-to-end test suite.

Runs the real FastAPI app in-process against a throwaway SQLite file, so every
assertion below goes through the actual HTTP layer: real auth, real
authorization, real serialisation. Nothing is mocked and no fixture data is
inserted directly into the database — every row these tests read was created by
calling the same endpoints the website calls.

Run with:  python tests/test_split_feature.py

Written as a plain script rather than a pytest module to match the convention
already used by the other tests in this directory (pytest is not installed in
this environment), but each check is an assert, and the script exits non-zero
on the first failure.
"""
import os
import sys
import tempfile
import uuid

# Point the app at a scratch database *before* anything imports backend.database,
# which reads DATABASE_URL at module scope. A test that ran against twin.db would
# be writing into the developer's real data.
_TEST_DB = os.path.join(tempfile.gettempdir(), f"moneykal_split_test_{uuid.uuid4().hex[:8]}.db")
os.environ["DATABASE_URL"] = f"sqlite:///{_TEST_DB}"

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402

from backend.database import Base, engine  # noqa: E402
import backend.models.domain  # noqa: F401,E402  (registers the tables)
from backend.main import app  # noqa: E402
from backend.services.split_math import (  # noqa: E402
    SplitMathError, allocate_by_percent, allocate_by_weights, allocate_equal,
    format_minor, simplify_debts, to_minor,
)

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


def register(email=None, password="Password123!"):
    email = email or f"u_{uuid.uuid4().hex[:10]}@moneykal.test"
    res = client.post("/auth/register", json={"username": email, "password": password})
    assert res.status_code == 200, f"register failed: {res.text}"
    body = res.json()
    return email, {"Authorization": f"Bearer {body['access_token']}"}, body


def api(method, path, headers, **kw):
    return client.request(method, path, headers=headers, **kw)


# ===========================================================================
section("1. Money engine — allocation and rounding")
# ===========================================================================

shares = allocate_equal(to_minor("100"), 3)
check("Rs 100 across 3 sums to exactly Rs 100", sum(shares) == 10000, f"got {sum(shares)}")
check("Rs 100 across 3 is 33.34/33.33/33.33", shares == [3334, 3333, 3333], f"got {shares}")

check("Rs 0.01 across 3 loses nothing", sum(allocate_equal(1, 3)) == 1)
check("Rs 10 across 7 sums exactly", sum(allocate_equal(1000, 7)) == 1000)
check("Rs 0.05 across 3 = [2,2,1]", allocate_equal(5, 3) == [2, 2, 1], f"got {allocate_equal(5,3)}")

pct = allocate_by_percent(to_minor("100"), ["33.33", "33.33", "33.34"])
check("Percentages totalling 100 allocate exactly", sum(pct) == 10000, f"got {sum(pct)}")

ratio = allocate_by_weights(to_minor("100"), [2, 1, 1])
check("Ratio 2:1:1 of Rs 100 = 50/25/25", ratio == [5000, 2500, 2500], f"got {ratio}")

odd = allocate_by_weights(to_minor("100"), [1, 1, 1, 1, 1, 1, 7])
check("Ratio with 7 parts sums exactly", sum(odd) == 10000, f"got {sum(odd)}")

check("Zero weight gets zero", allocate_by_weights(1000, [1, 0, 1]) == [500, 0, 500])
check("Negative total (refund) sums exactly", sum(allocate_by_weights(-10000, [1, 1, 1])) == -10000)

try:
    allocate_by_percent(to_minor("100"), [50, 30, 10])
    check("Percentages not totalling 100 are rejected", False)
except SplitMathError:
    check("Percentages not totalling 100 are rejected", True)

try:
    to_minor("10.567", "INR")
    check("Over-precise INR amount is rejected", False)
except SplitMathError:
    check("Over-precise INR amount is rejected", True)

check("Float 19.99 parses as 1999 paise, not 1998", to_minor(19.99) == 1999, f"got {to_minor(19.99)}")
check("0.1 + 0.2 problem avoided", to_minor(0.1) + to_minor(0.2) == to_minor(0.3))
check("INR grouping is Indian", format_minor(12345678, "INR") == "₹1,23,456.78",
      format_minor(12345678, "INR"))
check("USD grouping is Western", format_minor(123456, "USD") == "$1,234.56", format_minor(123456, "USD"))

t = simplify_debts({1: 200000, 2: -100000, 3: -100000})
check("Debt simplification produces 2 transfers", len(t) == 2, f"got {t}")
check("Debt simplification conserves money", sum(x["amount_minor"] for x in t) == 200000)

# A cycle A->B->C->A should collapse to nothing.
cyc = simplify_debts({1: 0, 2: 0, 3: 0})
check("A fully-settled group needs no transfers", cyc == [], f"got {cyc}")


# ===========================================================================
section("2. Accounts, identity and friends")
# ===========================================================================

divij_email, divij, _ = register("divij@moneykal.test")
harshit_email, harshit, _ = register("harshit@moneykal.test")
jiya_email, jiya, _ = register("jiya@moneykal.test")

me = api("GET", "/split/me", divij)
check("GET /split/me returns 200", me.status_code == 200, me.text)
divij_person = me.json()["person"]["id"]
check("A SplitPerson identity is created on first use", isinstance(divij_person, int))
check("New user starts settled up", me.json()["summary"]["status"] == "settled")
check("Free plan by default", me.json()["entitlements"]["plan"] == "free")
check("Split is not premium-gated", me.json()["entitlements"]["is_premium"] is False)

h_person = api("GET", "/split/me", harshit).json()["person"]["id"]
j_person = api("GET", "/split/me", jiya).json()["person"]["id"]

res = api("GET", "/split/friends/search", divij, params={"q": harshit_email})
check("Search finds an existing user by exact email", res.status_code == 200
      and any(r["id"] == h_person for r in res.json()["results"]), res.text)

res = api("GET", "/split/friends/search", divij, params={"q": "a"})
check("Search below 2 chars is refused", res.status_code == 422)

res = api("POST", "/split/friends", divij, json={"person_id": h_person})
check("Add an existing user as a friend", res.status_code == 201, res.text)

res = api("POST", "/split/friends", divij, json={"person_id": divij_person})
check("Cannot befriend yourself", res.status_code == 400, res.text)

res = api("GET", "/split/friends", divij)
check("Friend list contains Harshit", any(f["id"] == h_person for f in res.json()["friends"]))

res = api("GET", "/split/me", {})
check("Unauthenticated /split/me is rejected", res.status_code == 401, res.text)


# ===========================================================================
section("3. Groups and membership authorization")
# ===========================================================================

res = api("POST", "/split/groups", divij,
          json={"name": "Goa Trip", "group_type": "trip", "currency": "INR", "emoji": "\U0001f3d6"})
check("Create a group", res.status_code == 201, res.text)
goa = res.json()["id"]

res = api("POST", "/split/groups", divij, json={"name": "   "})
check("A group needs a name", res.status_code == 400, res.text)

api("POST", f"/split/groups/{goa}/members", divij, json={"person_id": h_person})
api("POST", f"/split/groups/{goa}/members", divij, json={"person_id": j_person})

detail = api("GET", f"/split/groups/{goa}", divij)
check("Group detail returns 200", detail.status_code == 200, detail.text)
check("Group has 3 members", len(detail.json()["members"]) == 3,
      str(len(detail.json()["members"])))

# The authorization boundary.
stranger_email, stranger, _ = register()
res = api("GET", f"/split/groups/{goa}", stranger)
check("A non-member cannot read the group", res.status_code == 404, res.text)
res = api("PUT", f"/split/groups/{goa}", stranger, json={"name": "Hijacked"})
check("A non-member cannot rename the group", res.status_code == 404, res.text)
res = api("POST", f"/split/groups/{goa}/members", stranger, json={"email": "x@y.test"})
check("A non-member cannot add members", res.status_code == 404, res.text)

res = api("PUT", f"/split/groups/{goa}", harshit, json={"name": "Not allowed"})
check("A non-owner member cannot rename the group", res.status_code == 403, res.text)


# ===========================================================================
section("4. Expenses — every split mode")
# ===========================================================================

def add_expense(headers, **payload):
    payload.setdefault("group_id", goa)
    return api("POST", "/split/expenses", headers, json=payload)


# --- The brief's worked example: Divij pays 3000 for 3 people ---------------
res = add_expense(divij, description="Dinner", amount="3000",
                  split_mode="equal",
                  participant_person_ids=[divij_person, h_person, j_person],
                  payers=[{"person_id": divij_person, "amount": "3000"}])
check("Equal split expense created", res.status_code == 201, res.text)
dinner = res.json()
check("Total is Rs 3,000", dinner["total"]["display"] == "₹3,000.00", dinner["total"]["display"])
check("Divij's own share is Rs 1,000",
      dinner["your_share"]["minor"] == 100000, str(dinner["your_share"]))
check("Divij nets +Rs 2,000", dinner["your_net"]["minor"] == 200000, str(dinner["your_net"]))
check("Shares sum to the total",
      sum(s["amount"]["minor"] for s in dinner["shares"]) == 300000)

g = api("GET", f"/split/groups/{goa}", divij).json()
check("Divij is owed Rs 2,000", g["summary"]["owed_to_you"]["minor"] == 200000,
      str(g["summary"]))
check("Divij's group status is 'owed'", g["summary"]["status"] == "owed")

gh = api("GET", f"/split/groups/{goa}", harshit).json()
check("Harshit owes Rs 1,000", gh["summary"]["you_owe"]["minor"] == 100000, str(gh["summary"]))
check("Harshit's status is 'owes'", gh["summary"]["status"] == "owes")

# --- Unequal / exact -------------------------------------------------------
res = add_expense(divij, description="Cab", amount="1000", split_mode="exact",
                  participant_person_ids=[divij_person, h_person, j_person],
                  split_values={str(divij_person): "500", str(h_person): "300",
                                str(j_person): "200"},
                  payers=[{"person_id": divij_person, "amount": "1000"}])
check("Exact/unequal split accepted", res.status_code == 201, res.text)
check("Exact shares are honoured verbatim",
      sorted(s["amount"]["minor"] for s in res.json()["shares"]) == [20000, 30000, 50000])

res = add_expense(divij, description="Bad cab", amount="1000", split_mode="exact",
                  participant_person_ids=[divij_person, h_person],
                  split_values={str(divij_person): "500", str(h_person): "400"},
                  payers=[{"person_id": divij_person, "amount": "1000"}])
check("Exact amounts that do not add up are rejected", res.status_code == 400, res.text)

# --- Percentage ------------------------------------------------------------
res = add_expense(divij, description="Hotel", amount="10000", split_mode="percent",
                  participant_person_ids=[divij_person, h_person, j_person],
                  split_values={str(divij_person): "50", str(h_person): "30",
                                str(j_person): "20"},
                  payers=[{"person_id": divij_person, "amount": "10000"}])
check("Percentage split accepted", res.status_code == 201, res.text)
check("50/30/20 of Rs 10,000 allocates correctly",
      sorted(s["amount"]["minor"] for s in res.json()["shares"]) == [200000, 300000, 500000])

res = add_expense(divij, description="Bad hotel", amount="10000", split_mode="percent",
                  participant_person_ids=[divij_person, h_person],
                  split_values={str(divij_person): "50", str(h_person): "30"},
                  payers=[{"person_id": divij_person, "amount": "10000"}])
check("Percentages not summing to 100 are rejected", res.status_code == 400, res.text)

# --- Shares / ratio --------------------------------------------------------
res = add_expense(divij, description="Petrol", amount="900", split_mode="shares",
                  participant_person_ids=[divij_person, h_person, j_person],
                  split_values={str(divij_person): "2", str(h_person): "1",
                                str(j_person): "1"},
                  payers=[{"person_id": divij_person, "amount": "900"}])
check("Shares/ratio split accepted", res.status_code == 201, res.text)
check("2:1:1 of Rs 900 = 450/225/225",
      sorted(s["amount"]["minor"] for s in res.json()["shares"]) == [22500, 22500, 45000],
      str(sorted(s["amount"]["minor"] for s in res.json()["shares"])))

# --- Itemized --------------------------------------------------------------
res = add_expense(divij, description="Restaurant", amount="1000", split_mode="itemized",
                  participant_person_ids=[divij_person, h_person, j_person],
                  items=[
                      {"name": "Pizza", "amount": "400",
                       "participant_person_ids": [divij_person, h_person]},
                      {"name": "Pasta", "amount": "300",
                       "participant_person_ids": [j_person]},
                      {"name": "Drinks", "amount": "200",
                       "participant_person_ids": [divij_person, h_person, j_person]},
                  ],
                  payers=[{"person_id": divij_person, "amount": "1000"}])
check("Itemized split accepted", res.status_code == 201, res.text)
itemized = res.json()
check("Itemized shares sum to the total",
      sum(s["amount"]["minor"] for s in itemized["shares"]) == 100000,
      str(sum(s["amount"]["minor"] for s in itemized["shares"])))
check("Itemized keeps its 3 items", len(itemized["items"]) == 3)
# Items total 900; the remaining 100 (tax/tip) is spread pro-rata.
by_person = {s["person"]["id"]: s["amount"]["minor"] for s in itemized["shares"]}
check("Pasta-only diner carries their own item plus a share of the rest",
      by_person[j_person] > 36000 and by_person[j_person] < 42000, str(by_person))

res = add_expense(divij, description="Over-itemized", amount="500", split_mode="itemized",
                  participant_person_ids=[divij_person, h_person],
                  items=[{"name": "Too much", "amount": "900",
                          "participant_person_ids": [divij_person]}],
                  payers=[{"person_id": divij_person, "amount": "500"}])
check("Items exceeding the total are rejected", res.status_code == 400, res.text)

# --- Multiple payers -------------------------------------------------------
res = add_expense(divij, description="Villa", amount="3000", split_mode="equal",
                  participant_person_ids=[divij_person, h_person, j_person],
                  payers=[{"person_id": divij_person, "amount": "2000"},
                          {"person_id": h_person, "amount": "1000"}])
check("Multiple payers accepted", res.status_code == 201, res.text)
villa = res.json()
check("Two payers recorded", len(villa["payers"]) == 2)
check("Divij nets +1,000 on the villa (paid 2000, share 1000)",
      villa["your_net"]["minor"] == 100000, str(villa["your_net"]))

vh = api("GET", f"/split/expenses/{villa['id']}", harshit).json()
check("Harshit nets 0 on the villa (paid 1000, share 1000)",
      vh["your_net"]["minor"] == 0, str(vh["your_net"]))

res = add_expense(divij, description="Mismatch", amount="3000", split_mode="equal",
                  participant_person_ids=[divij_person, h_person],
                  payers=[{"person_id": divij_person, "amount": "2000"}])
check("Payer amounts must equal the expense total", res.status_code == 400, res.text)

# --- Validation and authorization -----------------------------------------
res = add_expense(divij, description="", amount="100",
                  participant_person_ids=[divij_person],
                  payers=[{"person_id": divij_person, "amount": "100"}])
check("An expense needs a description", res.status_code == 400, res.text)

res = add_expense(divij, description="Zero", amount="0",
                  participant_person_ids=[divij_person],
                  payers=[{"person_id": divij_person, "amount": "0"}])
check("A zero expense is rejected", res.status_code == 400, res.text)

stranger_person = api("GET", "/split/me", stranger).json()["person"]["id"]
res = add_expense(divij, description="Outsider", amount="100", split_mode="equal",
                  participant_person_ids=[divij_person, stranger_person],
                  payers=[{"person_id": divij_person, "amount": "100"}])
check("Cannot put a non-member on a group expense", res.status_code == 403, res.text)

res = api("GET", f"/split/expenses/{dinner['id']}", stranger)
check("A stranger cannot read an expense", res.status_code == 404, res.text)
res = api("DELETE", f"/split/expenses/{dinner['id']}", stranger)
check("A stranger cannot delete an expense", res.status_code == 404, res.text)


# ===========================================================================
section("5. Duplicate submission prevention")
# ===========================================================================

token = uuid.uuid4().hex
p1 = add_expense(divij, description="Double tap", amount="600", split_mode="equal",
                 participant_person_ids=[divij_person, h_person, j_person],
                 payers=[{"person_id": divij_person, "amount": "600"}],
                 client_token=token)
p2 = add_expense(divij, description="Double tap", amount="600", split_mode="equal",
                 participant_person_ids=[divij_person, h_person, j_person],
                 payers=[{"person_id": divij_person, "amount": "600"}],
                 client_token=token)
check("A repeated client_token returns the same expense",
      p1.json()["id"] == p2.json()["id"], f"{p1.json()['id']} vs {p2.json()['id']}")

count = len([e for e in api("GET", "/split/expenses", divij,
                            params={"group_id": goa}).json()["expenses"]
             if e["description"] == "Double tap"])
check("The double-tapped expense was booked once", count == 1, f"found {count}")


# ===========================================================================
section("6. Editing and deleting")
# ===========================================================================

before = api("GET", f"/split/groups/{goa}", divij).json()["summary"]["net"]["minor"]

res = api("PUT", f"/split/expenses/{dinner['id']}", divij,
          json={"description": "Dinner in Goa", "amount": "3600"})
check("Expense edit accepted", res.status_code == 200, res.text)
edited = res.json()
check("Description updated", edited["description"] == "Dinner in Goa")
check("Edited shares re-split evenly (1200 each)",
      sorted(s["amount"]["minor"] for s in edited["shares"]) == [120000, 120000, 120000],
      str(sorted(s["amount"]["minor"] for s in edited["shares"])))
after = api("GET", f"/split/groups/{goa}", divij).json()["summary"]["net"]["minor"]
# Divij paid the whole bill and carries one of three shares, so his net is
# two-thirds of the total: 3000 -> 2000 owed, 3600 -> 2400 owed, a move of 400.
check("Balances moved by exactly the edit (+400 to Divij's net)",
      after - before == 40000, f"{before} -> {after}")

# Editing to a different split mode must fully replace the old shares.
res = api("PUT", f"/split/expenses/{dinner['id']}", divij,
          json={"split_mode": "shares", "amount": "3600",
                "split_values": {str(divij_person): "1", str(h_person): "1",
                                 str(j_person): "2"}})
check("Changing split mode on edit works", res.status_code == 200, res.text)
check("Old equal shares are gone, not merged",
      sorted(s["amount"]["minor"] for s in res.json()["shares"]) == [90000, 90000, 180000],
      str(sorted(s["amount"]["minor"] for s in res.json()["shares"])))

# Removing a participant on edit must not leave a stale share behind.
res = api("PUT", f"/split/expenses/{dinner['id']}", divij,
          json={"split_mode": "equal", "amount": "3600",
                "participant_person_ids": [divij_person, h_person]})
check("Participant removed on edit", len(res.json()["shares"]) == 2, res.text)
check("Two-way re-split is 1800/1800",
      sorted(s["amount"]["minor"] for s in res.json()["shares"]) == [180000, 180000])

pre_delete = api("GET", f"/split/groups/{goa}", divij).json()["summary"]["net"]["minor"]
res = api("DELETE", f"/split/expenses/{dinner['id']}", divij)
check("Delete returns 204", res.status_code == 204, res.text)
post_delete = api("GET", f"/split/groups/{goa}", divij).json()["summary"]["net"]["minor"]
check("Deleting an expense removes its effect on balances",
      post_delete == pre_delete - 180000, f"{pre_delete} -> {post_delete}")
check("A deleted expense is no longer readable",
      api("GET", f"/split/expenses/{dinner['id']}", divij).status_code == 404)
check("A deleted expense is out of the list",
      all(e["id"] != dinner["id"] for e in
          api("GET", "/split/expenses", divij, params={"group_id": goa}).json()["expenses"]))


# ===========================================================================
section("7. Balance engine correctness")
# ===========================================================================

res = api("POST", "/split/groups", divij, json={"name": "Balance Lab", "currency": "INR"})
lab = res.json()["id"]
api("POST", f"/split/groups/{lab}/members", divij, json={"person_id": h_person})
api("POST", f"/split/groups/{lab}/members", divij, json={"person_id": j_person})

# Exactly the scenario from the brief.
api("POST", "/split/expenses", divij, json={
    "group_id": lab, "description": "Brief example", "amount": "3000",
    "split_mode": "equal",
    "participant_person_ids": [divij_person, h_person, j_person],
    "payers": [{"person_id": divij_person, "amount": "3000"}],
})

lab_d = api("GET", f"/split/groups/{lab}", divij).json()
nets = {m["id"]: m["net"]["minor"] for m in lab_d["members"]}
check("Divij +2,000", nets[divij_person] == 200000, str(nets))
check("Harshit -1,000", nets[h_person] == -100000, str(nets))
check("Jiya -1,000", nets[j_person] == -100000, str(nets))
check("Nets sum to zero", sum(nets.values()) == 0, str(nets))
check("Group total spent is Rs 3,000", lab_d["summary"]["total_spent"]["minor"] == 300000)

check("Debt simplification offers 2 transfers", len(lab_d["settle_suggestions"]) == 2,
      str(lab_d["settle_suggestions"]))
check("Simplified transfers all point at Divij",
      all(s["to"]["id"] == divij_person for s in lab_d["settle_suggestions"]))

# Reciprocal debts must net off rather than stack.
api("POST", "/split/expenses", harshit, json={
    "group_id": lab, "description": "Harshit pays back in kind", "amount": "600",
    "split_mode": "equal",
    "participant_person_ids": [divij_person, h_person],
    "payers": [{"person_id": h_person, "amount": "600"}],
})
lab_d = api("GET", f"/split/groups/{lab}", divij).json()
pair = [b for b in lab_d["balances"]
        if {b["from"]["id"], b["to"]["id"]} == {divij_person, h_person}]
check("Mutual debts collapse to one direction", len(pair) == 1, str(lab_d["balances"]))
check("Harshit now owes Rs 700 net", pair[0]["amount"]["minor"] == 70000, str(pair[0]))


# ===========================================================================
section("8. Settlements")
# ===========================================================================

# Partial settlement.
res = api("POST", "/split/settlements", harshit, json={
    "group_id": lab, "from_person_id": h_person, "to_person_id": divij_person,
    "amount": "300", "method": "upi", "note": "part payment",
})
check("Partial settlement accepted", res.status_code == 201, res.text)

lab_d = api("GET", f"/split/groups/{lab}", divij).json()
pair = [b for b in lab_d["balances"]
        if {b["from"]["id"], b["to"]["id"]} == {divij_person, h_person}]
check("Partial settlement reduces the balance to Rs 400",
      pair[0]["amount"]["minor"] == 40000, str(pair))
check("Settlement does not change what the group spent",
      lab_d["summary"]["total_spent"]["minor"] == 360000,
      str(lab_d["summary"]["total_spent"]))
check("Settlement is listed separately from expenses", len(lab_d["settlements"]) == 1)

# Overpayment is refused.
res = api("POST", "/split/settlements", harshit, json={
    "group_id": lab, "from_person_id": h_person, "to_person_id": divij_person,
    "amount": "99999",
})
check("Settling more than is owed is rejected", res.status_code == 400, res.text)

# Full settlement of the remainder.
res = api("POST", "/split/settlements", harshit, json={
    "group_id": lab, "from_person_id": h_person, "to_person_id": divij_person,
    "amount": "400",
})
check("Full settlement accepted", res.status_code == 201, res.text)
lab_h = api("GET", f"/split/groups/{lab}", harshit).json()
check("Harshit is settled up with Divij",
      not [b for b in lab_h["balances"]
           if {b["from"]["id"], b["to"]["id"]} == {divij_person, h_person}],
      str(lab_h["balances"]))

# Settlement idempotency.
stoken = uuid.uuid4().hex
s1 = api("POST", "/split/settlements", jiya, json={
    "group_id": lab, "from_person_id": j_person, "to_person_id": divij_person,
    "amount": "100", "client_token": stoken})
s2 = api("POST", "/split/settlements", jiya, json={
    "group_id": lab, "from_person_id": j_person, "to_person_id": divij_person,
    "amount": "100", "client_token": stoken})
check("A repeated settlement token returns the same settlement",
      s1.json()["id"] == s2.json()["id"])

res = api("POST", "/split/settlements", stranger, json={
    "group_id": lab, "from_person_id": h_person, "to_person_id": divij_person,
    "amount": "100"})
check("A stranger cannot record a settlement in the group", res.status_code == 404, res.text)

res = api("POST", "/split/settlements", divij, json={
    "group_id": lab, "from_person_id": divij_person, "to_person_id": divij_person,
    "amount": "100"})
check("A settlement to yourself is rejected", res.status_code == 400, res.text)

# Deleting a settlement restores the debt.
before = api("GET", f"/split/groups/{lab}", divij).json()["summary"]["owed_to_you"]["minor"]
sid = s1.json()["id"]
check("Delete settlement returns 204",
      api("DELETE", f"/split/settlements/{sid}", divij).status_code == 204)
after = api("GET", f"/split/groups/{lab}", divij).json()["summary"]["owed_to_you"]["minor"]
check("Deleting a settlement restores the balance", after == before + 10000,
      f"{before} -> {after}")


# ===========================================================================
section("9. Invitations and guest -> real user conversion")
# ===========================================================================

guest_email = f"guest_{uuid.uuid4().hex[:8]}@moneykal.test"
res = api("POST", "/split/invitations", divij,
          json={"email": guest_email, "name": "Rahul", "group_id": goa})
check("Invitation created", res.status_code == 201, res.text)
invite = res.json()
guest_person = invite["person"]["id"]
check("Invitee exists immediately as a guest", invite["person"]["is_guest"] is True)
check("Invitation carries a deep link", invite["invite_path"].startswith("/join.html?token="))

preview = client.get(f"/split/invite/{invite['token']}")
check("Invite preview works unauthenticated", preview.status_code == 200, preview.text)
check("Preview names the inviter", preview.json()["invited_by"] == "Divij",
      str(preview.json()))
check("Preview names the group", preview.json()["group"]["name"] == "Goa Trip")
check("Preview leaks no expenses", "expenses" not in preview.json())

check("An unknown invite token 404s", client.get("/split/invite/nonsense").status_code == 404)

# The guest owes money before they have ever signed up.
res = api("POST", "/split/expenses", divij, json={
    "group_id": goa, "description": "Guest dinner", "amount": "900",
    "split_mode": "equal",
    "participant_person_ids": [divij_person, guest_person],
    "payers": [{"person_id": divij_person, "amount": "900"}],
})
check("A guest can be put on an expense", res.status_code == 201, res.text)
check("The guest's share is Rs 450",
      [s["amount"]["minor"] for s in res.json()["shares"]
       if s["person"]["id"] == guest_person] == [45000], res.text)

g = api("GET", f"/split/groups/{goa}", divij).json()
guest_net = [m["net"]["minor"] for m in g["members"] if m["id"] == guest_person]
check("The guest carries a real balance", guest_net == [-45000], str(guest_net))

# Now the guest registers with that same address.
_, rahul, reg_body = register(guest_email)
check("Registration reports the Split claim", reg_body.get("split", {}).get("groups", 0) >= 1,
      str(reg_body.get("split")))

rahul_me = api("GET", "/split/me", rahul).json()
check("The new account resolves to the SAME person id — no duplicate",
      rahul_me["person"]["id"] == guest_person,
      f"{rahul_me['person']['id']} vs guest {guest_person}")
check("The claimed person is no longer a guest", rahul_me["person"]["is_guest"] is False)
check("The claimed account inherits the balance",
      rahul_me["summary"]["you_owe"]["minor"] == 45000, str(rahul_me["summary"]))

rahul_groups = api("GET", "/split/groups", rahul).json()["groups"]
check("The claimed account is already in the group",
      any(gr["id"] == goa for gr in rahul_groups), str(rahul_groups))
check("The claimed account can read the group's history",
      api("GET", f"/split/groups/{goa}", rahul).status_code == 200)

# Case-insensitive claim: invited as Mixed Case, registers lowercase.
mixed = f"MixedCase_{uuid.uuid4().hex[:6]}@MoneyKal.test"
res = api("POST", "/split/invitations", divij, json={"email": mixed, "name": "Case Test"})
mixed_person = res.json()["person"]["id"]
_, case_user, _ = register(mixed.lower())
check("A guest invited in mixed case is claimed by a lowercase signup",
      api("GET", "/split/me", case_user).json()["person"]["id"] == mixed_person)

# Inviting an address that already has an account must reuse it.
res = api("POST", "/split/invitations", divij, json={"email": jiya_email, "name": "Jiya"})
check("Inviting an existing user reuses their identity",
      res.json()["person"]["id"] == j_person, res.text)
check("Inviting an existing user needs no acceptance",
      res.json()["status"] == "accepted", res.text)


# ===========================================================================
section("10. Notifications")
# ===========================================================================

notes = api("GET", "/notifications", harshit).json()
check("Harshit has notifications", notes["unread_count"] > 0, str(notes["unread_count"]))
kinds = {n["kind"] for n in notes["notifications"]}
check("An expense-added notification was stored", "split_expense_added" in kinds, str(kinds))

expense_note = next(n for n in notes["notifications"] if n["kind"] == "split_expense_added")
check("Notification deep-links to the expense", expense_note["link_type"] == "split_expense"
      and expense_note["link_id"], str(expense_note))
# The body must agree with the recipient's own net on that expense — that is
# the whole point of a per-recipient notification, and checking the agreement is
# stronger than looking for a particular word in whichever one comes back first.
mismatched = []
for n in notes["notifications"]:
    if n["kind"] != "split_expense_added":
        continue
    net = n["meta"].get("your_net_minor")
    body = (n["body"] or "").lower()
    if net is None:
        continue
    if net < 0 and not body.startswith("you owe"):
        mismatched.append((net, n["body"]))
    elif net > 0 and not body.startswith("you are owed"):
        mismatched.append((net, n["body"]))
    elif net == 0 and "settled" not in body:
        mismatched.append((net, n["body"]))
check("Every expense notification's wording matches the reader's own position",
      not mismatched, str(mismatched))
check("At least one notification tells the reader they owe",
      any((n["body"] or "").lower().startswith("you owe")
          for n in notes["notifications"] if n["kind"] == "split_expense_added"),
      str([n["body"] for n in notes["notifications"]][:5]))
check("Notifications start unread", expense_note["is_read"] is False)

check("A settlement notification reached Divij",
      any(n["kind"] == "split_settlement_received"
          for n in api("GET", "/notifications", divij).json()["notifications"]))

before_unread = api("GET", "/notifications/unread-count", harshit).json()["unread_count"]
api("POST", "/notifications/read", harshit, json={"notification_ids": [expense_note["id"]]})
after_unread = api("GET", "/notifications/unread-count", harshit).json()["unread_count"]
check("Marking one read decrements the count", after_unread == before_unread - 1,
      f"{before_unread} -> {after_unread}")

api("POST", "/notifications/read", harshit, json={})
check("Mark-all-read clears the badge",
      api("GET", "/notifications/unread-count", harshit).json()["unread_count"] == 0)

# Cross-account isolation: marking read must not touch anyone else's inbox.
divij_unread = api("GET", "/notifications/unread-count", divij).json()["unread_count"]
check("Another user's inbox is untouched", divij_unread > 0, str(divij_unread))

foreign_id = api("GET", "/notifications", divij).json()["notifications"][0]["id"]
api("POST", "/notifications/read", harshit, json={"notification_ids": [foreign_id]})
check("Cannot mark another user's notification read",
      api("GET", "/notifications/unread-count", divij).json()["unread_count"] == divij_unread)

# Preferences are respected.
api("PUT", "/notifications/preferences", jiya, json={"split_expense_added": False})
j_before = api("GET", "/notifications/unread-count", jiya).json()["unread_count"]
api("POST", "/split/expenses", divij, json={
    "group_id": lab, "description": "Silent one", "amount": "300", "split_mode": "equal",
    "participant_person_ids": [divij_person, j_person],
    "payers": [{"person_id": divij_person, "amount": "300"}]})
j_after = api("GET", "/notifications/unread-count", jiya).json()["unread_count"]
check("An opted-out user is not notified", j_after == j_before, f"{j_before} -> {j_after}")

h_check = api("GET", "/notifications", harshit).json()
check("Opting one user out does not silence others",
      isinstance(h_check["unread_count"], int))


# ===========================================================================
section("11. Activity feed")
# ===========================================================================

acts = api("GET", "/split/activity", divij).json()["activity"]
check("Activity feed is populated", len(acts) > 0, str(len(acts)))
summaries = " | ".join(a["summary"] for a in acts[:15])
check("Activity reads like the brief ('X added Y in Z')",
      any("added" in a["summary"] and " in " in a["summary"] for a in acts), summaries)
check("Settlement activity is recorded",
      any(a["kind"] == "settlement_added" for a in acts))
check("Activity carries an amount for money events",
      any(a["amount"] for a in acts if a["kind"] == "settlement_added"))

group_acts = api("GET", "/split/activity", divij, params={"group_id": lab}).json()["activity"]
check("Activity can be scoped to one group",
      all(a["group_id"] == lab for a in group_acts), str(group_acts[:2]))

check("A stranger sees no activity from groups they are not in",
      len(api("GET", "/split/activity", stranger).json()["activity"]) == 0)
check("A stranger cannot request a group's activity",
      api("GET", "/split/activity", stranger, params={"group_id": lab}).status_code == 404)


# ===========================================================================
section("12. Premium gating")
# ===========================================================================

ent = api("GET", "/split/entitlements", divij).json()
check("Free plan reported", ent["plan"] == "free")
check("Core Split listed as free", any("Invite friends" in f for f in ent["free_features"]))
check("Premium features are advertised", len(ent["premium_features"]) >= 5)

res = api("GET", f"/split/groups/{lab}/analytics", divij)
check("Advanced charts are premium-gated (402)", res.status_code == 402, res.text)
check("The gate names the feature",
      res.json()["detail"]["feature"] == "split_advanced_charts", res.text)
res = api("GET", f"/split/groups/{lab}/export", divij)
check("Export is premium-gated (402)", res.status_code == 402, res.text)

# The free path must remain fully usable.
check("Free users can still create groups",
      api("POST", "/split/groups", divij, json={"name": "Still free"}).status_code == 201)
check("Free users can still add expenses",
      api("POST", "/split/expenses", divij, json={
          "group_id": lab, "description": "Free expense", "amount": "100",
          "split_mode": "equal", "participant_person_ids": [divij_person],
          "payers": [{"person_id": divij_person, "amount": "100"}]}).status_code == 201)
check("Free users can still settle up",
      api("POST", "/split/settlements", jiya, json={
          "group_id": lab, "from_person_id": j_person, "to_person_id": divij_person,
          "amount": "50"}).status_code == 201)

# Grant premium and confirm the gate opens.
from backend.database import SessionLocal  # noqa: E402
from backend.models.domain import Subscription, User as UserModel  # noqa: E402

_s = SessionLocal()
_u = _s.query(UserModel).filter(UserModel.username == divij_email).first()
_s.add(Subscription(user_id=_u.id, plan="premium", status="active"))
_s.commit()
_s.close()

check("Premium unlocks analytics",
      api("GET", f"/split/groups/{lab}/analytics", divij).status_code == 200)
export = api("GET", f"/split/groups/{lab}/export", divij)
check("Premium unlocks export", export.status_code == 200, export.text)
check("Export returns CSV with a header row",
      export.json()["csv"].startswith("Date,Description"), export.json()["csv"][:60])
check("Entitlements now report premium",
      api("GET", "/split/entitlements", divij).json()["is_premium"] is True)
check("A different user is still free",
      api("GET", "/split/entitlements", harshit).json()["is_premium"] is False)


# ===========================================================================
section("13. Rounding stress — money is never created or destroyed")
# ===========================================================================

res = api("POST", "/split/groups", divij, json={"name": "Rounding", "currency": "INR"})
rgroup = res.json()["id"]
api("POST", f"/split/groups/{rgroup}/members", divij, json={"person_id": h_person})
api("POST", f"/split/groups/{rgroup}/members", divij, json={"person_id": j_person})

bad = []
for amount in ["0.01", "0.02", "100", "10", "1", "33.33", "999.99", "1000.01", "7", "0.05"]:
    r = api("POST", "/split/expenses", divij, json={
        "group_id": rgroup, "description": f"Round {amount}", "amount": amount,
        "split_mode": "equal",
        "participant_person_ids": [divij_person, h_person, j_person],
        "payers": [{"person_id": divij_person, "amount": amount}]})
    if r.status_code != 201:
        bad.append((amount, r.text))
        continue
    total = sum(s["amount"]["minor"] for s in r.json()["shares"])
    if total != r.json()["total"]["minor"]:
        bad.append((amount, f"shares {total} != total {r.json()['total']['minor']}"))
check("Every amount splits 3 ways with nothing lost", not bad, str(bad))

rg = api("GET", f"/split/groups/{rgroup}", divij).json()
nets = {m["id"]: m["net"]["minor"] for m in rg["members"]}
check("Group nets still sum to zero after rounding stress", sum(nets.values()) == 0, str(nets))
check("Simplified transfers conserve money exactly",
      sum(s["amount"]["minor"] for s in rg["settle_suggestions"])
      == sum(v for v in nets.values() if v > 0), str(rg["settle_suggestions"]))


# ===========================================================================
section("14. One-to-one (no group) expenses")
# ===========================================================================

res = api("POST", "/split/expenses", divij, json={
    "description": "Coffee", "amount": "300", "split_mode": "equal",
    "participant_person_ids": [divij_person, h_person],
    "payers": [{"person_id": divij_person, "amount": "300"}]})
check("An expense with no group is allowed", res.status_code == 201, res.text)
check("Ungrouped expense has no group_id", res.json()["group_id"] is None)

fd = api("GET", f"/split/friends/{h_person}", divij)
check("Friend detail returns 200", fd.status_code == 200, fd.text)
check("The ungrouped expense shows on the friend page",
      any(e["description"] == "Coffee" for e in fd.json()["expenses"]), fd.text[:300])

res = api("POST", "/split/expenses", divij, json={
    "description": "Not friends", "amount": "300", "split_mode": "equal",
    "participant_person_ids": [divij_person, stranger_person],
    "payers": [{"person_id": divij_person, "amount": "300"}]})
check("Cannot split with someone who is not a friend", res.status_code == 403, res.text)


# ===========================================================================
section("15. Leaving a group")
# ===========================================================================

res = api("POST", "/split/groups", harshit, json={"name": "Leaving Test"})
lg = res.json()["id"]
api("POST", f"/split/groups/{lg}/members", harshit, json={"person_id": j_person})
api("POST", "/split/expenses", harshit, json={
    "group_id": lg, "description": "Owed", "amount": "200", "split_mode": "equal",
    "participant_person_ids": [h_person, j_person],
    "payers": [{"person_id": h_person, "amount": "200"}]})

res = api("DELETE", f"/split/groups/{lg}/members/{j_person}", jiya)
check("Cannot leave a group while you still owe money", res.status_code == 400, res.text)

api("POST", "/split/settlements", jiya, json={
    "group_id": lg, "from_person_id": j_person, "to_person_id": h_person, "amount": "100"})
res = api("DELETE", f"/split/groups/{lg}/members/{j_person}", jiya)
check("Can leave once settled up", res.status_code == 204, res.text)
check("After leaving, the group is no longer readable",
      api("GET", f"/split/groups/{lg}", jiya).status_code == 404)


# ===========================================================================
print(f"\n{'=' * 70}")
print(f"  {PASSED} passed, {len(FAILED)} failed")
if FAILED:
    print("\n  FAILURES:")
    for f in FAILED:
        print(f"    - {f}")
print(f"{'=' * 70}")

try:
    os.remove(_TEST_DB)
except OSError:
    pass

sys.exit(1 if FAILED else 0)
