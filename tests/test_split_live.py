"""
Money Splits — live-server smoke test.

Companion to test_split_feature.py, which runs the app in-process against a
throwaway database. This one goes over real HTTP to a server started the way
the website talks to it, so it also exercises CORS, the uvicorn stack and the
actual twin.db schema rather than a freshly created one.

Deliberately narrow: it walks the single journey the brief describes end to end
— two real users create a group, split a bill, invite someone who has no
account, that person signs up and inherits their balance, and everyone settles
up. Correctness of the split modes is covered exhaustively by the other suite.

Requires the API on 127.0.0.1:8000.  Run with:  python tests/test_split_live.py
"""
import sys
import uuid

import requests

BASE = "http://127.0.0.1:8000"
PASSWORD = "Password123!"

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


def register(email):
    r = requests.post(f"{BASE}/auth/register", json={"username": email, "password": PASSWORD})
    r.raise_for_status()
    b = r.json()
    return {"Authorization": f"Bearer {b['access_token']}"}, b


def call(method, path, headers=None, **kw):
    return requests.request(method, f"{BASE}{path}", headers=headers, timeout=15, **kw)


print("=" * 70)
print("Money Splits — live server journey")
print("=" * 70)

try:
    requests.get(f"{BASE}/health", timeout=5).raise_for_status()
except Exception as e:
    print(f"\n  The API is not reachable at {BASE} — start it first.\n  {e}")
    sys.exit(2)

tag = uuid.uuid4().hex[:8]
divij_email = f"live_divij_{tag}@moneykal.test"
harshit_email = f"live_harshit_{tag}@moneykal.test"
guest_email = f"live_rahul_{tag}@moneykal.test"

divij, _ = register(divij_email)
harshit, _ = register(harshit_email)

d_id = call("GET", "/split/me", divij).json()["person"]["id"]
h_id = call("GET", "/split/me", harshit).json()["person"]["id"]
check("Both accounts resolve to Split identities", isinstance(d_id, int) and isinstance(h_id, int))

# --- Create the group and pull Harshit in ---------------------------------
gid = call("POST", "/split/groups", divij,
           json={"name": f"Goa Trip {tag}", "group_type": "trip",
                 "emoji": "\U0001f3d6", "currency": "INR"}).json()["id"]
call("POST", f"/split/groups/{gid}/members", divij, json={"person_id": h_id})
check("Group created with two members",
      len(call("GET", f"/split/groups/{gid}", divij).json()["members"]) == 2)

# --- Invite someone who has never heard of MoneyKal ------------------------
inv = call("POST", "/split/invitations", divij,
           json={"email": guest_email, "name": "Rahul", "group_id": gid}).json()
guest_id = inv["person"]["id"]
check("Guest exists before signing up", inv["person"]["is_guest"] is True)

preview = requests.get(f"{BASE}/split/invite/{inv['token']}", timeout=10)
check("Invite link previews without a login", preview.status_code == 200, preview.text)
check("Preview names the group", preview.json()["group"]["name"] == f"Goa Trip {tag}")

# --- The worked example from the brief -------------------------------------
exp = call("POST", "/split/expenses", divij, json={
    "group_id": gid, "description": "Dinner", "amount": "3000", "split_mode": "equal",
    "participant_person_ids": [d_id, h_id, guest_id],
    "payers": [{"person_id": d_id, "amount": "3000"}],
    "client_token": f"live-{tag}-1",
}).json()
check("Rs 3,000 split three ways", exp["total"]["display"] == "₹3,000.00", str(exp["total"]))
check("Divij is owed Rs 2,000", exp["your_net"]["minor"] == 200000, str(exp["your_net"]))
check("Shares sum to exactly the total",
      sum(s["amount"]["minor"] for s in exp["shares"]) == 300000)

g = call("GET", f"/split/groups/{gid}", divij).json()
nets = {m["id"]: m["net"]["minor"] for m in g["members"]}
check("Divij +2000 / Harshit -1000 / Rahul -1000",
      nets == {d_id: 200000, h_id: -100000, guest_id: -100000}, str(nets))
check("Nets sum to zero", sum(nets.values()) == 0)

# --- A second, harder expense ----------------------------------------------
call("POST", "/split/expenses", harshit, json={
    "group_id": gid, "description": "Hotel", "amount": "10000", "split_mode": "percent",
    "participant_person_ids": [d_id, h_id, guest_id],
    "split_values": {str(d_id): "50", str(h_id): "30", str(guest_id): "20"},
    "payers": [{"person_id": h_id, "amount": "6000"}, {"person_id": d_id, "amount": "4000"}],
    "client_token": f"live-{tag}-2",
})
g = call("GET", f"/split/groups/{gid}", divij).json()
check("Multi-payer percentage expense keeps the books balanced",
      sum(m["net"]["minor"] for m in g["members"]) == 0,
      str({m["name"]: m["net"]["minor"] for m in g["members"]}))
check("Group total is Rs 13,000", g["summary"]["total_spent"]["minor"] == 1300000,
      str(g["summary"]["total_spent"]))

# --- Notifications reached the other people --------------------------------
hn = call("GET", "/notifications", harshit).json()
check("Harshit was notified", hn["unread_count"] > 0, str(hn["unread_count"]))
check("A notification deep-links to the expense",
      any(n["link_type"] == "split_expense" for n in hn["notifications"]))

# --- The guest signs up and inherits everything ----------------------------
rahul, reg = register(guest_email)
rahul_me = call("GET", "/split/me", rahul).json()
check("Signing up claims the guest — no duplicate person",
      rahul_me["person"]["id"] == guest_id,
      f"{rahul_me['person']['id']} vs {guest_id}")
check("The new account is no longer a guest", rahul_me["person"]["is_guest"] is False)
check("The new account inherits its balance",
      rahul_me["summary"]["you_owe"]["minor"] == 300000, str(rahul_me["summary"]))
check("The new account is already in the group",
      any(x["id"] == gid for x in call("GET", "/split/groups", rahul).json()["groups"]))
check("Registration reported the claim", reg.get("split", {}).get("groups", 0) >= 1,
      str(reg.get("split")))

# --- Settle up --------------------------------------------------------------
# Rahul is the only debtor (-3000) and there are two creditors (Harshit +2000,
# Divij +1000), so simplification correctly produces two transfers, not one.
owed = [t for t in g["settle_suggestions"] if t["from"]["id"] == guest_id]
check("Rahul owes both creditors", len(owed) == 2, str(g["settle_suggestions"]))
check("Rahul's suggested payments total what he owes",
      sum(t["amount"]["minor"] for t in owed) == 300000, str(owed))

part = call("POST", "/split/settlements", rahul, json={
    "group_id": gid, "from_person_id": guest_id, "to_person_id": d_id,
    "amount": "1000", "method": "upi", "client_token": f"live-{tag}-s1"})
check("Partial settlement accepted", part.status_code == 201, part.text)

after = call("GET", "/split/me", rahul).json()
check("Partial settlement reduced what Rahul owes",
      after["summary"]["you_owe"]["minor"] == 200000, str(after["summary"]))
check("Divij was told he was paid",
      any(n["kind"] == "split_settlement_received"
          for n in call("GET", "/notifications", divij).json()["notifications"]))

over = call("POST", "/split/settlements", rahul, json={
    "group_id": gid, "from_person_id": guest_id, "to_person_id": d_id, "amount": "999999"})
check("Overpaying is refused", over.status_code == 400, over.text)

# --- Authorization over the wire -------------------------------------------
outsider, _ = register(f"live_outsider_{tag}@moneykal.test")
check("An outsider cannot read the group",
      call("GET", f"/split/groups/{gid}", outsider).status_code == 404)
check("An outsider cannot read the expense",
      call("GET", f"/split/expenses/{exp['id']}", outsider).status_code == 404)
check("An unauthenticated request is rejected",
      call("GET", f"/split/groups/{gid}").status_code == 401)
check("A garbage token is rejected",
      call("GET", "/split/me", {"Authorization": "Bearer not-a-token"}).status_code == 401)

# --- Idempotency over the wire ---------------------------------------------
a = call("POST", "/split/expenses", divij, json={
    "group_id": gid, "description": "Retry", "amount": "500", "split_mode": "equal",
    "participant_person_ids": [d_id, h_id],
    "payers": [{"person_id": d_id, "amount": "500"}],
    "client_token": f"live-{tag}-dup"}).json()
b = call("POST", "/split/expenses", divij, json={
    "group_id": gid, "description": "Retry", "amount": "500", "split_mode": "equal",
    "participant_person_ids": [d_id, h_id],
    "payers": [{"person_id": d_id, "amount": "500"}],
    "client_token": f"live-{tag}-dup"}).json()
check("A retried request does not double-book", a["id"] == b["id"])

# --- Activity ---------------------------------------------------------------
acts = call("GET", "/split/activity", divij).json()["activity"]
check("Activity feed reads correctly",
      any("added Dinner in" in a["summary"] for a in acts),
      " | ".join(a["summary"] for a in acts[:5]))

# --- Regression: the rest of the API still answers -------------------------
# 404 is this endpoint's own pre-existing answer for an account that has not
# completed onboarding, which these throwaway test users never do. The point of
# the check is that it still answers rather than erroring.
check("Existing /profile/me still answers",
      call("GET", "/profile/me", divij).status_code in (200, 404))
check("Existing /home still works", call("GET", "/home", divij).status_code in (200, 404))
check("Login still works",
      requests.post(f"{BASE}/auth/login",
                    json={"username": divij_email, "password": PASSWORD}).status_code == 200)

print("=" * 70)
print(f"  {PASSED} passed, {len(FAILED)} failed")
if FAILED:
    print("\n  FAILURES:")
    for f in FAILED:
        print(f"    - {f}")
print("=" * 70)
sys.exit(1 if FAILED else 0)
