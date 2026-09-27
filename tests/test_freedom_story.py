"""
Freedom story — unit test.

build_freedom_story() explains the Freedom Balance: the flow from income to
what is left, what is shaping it, what would change it, and a plain-language
reading. It promises three things, and these checks hold it to them on
synthetic profiles covering every reading it can give:

  1. It never changes the balance. The story's figure is the balance's figure.
  2. Its parts add back up. Income - committed - spent - held = the balance,
     and the committed rows sum to the committed total.
  3. Every what-if is the balance's own rule with one input moved:
     max(0, min(flow + flow_delta, stock + stock_delta)).

No database or server is needed; the context is built from plain objects.

Run with:  python tests/test_freedom_story.py
"""
import os
import sys
from datetime import date, datetime
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.services.home_service import HomeContext  # noqa: E402
from backend.services import live_life_service as lls  # noqa: E402

TODAY = date(2026, 9, 17)
PASSED, FAILED = 0, []


def check(label, cond, detail=""):
    global PASSED
    if cond:
        PASSED += 1
        print(f"  PASS  {label}")
    else:
        FAILED.append(label)
        print(f"  FAIL  {label}  {detail}")


# ---------------------------------------------------------------------------
# Synthetic profiles
# ---------------------------------------------------------------------------

def txn(kind, category, amount, day):
    return SimpleNamespace(type=kind, category=category, amount=amount, txn_date=day)


def payment(pid, name, amount, due, category, event_type, recurrence="monthly"):
    return SimpleNamespace(id=pid, name=name, amount=amount, due_date=due, category=category,
                           event_type=event_type, recurrence=recurrence, direction="out",
                           status="confirmed", is_active=True)


def goal(gid, name, target, current, target_date, category="travel"):
    return SimpleNamespace(id=gid, name=name, target_amount=target, current_amount=current,
                           target_date=target_date, category=category, icon=None,
                           is_primary=False, status="active", created_at=datetime(2026, 1, 1))


def ledger_months(spent_this_month=8400):
    """Three complete months of essentials and fun, plus this month's fun so far."""
    rows = []
    for month in (6, 7, 8):
        rows += [txn("out", "Rent / Housing", 35000, date(2026, month, 5)),
                 txn("out", "Groceries", 9000, date(2026, month, 10)),
                 txn("out", "Utilities & Bills", 4000, date(2026, month, 12)),
                 txn("out", "Subscriptions", 1500, date(2026, month, 14)),
                 txn("out", "Food & Dining", 8000, date(2026, month, 20)),
                 txn("in", "Salary", 185000, date(2026, month, 1))]
    if spent_this_month:
        rows.append(txn("out", "Food & Dining", spent_this_month, date(2026, 9, 3)))
    return rows


def calendar():
    return [
        payment(1, "Home loan", 22000, date(2026, 8, 5), "EMI / Loan", "emi"),
        payment(2, "Netflix", 649, date(2026, 8, 20), "Entertainment", "subscription"),
        # Inside essentials already: must never be counted a second time.
        payment(3, "Electricity", 2500, date(2026, 8, 25), "Utilities & Bills", "bill"),
        # Yearly: real this window, but never offered as "a month".
        payment(4, "Car insurance", 18000, date(2026, 9, 27), "Insurance", "insurance", "yearly"),
        payment(5, "Index fund SIP", 10000, date(2026, 8, 10), "Investments", "investment"),
    ]


def context(income=185000, savings=940000, expenses=55000, txns=None, upcoming=None, goals=None):
    fin = SimpleNamespace(income=income, expenses=expenses, savings=savings,
                          monthly_savings_rate=income - expenses)
    return HomeContext(profile=SimpleNamespace(currency="₹"), currency="₹", fin=fin,
                       transactions=ledger_months() if txns is None else txns,
                       goals=[goal(10, "Japan trip", 400000, 145000, date(2027, 7, 17))]
                       if goals is None else goals,
                       upcoming=calendar() if upcoming is None else upcoming,
                       today=TODAY)


SCENARIOS = {
    "comfortable": lambda: context(),
    "held_back": lambda: context(savings=220000),
    "protecting": lambda: context(savings=150000),
    "overcommitted": lambda: context(income=100000),
    "used_up": lambda: context(txns=ledger_months(spent_this_month=60000)),
    "stated_only": lambda: context(income=80000, expenses=50000, savings=300000,
                                   txns=[], upcoming=[], goals=[]),
    "insufficient": lambda: context(savings=0),
}


def build(name):
    ctx = SCENARIOS[name]()
    freedom = lls.build_freedom_balance(ctx)
    return ctx, freedom, lls.build_freedom_story(ctx, freedom)


# ---------------------------------------------------------------------------
# Invariants every ready story must hold
# ---------------------------------------------------------------------------

def invariants(name, freedom, story):
    f = story["flow"]
    close = lambda a, b: abs(a - b) < 0.02

    check(f"[{name}] the story quotes the balance, unchanged",
          story["value"] == freedom["value"] and f["free"]["amount"] == freedom["value"])

    committed_rows = [s for s in story["shapers"] if s["kind"] == "committed"]
    check(f"[{name}] committed rows add up to the committed total",
          close(sum(s["amount"] for s in committed_rows), f["committed"]["amount"]),
          f"{sum(s['amount'] for s in committed_rows)} vs {f['committed']['amount']}")

    held = f["held"]["amount"] if f["held"] else 0.0
    over = f["over"]["amount"] if f["over"] else 0.0
    rebuilt = f["income"]["amount"] - f["committed"]["amount"] - f["spent"]["amount"] - held + over
    check(f"[{name}] income - committed - spent - held (+ shortfall) = the balance",
          close(rebuilt, freedom["value"]), f"{rebuilt} vs {freedom['value']}")

    check(f"[{name}] rows are ranked largest first",
          [s["amount"] for s in committed_rows] == sorted((s["amount"] for s in committed_rows),
                                                          reverse=True))

    base = story["base"]
    for lever in story["levers"]:
        expect = round(max(0.0, min(base["flow"] + lever["flow_delta"],
                                    base["stock"] + lever["stock_delta"])), 2)
        check(f"[{name}] lever '{lever['title']}' re-applies the balance's own rule",
              close(lever["new_value"], expect), f"{lever['new_value']} vs {expect}")
        check(f"[{name}] lever '{lever['title']}' actually moves something",
              lever["delta"] >= 1 or (lever["closes_gap"] or 0) >= 1, str(lever))
    check(f"[{name}] at most {lls.MAX_LEVERS} levers", len(story["levers"]) <= lls.MAX_LEVERS)
    check(f"[{name}] there is a plain-language reading",
          len(story["interpretation"]) >= 2 and all(p.strip() for p in story["interpretation"]))


print("=" * 66)
print("Freedom story")
print("=" * 66)

for name in SCENARIOS:
    if name == "insufficient":
        continue
    ctx, freedom, story = build(name)
    check(f"[{name}] story is ready", story["status"] == "ready", story.get("status"))
    invariants(name, freedom, story)

# ---- comfortable: the full ledger profile ----
ctx, freedom, story = build("comfortable")
labels = {s["key"]: s for s in story["shapers"]}
check("Reads as comfortable at ~68% committed",
      story["state"] == "comfortable" and 60 < story["committed_share"] <= 70,
      f"{story['state']} {story['committed_share']}")
check("Income set the number, so the lead says 'of your monthly income'",
      story["lead"] == "of_income")
check("Essentials are split into housing, groceries, bills and subscriptions",
      all(k in labels for k in ("housing", "groceries", "bills", "subscriptions")), list(labels))
check("A calendar subscription merges with logged subscriptions into one row",
      abs(labels["subscriptions"]["amount"] - (1500 + 649)) < 0.02
      and "Netflix" in (labels["subscriptions"]["note"] or ""), str(labels["subscriptions"]))
check("An essential-category bill on the calendar is not counted twice",
      abs(labels["bills"]["amount"] - 4000) < 0.02, str(labels["bills"]))
check("EMIs, insurance, SIPs and goals each get their own row",
      all(k in labels for k in ("emis", "insurance", "investments", "goals")), list(labels))
check("Goal contributions are marked as saving, not spending", labels["goals"]["is_saving"])
check("This month's spending is shown separately from commitments",
      labels["spent"]["kind"] == "spent" and abs(labels["spent"]["amount"] - 8400) < 0.02)
check("Nothing is held back when income is the limit", story["flow"]["held"] is None)
keys = [l["key"] for l in story["levers"]]
check("Levers come from the user's own data first", keys[:3] == ["subscription", "emi", "goal"], keys)
check("A yearly payment in this window is labelled with its due date",
      "Car insurance, due 27 Sep" in (labels["insurance"]["note"] or ""), labels["insurance"]["note"])
check("A yearly payment is never offered as a monthly saving",
      not any("Car insurance" in l["title"] for l in story["levers"]))
check("No lever suggests cutting rent",
      not any("housing" in l["title"].lower() for l in story["levers"]))
check("No savings top-up is suggested when savings are not the limit", "savings" not in keys)

# ---- held back: savings cap the balance below what income allows ----
ctx, freedom, story = build("held_back")
keys = [l["key"] for l in story["levers"]]
check("Savings-limited balance shows what is held back",
      story["flow"]["held"] and story["flow"]["held"]["amount"] > 0)
check("The lead no longer claims the figure is 'of your monthly income'",
      story["lead"] == "this_month")
check("The savings top-up leads the levers when savings are the limit",
      keys and keys[0] == "savings", keys)
check("Income-only levers are left out when they would not move the number",
      "income" not in keys and "goal" not in keys, keys)
check("The reading explains the hold-back",
      any("held back" in p for p in story["interpretation"]))

# ---- protecting: income has room, buffer does not ----
ctx, freedom, story = build("protecting")
check("Zero balance with room in income reads as protecting the safety net",
      story["state"] == "protecting" and freedom["value"] == 0, story["state"])
check("Topping up savings would release the income's room",
      story["levers"] and story["levers"][0]["key"] == "savings"
      and abs(story["levers"][0]["new_value"] - freedom["flow"]["value"]) < 0.02)
check("The reading never calls a buffer that fails the savings test 'above the safety line'",
      not any("above the" in p for p in story["interpretation"]), story["interpretation"])

# ---- overcommitted ----
ctx, freedom, story = build("overcommitted")
check("Commitments above income read as overcommitted",
      story["state"] == "overcommitted" and story["flow"]["over"], story["state"])
check("The reading never claims a shortfall month is 'not borrowed from your future'",
      not any("borrowed" in p for p in story["interpretation"]), story["interpretation"])
check("Levers report how much of the shortfall they close",
      story["levers"] and all(l["closes_gap"] for l in story["levers"]),
      [(l["key"], l["closes_gap"]) for l in story["levers"]])

# ---- used up ----
ctx, freedom, story = build("used_up")
check("Room spent before month end reads as used up", story["state"] == "used_up", story["state"])

# ---- stated only ----
ctx, freedom, story = build("stated_only")
labels = {s["key"]: s for s in story["shapers"]}
check("With no ledger, essentials stay one honest row",
      list(labels) == ["essentials"], list(labels))
check("Stated-only profiles still get levers (a raise, trimmed essentials)",
      {l["key"] for l in story["levers"]} == {"income", "essentials"},
      [l["key"] for l in story["levers"]])

# ---- insufficient data ----
ctx, freedom, story = build("insufficient")
check("Missing data gives no number and says what is missing",
      story["status"] == "insufficient_data" and story["missing"]
      and "value" not in story, str(story))

print("=" * 66)
print(f"  {PASSED} passed, {len(FAILED)} failed")
for f in FAILED:
    print("    -", f)
print("=" * 66)
sys.exit(1 if FAILED else 0)
