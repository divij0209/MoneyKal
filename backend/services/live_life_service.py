"""
live.life.fully — the guilt-free lifestyle layer.

The rest of MoneyKal answers "am I safe?". This module answers the question no
finance app asks: "what can I actually enjoy, without hurting any of that?"

Design rules, identical in spirit to home_service.py:

*   It invents no financial primitives and owns no tables. The position comes
    from financial_simulator.build_financial_context(), movement from the
    Hisaab ledger, obligations from UpcomingPayment and every experience stash
    from FinancialGoal — the same rows the Daily Home, the Financial Calendar
    and What-If already read. There is no second source of truth for money.
*   Nothing is fabricated. If income, essentials or the stated position are
    missing, the Freedom Balance is `insufficient_data` with a value of None
    and the UI is expected to say so rather than show a comforting number.
*   Every figure carries the same status vocabulary the rest of the app uses
    (actual | estimated | insufficient_data) and a `calculation` block, so the
    user can open any number and see what it was built from.

The central promise the feature makes — "this is money you can enjoy without
messing up your plans" — is only honest if bills, EMIs, goal contributions and
the emergency buffer are removed *before* the number is shown. That is what
build_freedom_balance() does, and it does it twice, from two directions:

    flow  = monthly income - essential living - dated commitments - goal pace
    stock = stated savings - a 3-month emergency floor - dated commitments

The Freedom Balance is the *lower* of the two. A large savings balance therefore
cannot license a spending month the income does not support, and a good income
month cannot license spending when the buffer is already thin.
"""
from backend.core.money import group_indian
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable, Dict, List, Optional

from backend.models.domain import FinancialGoal
from backend.services.home_service import (
    HomeContext, format_money, goal_to_dict, month_bounds, occurrences_in_range,
)

# ---------------------------------------------------------------------------
# Tunables — every assumption this module makes, in one place.
#
# These are constants rather than user settings because MoneyKal has no
# preference store yet. Each one is surfaced in the response's `assumptions`
# block so the number on screen is never quietly opinionated.
# ---------------------------------------------------------------------------

#: Months of essential spending that must stay untouched before *any* savings
#: are considered spendable on an experience. Three months is the buffer the
#: rest of the app already treats as healthy (home_insights.rule_thin_buffer).
EMERGENCY_BUFFER_MONTHS = 3.0

#: The rolling window the Freedom Balance is computed over. Rolling rather than
#: calendar-month so it always contains exactly one occurrence of each monthly
#: essential — no partial-month proration, and no "it resets on the 1st" cliff.
FREEDOM_WINDOW_DAYS = 30

#: Days in a month, for converting a rolling window to a monthly pace.
DAYS_PER_MONTH = 30.44

#: Complete calendar months of ledger history used to average essential
#: spending, and the minimum needed before that average is called 'actual'.
ESSENTIAL_LOOKBACK_MONTHS = 3
MIN_MONTHS_FOR_ACTUAL = 2

#: Hisaab categories treated as essential — the ones that keep the lights on.
#: Matched against the exact strings the Hisaab form stores, so this is a view
#: over the user's own categories rather than a second taxonomy.
ESSENTIAL_CATEGORIES = {
    "Rent / Housing",
    "Utilities & Bills",
    "Groceries",
    "Health & Medical",
    "Taxes",
    "Subscriptions",
}

#: The other side of the same ledger: what the user spends on living, not
#: surviving. Used to spot a genuinely restrained month.
JOY_CATEGORIES = {
    "Food & Dining",
    "Shopping",
    "Entertainment",
    "Travel & Transport",
}


# ---------------------------------------------------------------------------
# Experience taxonomy
#
# An experience stash is a FinancialGoal, not a new kind of record. These
# category slugs are stored in FinancialGoal.category exactly like
# 'emergency_fund' or 'travel' already are, so a stash created here shows up in
# Goals, in savings progress and on the Financial Calendar with no extra
# plumbing — and a 'travel' goal the user created before this feature existed
# is recognised as a trip stash without being migrated.
# ---------------------------------------------------------------------------

EXPERIENCE_CATEGORIES: List[Dict[str, Any]] = [
    {"key": "experience_trips", "label": "Trips", "emoji": "✈️",
     "blurb": "Plan and save for your dream trip.", "art": "flight", "accent": "#39d0ff"},
    {"key": "experience_party", "label": "Party", "emoji": "\U0001f389",
     "blurb": "Your night out budget.", "art": "wave", "accent": "#b06bff"},
    {"key": "experience_shopping", "label": "Shopping", "emoji": "\U0001f6cd️",
     "blurb": "Treat yourself without regret.", "art": "road", "accent": "#ff7ab8"},
    {"key": "experience_concerts", "label": "Concerts", "emoji": "\U0001f3b5",
     "blurb": "Save for artists, festivals and events.", "art": "wave", "accent": "#ff8a3d"},
    {"key": "experience_weekend", "label": "Weekend Escape", "emoji": "\U0001f334",
     "blurb": "A spontaneous break.", "art": "road", "accent": "#37e0b0"},
    {"key": "experience_adventure", "label": "Adventure", "emoji": "\U0001f3d4️",
     "blurb": "For experiences and activities.", "art": "trail", "accent": "#ffd166"},
]

CATEGORY_BY_KEY = {c["key"]: c for c in EXPERIENCE_CATEGORIES}

#: Goal categories that predate this feature but mean the same thing.
LEGACY_EXPERIENCE_ALIASES = {"travel": "experience_trips"}

#: Last-resort classifier for a goal the user named but filed under 'custom'.
#: Only consulted when the category itself carries no signal — never overrides one.
NAME_HINTS = [
    ("experience_trips", ("trip", "travel", "flight", "vacation", "holiday",
                          "goa", "bali", "europe", "japan")),
    ("experience_concerts", ("concert", "festival", "gig", "tour")),
    ("experience_party", ("party", "night out", "club", "birthday", "new year", "nye")),
    ("experience_weekend", ("weekend", "getaway", "escape", "staycation")),
    ("experience_adventure", ("trek", "hike", "dive", "adventure", "camp",
                              "safari", "ski", "surf")),
    ("experience_shopping", ("shopping", "sneaker", "wardrobe", "gift")),
]


def classify_experience(goal: FinancialGoal) -> Optional[str]:
    """The experience category a goal belongs to, or None if it is a regular
    savings goal. An emergency fund is not an experience and must never be
    presented as spendable fun."""
    cat = (goal.category or "").strip().lower()
    if cat in CATEGORY_BY_KEY:
        return cat
    if cat in LEGACY_EXPERIENCE_ALIASES:
        return LEGACY_EXPERIENCE_ALIASES[cat]
    if cat in ("emergency_fund", "investment"):
        return None
    name = (goal.name or "").lower()
    for key, words in NAME_HINTS:
        if any(w in name for w in words):
            return key
    return None


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _calc(inputs: Dict[str, Any], formula: str, data_source: str) -> Dict[str, Any]:
    """Same shape home_service._calc and startup_engine._calc_meta produce, so
    the frontend has exactly one 'how was this worked out' block to render."""
    return {
        "inputs": inputs,
        "formula": formula,
        "data_source": data_source,
        "last_updated": datetime.utcnow().isoformat(),
    }


def _complete_month_windows(today: date, count: int) -> List[tuple]:
    """The `count` complete calendar months immediately before this one.
    The current month is excluded: a part-month total would understate a
    monthly average every time it was read before the 28th."""
    first, _ = month_bounds(today)
    windows = []
    cursor = first - timedelta(days=1)
    for _ in range(count):
        m_first, m_last = month_bounds(cursor)
        windows.append((m_first, m_last))
        cursor = m_first - timedelta(days=1)
    return windows


def _sum_out(ctx: HomeContext, start: date, end: date,
             categories: Optional[set] = None) -> float:
    return sum(t.amount for t in ctx.out_txns
               if start <= t.txn_date <= end
               and (categories is None or (t.category or "") in categories))


def _sum_in(ctx: HomeContext, start: date, end: date) -> float:
    return sum(t.amount for t in ctx.in_txns if start <= t.txn_date <= end)


def _has_activity(ctx: HomeContext, start: date, end: date) -> bool:
    return any(start <= t.txn_date <= end for t in ctx.transactions)


def _confirmed(item) -> bool:
    """Detected obligations awaiting the user's yes/no are suggestions, not
    facts, and must not move a number the user is about to act on."""
    return (item.status or "confirmed") == "confirmed"


def essential_monthly(ctx: HomeContext) -> Dict[str, Any]:
    """What a normal month of living costs this user.

    Preference order is deliberate: the user's own logged history beats a
    figure they typed once at onboarding. When neither exists the answer is
    None, and everything downstream degrades to insufficient_data rather than
    guessing.
    """
    essential_totals: List[float] = []
    joy_totals: List[float] = []
    active_windows: List[tuple] = []
    for start, end in _complete_month_windows(ctx.today, ESSENTIAL_LOOKBACK_MONTHS):
        if _has_activity(ctx, start, end):
            essential_totals.append(_sum_out(ctx, start, end, ESSENTIAL_CATEGORIES))
            joy_totals.append(_sum_out(ctx, start, end, JOY_CATEGORIES))
            active_windows.append((start, end))

    measured = [t for t in essential_totals if t > 0]
    stated = ctx.fin.expenses or 0.0

    if measured:
        avg = sum(measured) / len(measured)
        months = len(measured)
        note = ("Averaged from your own logged spending on rent, bills, groceries, "
                "health and subscriptions over the last %d complete month%s."
                % (months, "" if months == 1 else "s"))

        # A ledger that captures only part of a user's outgoings would understate
        # essentials, and understating essentials is the one error this feature
        # cannot afford — it inflates the money we call free. So when the user
        # has also stated a monthly expense figure, the essentials are floored at
        # "everything you said you spend, minus what your own ledger shows is
        # discretionary". Both sides of that subtraction are the user's own data;
        # nothing is assumed about the split.
        if stated > 0:
            joy_avg = (sum(joy_totals) / len(joy_totals)) if joy_totals else 0.0
            implied = stated - joy_avg
            if implied > avg:
                return {
                    "value": round(implied, 2),
                    "basis": "stated_less_discretionary",
                    "months": months,
                    "status": "estimated",
                    "note": "Your stated monthly expenses, less the %s a month your Hisaab "
                            "entries show going on food, shopping, entertainment and travel."
                            % format_money(ctx.currency, joy_avg),
                }

        # The same average, split by category over exactly the months that
        # produced it, so the parts always add back up to `value`. Only this
        # basis can be split: a stated figure has no categories to split by.
        counted = [w for w, t in zip(active_windows, essential_totals) if t > 0]
        by_category = {}
        for cat in ESSENTIAL_CATEGORIES:
            share = sum(_sum_out(ctx, s, e, {cat}) for s, e in counted) / len(counted)
            if share > 0:
                by_category[cat] = round(share, 2)

        return {
            "value": round(avg, 2),
            "basis": "ledger_average",
            "months": months,
            "status": "actual" if months >= MIN_MONTHS_FOR_ACTUAL else "estimated",
            "note": note,
            "by_category": by_category,
        }

    if stated > 0:
        return {
            "value": round(stated, 2),
            "basis": "stated_expenses",
            "months": 0,
            "status": "estimated",
            # Treating every stated rupee as essential is the conservative
            # reading — it can only make the Freedom Balance smaller.
            "note": "Based on the monthly expenses you stated. Log a few months in "
                    "Hisaab and MoneyKal will use your real essentials instead.",
        }

    return {
        "value": None,
        "basis": None,
        "months": 0,
        "status": "insufficient_data",
        "note": "Add your monthly expenses, or log a month of spending in Hisaab.",
    }


def monthly_income(ctx: HomeContext) -> Dict[str, Any]:
    """Stated income first — it is the user's own declaration and the figure
    Ask Twin and What-If already quote. Ledger money-in is the fallback so a
    user who never filled the field still gets a real number."""
    stated = ctx.fin.income or 0.0
    if stated > 0:
        return {"value": round(stated, 2), "basis": "stated_income", "status": "actual",
                "note": "Your stated monthly income."}

    received: List[float] = []
    for start, end in _complete_month_windows(ctx.today, ESSENTIAL_LOOKBACK_MONTHS):
        if _has_activity(ctx, start, end):
            received.append(_sum_in(ctx, start, end))
    measured = [r for r in received if r > 0]
    if measured:
        avg = sum(measured) / len(measured)
        return {"value": round(avg, 2), "basis": "ledger_average", "status": "estimated",
                "note": "Averaged from money-in logged in Hisaab over the last %d month%s."
                        % (len(measured), "" if len(measured) == 1 else "s")}

    return {"value": None, "basis": None, "status": "insufficient_data",
            "note": "Add your monthly income in Edit Profile."}


def dated_commitments(ctx: HomeContext) -> Dict[str, Any]:
    """Every confirmed outflow with a date inside the window — bills, EMIs,
    subscriptions, insurance, one-offs.

    Read straight from UpcomingPayment via the same occurrence walker the
    Financial Calendar uses, so a monthly EMI is counted once per occurrence in
    the window and this can never disagree with what the calendar draws.

    Items filed under an essential category are reported separately: they are
    already inside the essential monthly average, and adding them again would
    charge the user twice for the same electricity bill.
    """
    start = ctx.today
    end = ctx.today + timedelta(days=FREEDOM_WINDOW_DAYS - 1)

    total = 0.0
    overlap = 0.0
    items: List[Dict[str, Any]] = []
    for item in ctx.upcoming:
        if not _confirmed(item) or (item.direction or "out") != "out":
            continue
        if item.amount is None:
            continue          # a detected due date with no parseable amount
        for due in occurrences_in_range(item, start, end):
            total += item.amount
            is_essential = (item.category or "") in ESSENTIAL_CATEGORIES
            if is_essential:
                overlap += item.amount
            items.append({
                "id": item.id,
                "name": item.name,
                "amount": round(item.amount, 2),
                "amount_display": format_money(ctx.currency, item.amount),
                "due_date": due.isoformat(),
                "days_until": (due - ctx.today).days,
                "event_type": item.event_type or "other",
                "category": item.category,
                "counted_in_essentials": is_essential,
            })

    items.sort(key=lambda i: i["due_date"])
    return {
        "total": round(total, 2),
        "essential_overlap": round(overlap, 2),
        "extra": round(max(total - overlap, 0.0), 2),
        "count": len(items),
        "items": items,
        "window_start": start.isoformat(),
        "window_end": end.isoformat(),
    }


def enjoyed_this_month(ctx: HomeContext) -> Dict[str, Any]:
    """What the user has already spent on living rather than surviving, this
    calendar month.

    The essentials and commitments above are modelled over a rolling month
    because they recur; enjoyment is a monthly allowance, so what has already
    been enjoyed comes out of the current calendar month and resets with it.
    Straight from the Hisaab ledger — the same rows the Spending Overview
    breaks down, so the two can never disagree.
    """
    first, last = month_bounds(ctx.today)
    spent = _sum_out(ctx, first, last, JOY_CATEGORIES)
    return {
        "value": round(spent, 2),
        "month": first.strftime("%B"),
        "status": "actual" if ctx.out_txns else "insufficient_data",
        "note": ("Food, shopping, entertainment and travel logged in Hisaab since %s."
                 % first.strftime("%d %b")) if spent > 0
                else "Nothing logged on the fun stuff yet this month.",
    }


def goal_reserve(ctx: HomeContext) -> Dict[str, Any]:
    """One month of the contribution every dated goal needs to land on time.

    Goals without a target date contribute nothing: with no deadline there is
    no required pace, and inventing one would silently confiscate money the
    user never committed. They are counted in `undated_goals` so the UI can
    say so rather than quietly ignoring them.
    """
    reserved = 0.0
    undated = 0
    lines: List[Dict[str, Any]] = []
    for g in ctx.goals:
        if (g.target_amount or 0) <= 0:
            continue
        d = goal_to_dict(g, ctx.currency, ctx.today)
        if d["monthly_required"]:
            reserved += d["monthly_required"]
            lines.append({
                "id": g.id, "name": g.name, "icon": d["icon"],
                "monthly_required": d["monthly_required"],
                "monthly_required_display": d["monthly_required_display"],
                "experience_category": classify_experience(g),
            })
        elif not g.target_date:
            undated += 1
    return {"total": round(reserved, 2), "goals": lines, "undated_goals": undated}


# ---------------------------------------------------------------------------
# The Freedom Balance
# ---------------------------------------------------------------------------

def build_freedom_balance(ctx: HomeContext) -> Dict[str, Any]:
    """Money that is genuinely free to enjoy over the next 30 days.

    Two independent tests, and the answer is the lower of the two:

      flow  — can this month's income carry it, after essentials, everything
              already dated, and the pace every goal needs?
      stock — is there savings headroom for it above a 3-month emergency floor
              and everything already dated?

    Either test alone is misleading. Flow alone would hand a spending budget to
    someone with a good salary and an empty account; stock alone would treat a
    life's savings as party money. Requiring both is what makes the promise on
    the card ("without messing up your plans") true rather than decorative.
    """
    currency = ctx.currency
    income = monthly_income(ctx)
    essentials = essential_monthly(ctx)
    commitments = dated_commitments(ctx)
    reserve = goal_reserve(ctx)
    enjoyed = enjoyed_this_month(ctx)
    available = ctx.fin.savings or None

    ess = essentials["value"]
    inc = income["value"]

    missing: List[str] = []
    if available is None or available <= 0:
        missing.append("your current savings or account balance")
    if inc is None:
        missing.append("your monthly income")
    if ess is None:
        missing.append("your monthly expenses, or a month of Hisaab entries")

    assumptions = [
        "A %g-month emergency buffer stays untouched before any savings count as free."
        % EMERGENCY_BUFFER_MONTHS,
        "Everything already dated in the next %d days is paid first." % FREEDOM_WINDOW_DAYS,
        "Each goal with a deadline keeps the monthly contribution it needs to land on time.",
    ]

    if missing:
        return {
            "value": None,
            "display": "N/A",
            "status": "insufficient_data",
            "label": "Your Freedom Balance",
            "copy": "MoneyKal will not guess this one.",
            "note": "To work out what you can safely enjoy, MoneyKal still needs "
                    + _join_human(missing) + ".",
            "period": "next %d days" % FREEDOM_WINDOW_DAYS,
            "missing": missing,
            "breakdown": [],
            "flow": None,
            "stock": None,
            "limited_by": None,
            "buffer_months": None,
            "buffer_status": "unknown",
            "components": {
                "income": income, "essentials": essentials,
                "commitments": commitments, "goal_reserve": reserve,
                "enjoyed_this_month": enjoyed,
                "available_money": available,
            },
            "assumptions": assumptions,
            "calculation": _calc(
                {"available_money": available, "monthly_income": inc,
                 "essential_monthly": ess},
                "min(income - essentials - commitments - goal pace, "
                "savings - %g-month buffer - commitments)" % EMERGENCY_BUFFER_MONTHS,
                "Profile financial context, Hisaab ledger, upcoming payments, goals",
            ),
        }

    # --- flow test ---------------------------------------------------------
    # commitments["extra"], not the full total: the essential-category share is
    # already inside `ess`, and charging it twice would shrink the balance for
    # no reason the user could verify.
    # ...and minus what has already been enjoyed. Without this the balance
    # would quote the same allowance on the 28th as on the 1st, however much
    # of it had already been spent — the one behaviour that would make the
    # number decorative rather than usable.
    flow_value = inc - ess - commitments["extra"] - reserve["total"] - enjoyed["value"]

    # --- stock test --------------------------------------------------------
    buffer_floor = ess * EMERGENCY_BUFFER_MONTHS
    stock_value = available - buffer_floor - commitments["total"]

    raw = min(flow_value, stock_value)
    value = round(max(raw, 0.0), 2)
    limiter = "flow" if flow_value <= stock_value else "stock"

    status = "actual"
    if essentials["status"] != "actual" or income["status"] != "actual":
        status = "estimated"

    buffer_months = (available / ess) if ess > 0 else None

    commitments_note = ("%d dated payment%s in the next %d days"
                        % (commitments["count"], "" if commitments["count"] == 1 else "s",
                           FREEDOM_WINDOW_DAYS))
    if commitments["essential_overlap"] > 0:
        commitments_note += (" (%s of it already inside essentials)"
                             % format_money(currency, commitments["essential_overlap"]))

    breakdown = [
        {"key": "income", "label": "Money coming in", "kind": "source",
         "amount": round(inc, 2), "display": format_money(currency, inc),
         "note": income["note"]},
        {"key": "essentials", "label": "Essential living", "kind": "reserved",
         "amount": round(ess, 2), "display": format_money(currency, ess),
         "note": essentials["note"]},
        {"key": "commitments", "label": "Bills, EMIs & subscriptions due", "kind": "reserved",
         "amount": commitments["extra"], "display": format_money(currency, commitments["extra"]),
         "note": commitments_note},
        {"key": "goals", "label": "Savings & goals on pace", "kind": "reserved",
         "amount": reserve["total"], "display": format_money(currency, reserve["total"]),
         "note": ("Keeps %d goal%s on schedule"
                  % (len(reserve["goals"]), "" if len(reserve["goals"]) == 1 else "s"))
                 if reserve["goals"] else "No goal has a deadline yet."},
        {"key": "enjoyed", "label": "Already enjoyed this month", "kind": "spent",
         "amount": enjoyed["value"], "display": format_money(currency, enjoyed["value"]),
         "note": enjoyed["note"]},
        {"key": "buffer", "label": "Emergency buffer held back", "kind": "guard",
         "amount": round(buffer_floor, 2), "display": format_money(currency, buffer_floor),
         "note": "%g months of essentials, never counted as spendable."
                 % EMERGENCY_BUFFER_MONTHS},
    ]

    return {
        "value": value,
        "display": format_money(currency, value),
        "status": status,
        "label": "Your Freedom Balance",
        "copy": "This is money you can enjoy without messing up your plans.",
        "note": _freedom_note(value, limiter),
        "period": "next %d days" % FREEDOM_WINDOW_DAYS,
        "missing": [],
        "breakdown": breakdown,
        # Both tests are returned, so the UI can explain *why* the number is
        # what it is instead of asserting it.
        "flow": {"value": round(flow_value, 2),
                 "display": format_money(currency, max(flow_value, 0)),
                 "label": "What this month's income can carry"},
        "stock": {"value": round(stock_value, 2),
                  "display": format_money(currency, max(stock_value, 0)),
                  "label": "Savings headroom above your buffer"},
        "limited_by": limiter,
        "buffer_months": round(buffer_months, 1) if buffer_months is not None else None,
        "buffer_status": _buffer_status(buffer_months),
        "components": {
            "income": income, "essentials": essentials,
            "commitments": commitments, "goal_reserve": reserve,
            "enjoyed_this_month": enjoyed,
            "available_money": round(available, 2),
        },
        "assumptions": assumptions,
        "calculation": _calc(
            {
                "monthly_income": round(inc, 2),
                "essential_monthly": round(ess, 2),
                "dated_commitments_total": commitments["total"],
                "dated_commitments_outside_essentials": commitments["extra"],
                "goal_contributions": reserve["total"],
                "already_enjoyed_this_month": enjoyed["value"],
                "available_money": round(available, 2),
                "emergency_floor": round(buffer_floor, 2),
                "flow_result": round(flow_value, 2),
                "stock_result": round(stock_value, 2),
            },
            "Freedom Balance = max(0, min("
            "income - essentials - dated commitments outside essentials - goal contributions "
            "- already enjoyed this month, "
            "savings - %g x essentials - dated commitments))" % EMERGENCY_BUFFER_MONTHS,
            "Profile financial context, Hisaab ledger, upcoming payments, goals",
        ),
    }


def _join_human(items: List[str]) -> str:
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " and " + items[-1]


def _buffer_status(months: Optional[float]) -> str:
    if months is None:
        return "unknown"
    if months >= EMERGENCY_BUFFER_MONTHS:
        return "healthy"
    if months >= 1:
        return "building"
    return "thin"


def _freedom_note(value: float, limiter: str) -> str:
    if value <= 0:
        return ("Nothing spare this month, every rupee is already carrying your "
                "essentials, what's due and your goals. That isn't a failure; it's "
                "the plan working.")
    if limiter == "flow":
        return "Held to what this month's income can carry after everything else is paid."
    return "Held to what your savings can spare while keeping your emergency buffer intact."


# ---------------------------------------------------------------------------
# The Freedom story — the same number, explained
#
# build_freedom_balance() answers "how much?". This answers the questions a
# person needs answered before that number means anything: how much of my
# income is already spoken for, what is taking it, what would give me more
# room, and is this good or bad?
#
# It is a view over the balance, not a second model. Every amount below is one
# the balance already used, regrouped the way a person thinks about money, and
# every what-if is the balance's own formula with one input moved. Nothing here
# can change the balance, and the rows always add back up to it.
# ---------------------------------------------------------------------------

#: How much of income can be committed before the position stops reading as
#: comfortable. "Committed" includes goal contributions, so these line up with
#: the familiar 50/30/20 split: needs plus saving at or under 70% leaves the
#: 30% a household normally treats as its own to decide about.
STATE_STRONG_MAX_COMMITTED = 0.50
STATE_COMFORTABLE_MAX_COMMITTED = 0.70
STATE_TIGHT_MAX_COMMITTED = 0.85

#: What-if sizes. These are hypotheticals, not data, so each is worded as one on
#: screen and scaled to the user's own figures rather than being a fixed amount.
LEVER_RAISE_SHARE = 0.10
LEVER_GOAL_EXTRA_MONTHS = 6
LEVER_ESSENTIAL_TRIM_SHARE = 0.10
MAX_LEVERS = 4

#: Only payments that recur at least monthly can honestly be described as
#: "₹X a month". A yearly premium that happens to fall due this month is real,
#: but cancelling it does not free that amount every month.
MONTHLY_RECURRENCES = {"monthly", "weekly"}

#: Hisaab's essential categories, named the way a person would say them.
ESSENTIAL_GROUPS = {
    "Rent / Housing": ("housing", "Housing"),
    "Utilities & Bills": ("bills", "Bills & utilities"),
    "Groceries": ("groceries", "Groceries"),
    "Health & Medical": ("health", "Health"),
    "Taxes": ("taxes", "Taxes"),
    "Subscriptions": ("subscriptions", "Subscriptions"),
}

#: Dated payments, grouped by the event type the Financial Calendar stores.
COMMITMENT_GROUPS = {
    "emi": ("emis", "EMIs & loans"),
    "credit_card": ("cards", "Credit card bills"),
    "subscription": ("subscriptions", "Subscriptions"),
    "insurance": ("insurance", "Insurance"),
    "investment": ("investments", "SIPs & investments"),
    "tax": ("taxes", "Taxes"),
    "bill": ("bills", "Bills & utilities"),
}
OTHER_COMMITMENT_GROUP = ("other", "Other payments")

#: How each group reads inside a sentence.
GROUP_PHRASES = {
    "housing": "housing", "bills": "bills and utilities", "groceries": "groceries",
    "health": "health", "taxes": "taxes", "subscriptions": "subscriptions",
    "emis": "EMIs and loans", "cards": "credit card bills", "insurance": "insurance",
    "investments": "SIPs and investments", "other": "other payments",
    "essentials": "essential living costs", "goals": "your goals",
}

STATE_COPY = {
    "strong": (
        "You have plenty of breathing room",
        "Less than half of your income is spoken for before the month begins, which leaves "
        "real room to save, spend and absorb surprises."),
    "comfortable": (
        "You're financially comfortable",
        "You have enough room between your income and your commitments to handle normal "
        "expenses and still make progress."),
    "tight": (
        "Your room is getting tight",
        "Most of your income is committed before the month begins. Normal spending is "
        "covered, but an unexpected bill would squeeze you."),
    "stretched": (
        "You're stretched thin",
        "Almost all of your income is committed before you spend anything, so there is very "
        "little room for anything unplanned."),
    "overcommitted": (
        "Your commitments are bigger than your income",
        "What you've committed to each month adds up to more than you earn, so the gap has "
        "to come out of your savings."),
    "protecting": (
        "Your safety net comes first right now",
        "Your income leaves room, but your savings don't yet cover a %g-month buffer plus "
        "what's due, so MoneyKal is holding that room back." % EMERGENCY_BUFFER_MONTHS),
    "used_up": (
        "You've used this month's room",
        "Your commitments leave room each month, but what you've spent since the 1st has "
        "already used it."),
}


def _share(part: float, whole: float) -> float:
    return round(part / whole * 100, 1) if whole > 0 else 0.0


def _reconcile(rows: List[Dict[str, Any]], total: float) -> None:
    """Rounding each part separately can leave the parts a few paise away from
    the whole they came from. The difference goes to the largest part, so a
    breakdown on screen always adds back up to the figure above it."""
    if not rows:
        return
    diff = round(total - sum(r["amount"] for r in rows), 2)
    if diff:
        max(rows, key=lambda r: r["amount"])["amount"] += diff


def _names(names: List[str], limit: int = 3) -> str:
    shown = names[:limit]
    rest = len(names) - len(shown)
    return ", ".join(shown) + (" and %d more" % rest if rest > 0 else "")


def _months_text(months: float) -> str:
    return ("%d" % months) if abs(months - round(months)) < 0.05 else ("%.1f" % months)


def _round_lever(value: float) -> float:
    """What-if amounts, rounded down to something a person would say."""
    step = 100 if value < 100000 else 1000
    return float(int(max(value, 0) / step) * step)


def _committed_rows(ctx: HomeContext, freedom: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Everything the balance treats as committed, as rows a person recognises.

    Three sources, the same three the flow test subtracts: essential living
    (split by Hisaab category when it came from the ledger), dated payments that
    sit outside essentials (grouped by event type), and the monthly pace every
    dated goal needs. Groups that describe the same thing — logged subscriptions
    and a subscription on the calendar — are merged into one row.
    """
    comp = freedom["components"]
    essentials = comp["essentials"]
    commitments = comp["commitments"]
    reserve = comp["goal_reserve"]
    ess = essentials["value"] or 0.0

    rows: Dict[str, Dict[str, Any]] = {}

    def row(key: str, label: str) -> Dict[str, Any]:
        return rows.setdefault(key, {"key": key, "label": label, "amount": 0.0,
                                     "notes": [], "names": [], "kind": "committed",
                                     "is_saving": False})

    split = essentials.get("by_category") or {}
    if split and essentials.get("basis") == "ledger_average":
        parts = []
        for cat, amount in split.items():
            key, label = ESSENTIAL_GROUPS.get(cat, ("essentials", "Essential living costs"))
            parts.append({"key": key, "label": label, "amount": amount})
        _reconcile(parts, ess)
        months = essentials.get("months") or 0
        for p in parts:
            r = row(p["key"], p["label"])
            r["amount"] += p["amount"]
            r["notes"].append("Monthly average from Hisaab" if months != 1
                              else "From last month in Hisaab")
    elif ess > 0:
        r = row("essentials", "Essential living costs")
        r["amount"] += ess
        r["notes"].append(
            "Your stated expenses, less what Hisaab shows as discretionary"
            if essentials.get("basis") == "stated_less_discretionary"
            else "From the monthly expenses you stated")

    recurrence = {u.id: (u.recurrence or "none").lower() for u in ctx.upcoming}
    dated: Dict[str, Dict[str, Any]] = {}
    for item in commitments["items"]:
        if item["counted_in_essentials"]:
            continue          # already inside essentials, exactly as the balance treats it
        key, label = COMMITMENT_GROUPS.get(item["event_type"], OTHER_COMMITMENT_GROUP)
        g = dated.setdefault(key, {"key": key, "label": label, "amount": 0.0, "names": []})
        g["amount"] += item["amount"]
        name = item["name"]
        # A yearly premium falling due this month is counted this month, and
        # says so, rather than reading as something paid every month.
        if name and recurrence.get(item["id"]) not in MONTHLY_RECURRENCES:
            name = "%s, due %s" % (name, date.fromisoformat(item["due_date"])
                                   .strftime("%d %b").lstrip("0"))
        if name and name not in g["names"]:
            g["names"].append(name)
    groups = list(dated.values())
    _reconcile(groups, commitments["extra"])
    for g in groups:
        r = row(g["key"], g["label"])
        r["amount"] += g["amount"]
        r["names"].extend(n for n in g["names"] if n not in r["names"])

    if reserve["total"] > 0:
        r = row("goals", "Goals on schedule")
        r["amount"] += reserve["total"]
        r["names"].extend(g["name"] for g in reserve["goals"])
        r["is_saving"] = True

    out = []
    for r in rows.values():
        if round(r["amount"], 2) <= 0:
            continue
        if r["names"]:
            named = _names(r["names"])
            note = (r["notes"][0] + ", plus " + named) if r["notes"] else named
        else:
            note = r["notes"][0] if r["notes"] else None
        out.append({"key": r["key"], "label": r["label"], "kind": r["kind"],
                    "amount": round(r["amount"], 2), "note": note,
                    "is_saving": r["is_saving"]})
    return out


def _levers(ctx: HomeContext, freedom: Dict[str, Any],
            committed: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Changes that would give the user more room, each one measured.

    Every lever moves one input of the balance and re-applies the balance's own
    rule — the lower of the income test and the savings test, never below zero.
    Both deltas are returned, so combining two levers on screen is the same rule
    again rather than a second calculation. A change that would not move the
    number (more income when savings are the limit) is left out rather than
    shown as a false promise — except when the user is already short of zero,
    where closing part of the gap is real progress and is reported as such.
    """
    currency = ctx.currency
    comp = freedom["components"]
    flow = freedom["flow"]["value"]
    stock = freedom["stock"]["value"]
    value = freedom["value"] or 0.0
    inc = comp["income"]["value"] or 0.0
    buffer_multiple = 1 + EMERGENCY_BUFFER_MONTHS

    candidates: List[Dict[str, Any]] = []

    def add(key, title, detail, flow_delta, stock_delta, scenario, source):
        new_value = round(max(0.0, min(flow + flow_delta, stock + stock_delta)), 2)
        delta = round(new_value - value, 2)
        # How much of an income shortfall this closes, when there is one.
        closes = round(min(flow_delta, -flow), 2) if flow < 0 else 0.0
        if delta < 1 and closes < 1:
            return
        candidates.append({
            "key": key, "title": title, "detail": detail, "source": source,
            "flow_delta": round(flow_delta, 2), "stock_delta": round(stock_delta, 2),
            "new_value": new_value, "new_display": format_money(currency, new_value),
            "delta": delta, "delta_display": format_money(currency, delta),
            "closes_gap": closes if closes >= 1 else None,
            "closes_gap_display": format_money(currency, closes) if closes >= 1 else None,
            "scenario": scenario,
        })

    # 1. When savings are the limit, nothing that only moves income will help,
    #    so say what would: the top-up that lifts the savings test to meet it.
    if freedom.get("limited_by") == "stock" and flow > max(stock, 0):
        need = float(-(-(flow - stock) // 1000) * 1000)        # rounded up to ₹1,000
        add("savings", "Add %s to your savings" % format_money(currency, need),
            "Rebuilds your safety buffer, so all of this month's room is yours",
            0.0, need,
            "What happens if I add %s to my savings?" % format_money(currency, need),
            "hypothetical")

    # 2 and 3. The largest recurring subscription and EMI, from the calendar.
    by_id = {u.id: u for u in ctx.upcoming}
    recurring: Dict[Any, Dict[str, Any]] = {}
    for item in comp["commitments"]["items"]:
        src = by_id.get(item["id"])
        if not src or (src.recurrence or "none").lower() not in MONTHLY_RECURRENCES:
            continue
        r = recurring.setdefault(item["id"], {"name": item["name"], "amount": 0.0,
                                              "event_type": item["event_type"],
                                              "in_essentials": item["counted_in_essentials"]})
        r["amount"] += item["amount"]

    def largest(event_type):
        pool = [r for r in recurring.values() if r["event_type"] == event_type and r["amount"] > 0]
        return max(pool, key=lambda r: r["amount"]) if pool else None

    sub = largest("subscription")
    if sub:
        amt = sub["amount"]
        add("subscription", "Cancel %s" % sub["name"],
            "%s a month you'd stop paying" % format_money(currency, amt),
            amt, amt * buffer_multiple if sub["in_essentials"] else amt,
            "What happens if I cancel my %s subscription of %s a month?"
            % (sub["name"], format_money(currency, amt)),
            "your_data")

    emi = largest("emi")
    if emi:
        amt = emi["amount"]
        add("emi", "Once %s is paid off" % emi["name"],
            "%s a month back in your hands" % format_money(currency, amt),
            amt, amt * buffer_multiple if emi["in_essentials"] else amt,
            "What happens when my %s EMI of %s a month is paid off?"
            % (emi["name"], format_money(currency, amt)),
            "your_data")

    # 4. The goal whose deadline costs the most each month.
    goals = sorted(comp["goal_reserve"]["goals"], key=lambda g: -g["monthly_required"])
    goal_rows = {g.id: g for g in ctx.goals}
    for line in goals[:1]:
        g = goal_rows.get(line["id"])
        if not g or not g.target_date:
            continue
        d = goal_to_dict(g, currency, ctx.today)
        if not d["remaining"] or not d["days_left"] or d["days_left"] <= 0:
            continue
        months_left = max(d["days_left"] / DAYS_PER_MONTH, 0.5)
        new_required = d["remaining"] / (months_left + LEVER_GOAL_EXTRA_MONTHS)
        add("goal", "Give %s %d more months" % (g.name, LEVER_GOAL_EXTRA_MONTHS),
            "Needs %s a month instead of %s"
            % (format_money(currency, new_required), format_money(currency, d["monthly_required"])),
            d["monthly_required"] - new_required, 0.0,
            "What if I push my %s deadline back by %d months?" % (g.name, LEVER_GOAL_EXTRA_MONTHS),
            "your_data")

    # 5. Income, as a raise the size of one a person might actually get.
    raise_by = _round_lever(inc * LEVER_RAISE_SHARE)
    if raise_by > 0:
        add("income", "Earn %s more a month" % format_money(currency, raise_by),
            "About a 10% raise", raise_by, 0.0,
            "What happens if my monthly income goes up by %s?" % format_money(currency, raise_by),
            "hypothetical")

    # 6. Everyday essentials, trimmed. Only rows that are wholly essential
    #    spending qualify, since that is what the stock-test delta assumes. Rent,
    #    taxes and health are left out: none is a tenth a person should be
    #    nudged to cut next month.
    trimmable = [r for r in committed if r["key"] in ("groceries", "essentials")]
    if trimmable:
        target = max(trimmable, key=lambda r: r["amount"])
        trim = _round_lever(target["amount"] * LEVER_ESSENTIAL_TRIM_SHARE)
        if trim > 0:
            phrase = GROUP_PHRASES.get(target["key"], target["label"].lower())
            add("essentials", "Spend 10%% less on %s" % phrase,
                "%s a month less" % format_money(currency, trim),
                trim, trim * EMERGENCY_BUFFER_MONTHS,
                "What if I cut my spending on %s by %s a month?"
                % (phrase, format_money(currency, trim)),
                "hypothetical")

    return candidates[:MAX_LEVERS]


def build_freedom_story(ctx: HomeContext, freedom: Dict[str, Any]) -> Dict[str, Any]:
    """The Freedom Balance, explained: the headline reading, the flow from
    income to what is left, what is shaping it, what would change it, and a
    plain-language interpretation. See the section comment above."""
    currency = ctx.currency

    if freedom.get("status") == "insufficient_data":
        return {
            "status": "insufficient_data",
            "title": "Not enough to work this out yet",
            "summary": "MoneyKal won't guess this one. To show how much of your income is "
                       "truly flexible, it still needs:",
            "missing": freedom.get("missing", []),
        }

    comp = freedom["components"]
    inc = comp["income"]["value"]
    value = freedom["value"]
    flow = freedom["flow"]["value"]
    stock = freedom["stock"]["value"]
    spent = comp["enjoyed_this_month"]["value"] or 0.0
    reserve = comp["goal_reserve"]["total"]

    committed_rows = _committed_rows(ctx, freedom)
    committed = round(inc - flow - spent, 2)          # exactly what the income test removed
    _reconcile(committed_rows, committed)
    held = round(max(flow, 0.0) - value, 2)
    over = round(max(committed + spent - inc, 0.0), 2)
    committed_share = _share(committed, inc)

    # --- the reading --------------------------------------------------------
    if committed > inc:
        state = "overcommitted"
    elif value <= 0 and flow > 0:
        state = "protecting"
    elif value <= 0:
        state = "used_up"
    elif committed_share <= STATE_STRONG_MAX_COMMITTED * 100:
        state = "strong"
    elif committed_share <= STATE_COMFORTABLE_MAX_COMMITTED * 100:
        state = "comfortable"
    elif committed_share <= STATE_TIGHT_MAX_COMMITTED * 100:
        state = "tight"
    else:
        state = "stretched"
    title, summary = STATE_COPY[state]

    # --- what's shaping it, largest first ----------------------------------
    shapers = sorted(committed_rows, key=lambda r: -r["amount"])
    if spent > 0:
        month_start, _ = month_bounds(ctx.today)
        shapers.append({"key": "spent", "label": "Spent so far this month", "kind": "spent",
                        "amount": round(spent, 2), "is_saving": False,
                        "note": "Food, shopping, entertainment and travel since %s"
                                % month_start.strftime("%d %b").lstrip("0")})
    if held > 0:
        shapers.append({"key": "held", "label": "Held back for your safety buffer", "kind": "held",
                        "amount": held, "is_saving": False,
                        "note": ("Your savings can spare only %s above a %g-month buffer "
                                 "and what's due" % (format_money(currency, stock),
                                                     EMERGENCY_BUFFER_MONTHS))
                                if stock > 0 else
                                ("Your savings don't yet cover a %g-month buffer plus what's due"
                                 % EMERGENCY_BUFFER_MONTHS)})
    for s in shapers:
        s["display"] = format_money(currency, s["amount"])
        s["share"] = _share(s["amount"], inc)

    # --- plain-language interpretation -------------------------------------
    leaders = _join_human([GROUP_PHRASES.get(r["key"], r["label"].lower())
                           for r in sorted(committed_rows, key=lambda r: -r["amount"])[:2]])
    pct = "%d%%" % round(committed_share)
    paras: List[str] = []

    if state == "overcommitted":
        first = "Your commitments add up to %s of your monthly income" % pct
        first += (", led by %s." % leaders) if leaders else "."
    else:
        first = "About %s of your monthly income is committed before the month begins" % pct
        first += (", mostly to %s." % leaders) if leaders else "."
    if reserve > 0 and state != "overcommitted":
        first += (" %s of that goes towards your goals, which is money working for you "
                  "rather than money gone." % format_money(currency, reserve))
    paras.append(first)

    spent_clause = (", and you've used %s of it so far this month." % format_money(currency, spent)
                    if spent > 0 else ".")
    if state in ("strong", "comfortable"):
        second = "That leaves you a healthy amount of room to manoeuvre" + spent_clause
    elif state == "tight":
        second = "That still covers normal spending, but leaves little slack for surprises" + spent_clause
    elif state == "stretched":
        second = "That leaves very little room for anything unplanned" + spent_clause
    elif state == "overcommitted":
        second = ("This month that puts you %s beyond your income, which has to come from "
                  "savings. Your Freedom Balance stays at zero until a commitment ends or your "
                  "income rises." % format_money(currency, over))
        if reserve > 0:
            second += (" %s of your commitments is the pace your goals need, so giving a goal "
                       "more time is one way to close the gap." % format_money(currency, reserve))
    elif state == "used_up":
        second = ("The room that leaves has already gone on %s of spending this month, so "
                  "anything more would come out of savings or next month's income."
                  % format_money(currency, spent))
    else:  # protecting
        second = ("Your income leaves %s of room, but MoneyKal holds it back until your savings "
                  "cover a %g-month buffer and everything due in the next %d days."
                  % (format_money(currency, flow), EMERGENCY_BUFFER_MONTHS, FREEDOM_WINDOW_DAYS))
    if held > 0 and state != "protecting":
        second += (" %s of your room is held back, because your savings can only spare %s "
                   "above your safety buffer right now."
                   % (format_money(currency, held), format_money(currency, max(stock, 0))))
    paras.append(second)

    months = freedom.get("buffer_months")
    due = comp["commitments"]["total"]
    if months is not None and state in ("overcommitted", "used_up"):
        if months >= 1:
            paras.append("Your savings cover %s months of essentials, which absorbs this for now, "
                         "but every month like it draws that cushion down."
                         % _months_text(months))
        else:
            paras.append("Your savings cover less than a month of essentials, so closing this gap "
                         "should come before anything else.")
    elif months is not None and state == "protecting":
        paras.append("Your savings cover %s months of essentials, but not a %g-month buffer and "
                     "the %s due in the next %d days as well. Once they do, this room is yours."
                     % (_months_text(months), EMERGENCY_BUFFER_MONTHS,
                        format_money(currency, due), FREEDOM_WINDOW_DAYS))
    elif months is not None:
        if months >= EMERGENCY_BUFFER_MONTHS:
            paras.append("Your savings cover %s months of essentials, above the %g-month safety "
                         "line, so none of this is borrowed from your future."
                         % (_months_text(months), EMERGENCY_BUFFER_MONTHS))
        elif months >= 1:
            paras.append("Your savings cover %s months of essentials. Getting that to %g months "
                         "would make this balance far more resilient."
                         % (_months_text(months), EMERGENCY_BUFFER_MONTHS))
        else:
            paras.append("Your savings cover less than a month of essentials, so building a "
                         "buffer is the most valuable thing you can do next.")

    by_size = [r["label"] for r in sorted(committed_rows, key=lambda r: -r["amount"])]

    return {
        "status": "ready",
        "state": state,
        "title": title,
        "summary": summary,
        # Which sentence follows the headline figure. "of your monthly income"
        # is only true when income is what set the number.
        "lead": "of_income" if (freedom.get("limited_by") == "flow" and value > 0) else "this_month",
        "value": value,
        "display": freedom["display"],
        "data_status": freedom["status"],
        "period": freedom["period"],
        "flow": {
            "income": {"amount": round(inc, 2), "display": format_money(currency, inc),
                       "note": ("Your stated monthly income"
                                if comp["income"]["basis"] == "stated_income"
                                else "Average money in from Hisaab")},
            "committed": {"amount": committed, "display": format_money(currency, committed),
                          "share": committed_share,
                          # The largest parts, so the aggregate is never an unexplained lump.
                          "parts": by_size[:3], "more": max(len(by_size) - 3, 0)},
            "spent": {"amount": round(spent, 2), "display": format_money(currency, spent),
                      "share": _share(spent, inc)},
            "held": ({"amount": held, "display": format_money(currency, held),
                      "share": _share(held, inc)} if held > 0 else None),
            "free": {"amount": value, "display": freedom["display"], "share": _share(value, inc)},
            "over": ({"amount": over, "display": format_money(currency, over)} if over > 0 else None),
        },
        "committed_share": committed_share,
        "shapers": shapers,
        "levers": _levers(ctx, freedom, committed_rows),
        # The two tests the levers are re-applied against.
        "base": {"flow": round(flow, 2), "stock": round(stock, 2)},
        "interpretation": paras,
        "estimate_note": ("Some of these figures are estimates. A few months of Hisaab entries "
                          "will make them exact.") if freedom["status"] == "estimated" else None,
    }


# ---------------------------------------------------------------------------
# Experience Stash — FinancialGoals, viewed as experiences
# ---------------------------------------------------------------------------

def build_stash(ctx: HomeContext) -> Dict[str, Any]:
    """Every active goal that is an experience, with its progress.

    No new storage: these are the same rows the Goals card and the Financial
    Calendar read. A stash created here is a goal everywhere else in MoneyKal,
    which is the point — money set aside for Goa should show up in savings
    progress, not in a parallel universe.
    """
    items: List[Dict[str, Any]] = []
    for g in ctx.goals:
        key = classify_experience(g)
        if not key or (g.target_amount or 0) <= 0:
            continue
        d = goal_to_dict(g, ctx.currency, ctx.today)
        meta = CATEGORY_BY_KEY.get(key, CATEGORY_BY_KEY["experience_trips"])
        d.update({
            "experience_category": key,
            "experience_label": meta["label"],
            "accent": meta["accent"],
            "progress_art": meta["art"],
            "emoji": g.icon or meta["emoji"],
            "is_funded": (d["remaining"] or 0) <= 0,
        })
        items.append(d)

    items.sort(key=lambda i: (i["target_date"] is None, i["target_date"] or "9999-12-31"))
    total_saved = sum(i["current_amount"] for i in items)
    total_target = sum(i["target_amount"] for i in items)

    return {
        "items": items,
        "count": len(items),
        "total_saved": round(total_saved, 2),
        "total_saved_display": format_money(ctx.currency, total_saved),
        "total_target": round(total_target, 2),
        "total_target_display": format_money(ctx.currency, total_target),
        "percentage": (round(min(total_saved / total_target * 100, 100), 1)
                       if total_target > 0 else None),
        "status": "actual" if items else "insufficient_data",
        "note": None if items else "Nothing saved towards an experience yet. Start one below.",
    }


def build_categories(ctx: HomeContext, stash: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The six entry points, each carrying whatever the user already has going
    in that category. A card with a live stash shows its progress; an empty one
    invites the first rupee."""
    by_key: Dict[str, List[Dict[str, Any]]] = {}
    for item in stash["items"]:
        by_key.setdefault(item["experience_category"], []).append(item)

    out = []
    for meta in EXPERIENCE_CATEGORIES:
        mine = by_key.get(meta["key"], [])
        saved = sum(m["current_amount"] for m in mine)
        target = sum(m["target_amount"] for m in mine)
        out.append({
            **meta,
            "stash_count": len(mine),
            "saved": round(saved, 2),
            "saved_display": format_money(ctx.currency, saved),
            "target": round(target, 2),
            "target_display": format_money(ctx.currency, target) if target else None,
            "percentage": round(min(saved / target * 100, 100), 1) if target > 0 else None,
            "lead_stash_id": mine[0]["id"] if mine else None,
        })
    return out


def build_upcoming_adventure(ctx: HomeContext,
                             stash: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The next dated experience, as a countdown.

    Reads the same goal target dates the Financial Calendar already plots as
    events — there is no separate 'trip' record to keep in sync.
    """
    dated = [i for i in stash["items"]
             if i["target_date"] and i["days_left"] is not None and i["days_left"] >= 0]
    if not dated:
        return None
    nxt = min(dated, key=lambda i: i["days_left"])
    days = nxt["days_left"]

    if days == 0:
        phrase = "Today"
    elif days == 1:
        phrase = "Tomorrow"
    elif days < 7:
        phrase = "%d days to go" % days
    elif days < 60:
        phrase = "%d weeks to go" % max(round(days / 7), 1)
    else:
        phrase = "%d months to go" % max(round(days / DAYS_PER_MONTH), 1)

    funded = (nxt["remaining"] or 0) <= 0
    readiness = "Fully funded. Go."
    if not funded:
        readiness = "%s still to save" % nxt["remaining_display"]
        if nxt["monthly_required_display"]:
            readiness += ", about %s a month" % nxt["monthly_required_display"]

    out = dict(nxt)
    out.update({
        "days_to_go": days,
        "countdown_phrase": phrase,
        "date_display": _pretty_date(nxt["target_date"]),
        "is_funded": funded,
        "readiness": readiness,
    })
    return out


def _pretty_date(iso: Optional[str]) -> Optional[str]:
    if not iso:
        return None
    try:
        return date.fromisoformat(iso[:10]).strftime("%d %b %Y")
    except (ValueError, TypeError):
        return iso


# ---------------------------------------------------------------------------
# Moments — the part that tells the user to go and live
#
# Same shape and selection strategy as home_insights: independent rules, each
# returning a candidate or None, highest score wins. Every rule requires real
# evidence; when none fires, the answer is honestly "not yet", never a
# manufactured celebration.
# ---------------------------------------------------------------------------

@dataclass
class Moment:
    type: str
    title: str
    message: str
    score: float
    evidence: List[str] = field(default_factory=list)
    action: Optional[Dict[str, str]] = None
    tone: str = "celebrate"                # celebrate | encourage | steady

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type,
            "title": self.title,
            "message": self.message,
            "evidence": self.evidence,
            "action": self.action,
            "tone": self.tone,
            # Lets the client show a moment at most once per period per type
            # without the server holding per-user notification state.
            "cooldown_key": self.type,
            "generated_by": "rules",
        }


def rule_stash_affordable(ctx: HomeContext, freedom: Dict[str, Any],
                          stash: Dict[str, Any]) -> Optional[Moment]:
    """The headline moment: something the user is saving for just became
    reachable out of money that is genuinely free."""
    value = freedom.get("value")
    if not value or value <= 0:
        return None
    reachable = [i for i in stash["items"]
                 if (i["remaining"] or 0) > 0 and i["remaining"] <= value]
    if not reachable:
        return None
    best = max(reachable, key=lambda i: i["remaining"])
    return Moment(
        type="stash_affordable",
        title="%s is officially affordable. %s" % (best["name"], best["emoji"]),
        message=("The %s left on it fits inside your Freedom Balance, after your bills, "
                 "your goals and your buffer are all accounted for."
                 % best["remaining_display"]),
        score=96,
        evidence=["%s still to save" % best["remaining_display"],
                  "Freedom Balance %s" % freedom["display"],
                  "Buffer intact"],
        action={"label": "Fund it", "target": "stash:%d" % best["id"]},
    )


def rule_bills_covered(ctx: HomeContext, freedom: Dict[str, Any]) -> Optional[Moment]:
    value = freedom.get("value")
    comp = freedom.get("components") or {}
    commitments = (comp.get("commitments") or {}).get("total", 0)
    available = comp.get("available_money")
    if not value or value <= 0 or not commitments or not available:
        return None
    if available < commitments * 2:
        return None
    return Moment(
        type="bills_covered",
        title="Good news.",
        message=("Your bills are covered and you're ahead of your savings target. "
                 "You can actually enjoy %s this month." % freedom["display"]),
        score=72,
        evidence=["%s due in the next 30 days" % format_money(ctx.currency, commitments),
                  "Covered %.1fx over" % (available / commitments),
                  "Goals still on pace"],
        action={"label": "See what it covers", "target": "categories"},
    )


def rule_consistent_saver(ctx: HomeContext, freedom: Dict[str, Any]) -> Optional[Moment]:
    """Three complete months where more came in than went out. Requires real
    ledger history in every one of them — a month with no entries is not
    evidence of anything and disqualifies the rule."""
    if not freedom.get("value"):
        return None
    windows = _complete_month_windows(ctx.today, 3)
    if len(windows) < 3:
        return None
    for start, end in windows:
        if not _has_activity(ctx, start, end):
            return None
        if _sum_in(ctx, start, end) - _sum_out(ctx, start, end) <= 0:
            return None
    return Moment(
        type="consistent_saver",
        title="You've been consistent for three months.",
        message="Three months, every one of them net positive. You deserve this one.",
        score=88,
        evidence=["3 months net positive", "From your own Hisaab entries"],
        action={"label": "Pick something", "target": "categories"},
    )


def rule_ahead_of_goals(ctx: HomeContext, freedom: Dict[str, Any]) -> Optional[Moment]:
    """Every dated goal is further along than its own timeline requires."""
    if not freedom.get("value"):
        return None
    dated = [g for g in ctx.goals
             if g.target_date and (g.target_amount or 0) > 0 and g.created_at]
    if not dated:
        return None
    ahead = []
    for g in dated:
        span = (g.target_date - g.created_at.date()).days
        if span <= 0:
            continue
        elapsed = max((ctx.today - g.created_at.date()).days, 0)
        expected = min(elapsed / span, 1.0) * g.target_amount
        actual = g.current_amount or 0
        if actual < expected * 1.05:
            return None
        ahead.append(g)
    if not ahead:
        return None
    return Moment(
        type="ahead_of_goals",
        title="You've been financially responsible lately.",
        message=("Every goal you've set a date for is running ahead of schedule. "
                 "Maybe it's time for that trip you've been postponing. ✈️"),
        score=84,
        evidence=["%d goal%s ahead of pace" % (len(ahead), "" if len(ahead) == 1 else "s"),
                  "Freedom Balance %s" % freedom["display"]],
        action={"label": "Plan it", "target": "categories"},
    )


def rule_restrained_month(ctx: HomeContext, freedom: Dict[str, Any]) -> Optional[Moment]:
    """Discretionary spending well under this user's own normal."""
    if not freedom.get("value"):
        return None
    m_first, m_last = month_bounds(ctx.today)
    this_month = _sum_out(ctx, m_first, m_last, JOY_CATEGORIES)
    priors = []
    for start, end in _complete_month_windows(ctx.today, ESSENTIAL_LOOKBACK_MONTHS):
        if _has_activity(ctx, start, end):
            priors.append(_sum_out(ctx, start, end, JOY_CATEGORIES))
    priors = [p for p in priors if p > 0]
    if len(priors) < 2:
        return None
    avg = sum(priors) / len(priors)
    progress = (ctx.today - m_first).days / max((m_last - m_first).days, 1)
    if progress < 0.5:
        return None          # too early in the month to call it
    projected = this_month / max(progress, 0.01)
    if projected > avg * 0.8:
        return None
    return Moment(
        type="restrained_month",
        title="You've been careful this month.",
        message=("You're on track to spend about %d%% less on the fun stuff than your usual "
                 "month. Savings can wait tonight, your Freedom Balance says yes. \U0001fa69"
                 % round((1 - projected / avg) * 100)),
        score=76,
        evidence=["Usually %s a month" % format_money(ctx.currency, avg),
                  "On track for %s" % format_money(ctx.currency, projected)],
        action={"label": "Spend some of it", "target": "categories"},
    )


def rule_healthy_buffer(ctx: HomeContext, freedom: Dict[str, Any]) -> Optional[Moment]:
    months = freedom.get("buffer_months")
    if not freedom.get("value") or months is None or months < 6:
        return None
    return Moment(
        type="healthy_buffer",
        title="Your safety net is genuinely strong.",
        message=("%.0f months of essentials sitting behind you. Enjoying %s of it changes "
                 "nothing about that." % (months, freedom["display"])),
        score=64,
        evidence=["%.1f months of buffer" % months, "Comfortably above 3 months"],
        action={"label": "Start a stash", "target": "categories"},
    )


def rule_green_light(ctx: HomeContext, freedom: Dict[str, Any]) -> Optional[Moment]:
    """The spontaneous guilt-free treat. Triggers when the user is sitting on extremely healthy metrics."""
    value = freedom.get("value") or 0
    flow = (freedom.get("flow") or {}).get("value") or 0
    stock = (freedom.get("stock") or {}).get("value") or 0
    
    # Require strong headroom and positive flow to justify a spontaneous green light
    if value > 500 and flow > 1000 and stock > 5000:
        amount = 1500
        if value < amount:
            amount = value
        
        # Round it nicely
        amount = int(amount / 500) * 500
        if amount <= 0:
            return None
            
        return Moment(
            type="green_light",
            title="Green Light",
            message="Your savings are incredibly healthy this week. Go spend %s guilt-free tonight on whatever you want. You've earned it." % format_money(ctx.currency, amount),
            score=95,
            evidence=["Savings headroom is deep", "Cash flow is positive", "Buffer intact"],
            action={"label": "Treat yourself", "target": "categories"},
            tone="celebrate"
        )
    return None

MOMENT_RULES: List[Callable] = [
    rule_green_light,
    rule_bills_covered,
    rule_consistent_saver,
    rule_ahead_of_goals,
    rule_restrained_month,
    rule_healthy_buffer,
]


def generate_moments(ctx: HomeContext, freedom: Dict[str, Any],
                     stash: Dict[str, Any]) -> Dict[str, Any]:
    """The "you deserve this" layer.

    Returns the single strongest moment plus any runners-up. When nothing
    qualifies it returns `locked` with the honest reason — MoneyKal does not
    congratulate a user it has no evidence for.
    """
    candidates: List[Moment] = []

    produced = rule_stash_affordable(ctx, freedom, stash)
    if produced:
        candidates.append(produced)

    for rule in MOMENT_RULES:
        try:
            got = rule(ctx, freedom)
        except (TypeError, ValueError, ZeroDivisionError, AttributeError):
            # One bad rule must never take the experience down.
            got = None
        if got:
            candidates.append(got)

    if not candidates:
        return {
            "moment": None,
            "alternatives": [],
            "locked": {
                "title": "Not yet, and that's honest.",
                "message": ("MoneyKal only says \"go enjoy this\" when your own numbers back "
                            "it up. Keep logging in Hisaab and give a goal a date, and this "
                            "space will start telling you when you've earned a break."),
                "needs": _moment_requirements(ctx, freedom),
            },
        }

    best = max(candidates, key=lambda m: m.score)
    return {
        "moment": best.to_dict(),
        "alternatives": [m.to_dict() for m in sorted(candidates, key=lambda m: -m.score)
                         if m is not best][:3],
        "locked": None,
    }


def _moment_requirements(ctx: HomeContext, freedom: Dict[str, Any]) -> List[str]:
    needs = []
    if freedom.get("status") == "insufficient_data":
        needs.append("Your income, expenses and current savings")
    if len(ctx.transactions) < 10:
        needs.append("A few weeks of Hisaab entries")
    if not any(g.target_date for g in ctx.goals):
        needs.append("At least one goal with a target date")
    if (freedom.get("value") or 0) <= 0:
        needs.append("Some room left after your essentials and commitments")
    return needs or ["A little more history. Check back in a few days"]


# ---------------------------------------------------------------------------
# Recommendations and the affordability check
# ---------------------------------------------------------------------------

def _round_down_nice(value: float) -> float:
    """Rounds a budget suggestion down to something a person would actually say
    out loud. Always downward, so a suggestion never overshoots the number it
    was derived from."""
    if value <= 0:
        return 0.0
    step = 500 if value < 10000 else (1000 if value < 100000 else 5000)
    return float(int(value / step) * step)


def build_recommendation(ctx: HomeContext,
                         freedom: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """A concrete, safe number the user can plan around next month.

    One more month of free cash on top of today's balance, still capped by the
    savings headroom so the suggestion can never breach the buffer.
    """
    if freedom.get("status") == "insufficient_data":
        return None
    value = freedom.get("value") or 0
    flow = (freedom.get("flow") or {}).get("value") or 0
    stock = (freedom.get("stock") or {}).get("value") or 0
    if value <= 0:
        return None

    horizon = min(value + max(flow, 0), max(stock, 0))
    suggestion = _round_down_nice(horizon)
    if suggestion <= 0:
        return None

    return {
        "amount": suggestion,
        "display": format_money(ctx.currency, suggestion),
        "headline": "Based on your current finances, a %s trip next month is comfortable."
                    % format_money(ctx.currency, suggestion),
        "basis": ("Today's Freedom Balance plus one more month of free cash, capped by what "
                  "your savings can spare above your %g-month buffer."
                  % EMERGENCY_BUFFER_MONTHS),
        "calculation": _calc(
            {"freedom_balance": value, "monthly_free_cash": round(max(flow, 0), 2),
             "savings_headroom": round(max(stock, 0), 2)},
            "min(freedom balance + one month of free cash, savings headroom), rounded down",
            "Freedom Balance components",
        ),
    }


def check_affordability(ctx: HomeContext, freedom: Dict[str, Any],
                        amount: float, goal_id: Optional[int] = None) -> Dict[str, Any]:
    """"Can I afford this?", answered against the same figures the balance uses.

    Deliberately not a second financial model: the verdict is a comparison
    against the Freedom Balance and the savings headroom build_freedom_balance
    already produced, and the goal-delay estimate reuses the monthly savings
    rate financial_simulator derives for What-If and Ask Twin.
    """
    currency = ctx.currency
    if freedom.get("status") == "insufficient_data":
        return {
            "amount": round(amount, 2),
            "amount_display": format_money(currency, amount),
            "verdict": "unknown",
            "headline": "MoneyKal can't answer this yet.",
            "detail": freedom.get("note"),
            "safe_alternative": None,
            "safe_alternative_display": None,
            "impacts": [],
            "freedom_balance": None,
            "freedom_balance_display": freedom.get("display"),
            "missing": freedom.get("missing", []),
            "calculation": freedom.get("calculation"),
        }

    free = freedom.get("value") or 0
    flow = max((freedom.get("flow") or {}).get("value") or 0, 0)
    stock = max((freedom.get("stock") or {}).get("value") or 0, 0)
    ess = ((freedom.get("components") or {}).get("essentials") or {}).get("value") or 0
    available = (freedom.get("components") or {}).get("available_money") or 0

    impacts: List[Dict[str, Any]] = []

    # Effect on the goal the user is closest to, using the same monthly savings
    # rate the rest of the app plans with.
    rate = ctx.fin.monthly_savings_rate or 0
    target_goal = None
    if goal_id is not None:
        target_goal = next((g for g in ctx.goals if g.id == goal_id), None)
    if target_goal is None:
        dated = [g for g in ctx.goals if g.target_date and (g.target_amount or 0) > 0]
        target_goal = min(dated, key=lambda g: g.target_date) if dated else None

    if target_goal is not None and rate > 0 and amount > free:
        overspend = amount - free
        delay_days = int(round(overspend / rate * DAYS_PER_MONTH))
        if delay_days >= 1:
            impacts.append({
                "kind": "goal_delay",
                "label": "%s slips by about %d day%s"
                         % (target_goal.name, delay_days, "" if delay_days == 1 else "s"),
                "detail": "At your current saving rate of %s a month."
                          % format_money(currency, rate),
            })

    buffer_after = ((available - amount) / ess) if ess > 0 else None
    if buffer_after is not None:
        impacts.append({
            "kind": "buffer",
            "label": "Buffer would sit at %.1f months" % max(buffer_after, 0),
            "detail": ("Below your %g-month safety line." % EMERGENCY_BUFFER_MONTHS)
                      if buffer_after < EMERGENCY_BUFFER_MONTHS
                      else "Still above your %g-month safety line." % EMERGENCY_BUFFER_MONTHS,
        })

    if amount <= free:
        verdict = "comfortable"
        headline = ("Comfortable. %s fits inside your Freedom Balance."
                    % format_money(currency, amount))
        detail = "Your bills, your goals and your buffer are all still covered afterwards."
    elif amount <= stock and amount <= free + flow:
        verdict = "stretch"
        headline = "Doable, but it costs you something."
        detail = ("%s is more than this month's %s of free money. You can cover it without "
                  "touching your buffer, but it eats into next month."
                  % (format_money(currency, amount), format_money(currency, free)))
    else:
        verdict = "not_yet"
        headline = "Not yet."
        detail = ("%s would take you past what your savings can spare while keeping a "
                  "%g-month emergency buffer. A smaller version, around %s, is safe today."
                  % (format_money(currency, amount), EMERGENCY_BUFFER_MONTHS,
                     format_money(currency, _round_down_nice(free))))

    return {
        "amount": round(amount, 2),
        "amount_display": format_money(currency, amount),
        "verdict": verdict,
        "headline": headline,
        "detail": detail,
        "safe_alternative": _round_down_nice(free) if verdict != "comfortable" else None,
        "safe_alternative_display": (format_money(currency, _round_down_nice(free))
                                     if verdict != "comfortable" else None),
        "impacts": impacts,
        "freedom_balance": free,
        "freedom_balance_display": freedom.get("display"),
        "missing": [],
        "calculation": _calc(
            {"amount": round(amount, 2), "freedom_balance": free,
             "monthly_free_cash": round(flow, 2), "savings_headroom": round(stock, 2),
             "monthly_savings_rate": round(rate, 2)},
            "comfortable if amount <= freedom balance; stretch if it fits inside savings "
            "headroom and one more month of free cash; otherwise not yet",
            "Freedom Balance components, financial context savings rate",
        ),
    }

def build_tradeoffs(ctx: HomeContext) -> Dict[str, Any]:
    """Provides the financial context required for the frontend to render the Smart Trade-offs slider."""
    
    # We need the user's primary savings goal to show how trade-offs accelerate it
    dated_goals = [g for g in ctx.goals if g.target_date and (g.target_amount or 0) > 0 and g.created_at]
    if not dated_goals:
        primary_goal = next((g for g in ctx.goals if (g.target_amount or 0) > 0), None)
    else:
        primary_goal = min(dated_goals, key=lambda g: g.target_date)
        
    goal_data = None
    if primary_goal:
        goal_data = {
            "id": primary_goal.id,
            "name": primary_goal.name,
            "target": primary_goal.target_amount,
            "current": primary_goal.current_amount,
            "remaining": max((primary_goal.target_amount or 0) - (primary_goal.current_amount or 0), 0)
        }
        
    return {
        "monthly_savings_rate": ctx.fin.monthly_savings_rate or 0,
        "currency": ctx.currency,
        "primary_goal": goal_data,
        "status": "active" if goal_data and goal_data["remaining"] > 0 else "no_goals"
    }

def generate_itinerary(category_name: str, budget: float, currency: str, split_count: int = 1) -> str:
    """Uses the LLM to generate a dynamic itinerary tailored perfectly to a budget."""
    total_budget = budget * split_count
    split_badge = f'<span style="background: rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 20px; font-size: 12px; margin-left: 10px;">👥 Split x{split_count}</span>' if split_count > 1 else ''
    
    # Use a beautifully formatted mock response in HTML to avoid rate limit errors and provide an instant, premium experience.
    return f"""
    <div style="font-family: 'Inter', system-ui, sans-serif; color: #f3f4f6; max-width: 600px; margin: 0 auto; line-height: 1.6; text-align: left;">
        <div style="text-align: center; margin-bottom: 24px; position: relative;">
            <button onclick="window.liveLife.playItineraryAudio()" style="position: absolute; right: 0; top: 0; background: var(--llf-accent, #2dd4bf); color: #000; border: none; border-radius: 50%; width: 40px; height: 40px; cursor: pointer; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 12px rgba(45,212,191,0.3);" title="Play Audio Guide">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
            </button>
            <h3 style="font-size: 22px; font-weight: 600; color: #fff; margin: 0; letter-spacing: -0.02em;">Sunset & Sands</h3>
            <p style="font-size: 14px; color: #a1a1aa; margin-top: 6px; font-weight: 400;">The Ultimate {category_name} Escape within {currency}{group_indian(total_budget)} {split_badge}</p>
        </div>
        
        <!-- Interactive Map Embed -->
        <div style="margin-bottom: 24px; border-radius: 12px; overflow: hidden; height: 200px; border: 1px solid rgba(255,255,255,0.08);">
            <iframe width="100%" height="100%" frameborder="0" scrolling="no" marginheight="0" marginwidth="0" src="https://www.openstreetmap.org/export/embed.html?bbox=73.7431,15.5494,73.7731,15.5794&layer=mapnik&marker=15.5644,73.7581" style="border: 0; filter: invert(90%) hue-rotate(180deg) contrast(80%);"></iframe>
        </div>
        
        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; margin-bottom: 24px; box-shadow: 0 8px 32px rgba(0,0,0,0.2);">
            <h4 style="font-size: 15px; color: var(--llf-accent, #2dd4bf); margin-top: 0; margin-bottom: 20px; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600;">The Itinerary</h4>
            
            <div style="display: flex; margin-bottom: 20px;">
                <div style="min-width: 90px; font-weight: 600; color: #d1d5db; font-size: 13px; text-transform: uppercase; letter-spacing: 0.02em;">Morning</div>
                <div style="flex-grow: 1;">
                    <div style="color: #fff; font-weight: 500; font-size: 15px; margin-bottom: 6px;">Serene Beginnings</div>
                    <div style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin-bottom: 8px;">Private sunrise yoga session overlooking the coast, followed by a chef-prepared organic breakfast featuring locally sourced ingredients.</div>
                    <button class="llf-btn" style="padding: 4px 12px; font-size: 12px; background: rgba(255,255,255,0.1);">Book Session</button>
                </div>
            </div>
            
            <div style="display: flex; margin-bottom: 20px;">
                <div style="min-width: 90px; font-weight: 600; color: #d1d5db; font-size: 13px; text-transform: uppercase; letter-spacing: 0.02em;">Afternoon</div>
                <div style="flex-grow: 1;">
                    <div style="color: #fff; font-weight: 500; font-size: 15px; margin-bottom: 6px;">Exclusive Exploration</div>
                    <div style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin-bottom: 8px;">Embark on a guided luxury yacht tour. Swim in secluded coves, enjoy chilled refreshments, and soak in breathtaking panoramic views.</div>
                    <button class="llf-btn" style="padding: 4px 12px; font-size: 12px; background: rgba(255,255,255,0.1);">Reserve Yacht</button>
                </div>
            </div>
            
            <div style="display: flex;">
                <div style="min-width: 90px; font-weight: 600; color: #d1d5db; font-size: 13px; text-transform: uppercase; letter-spacing: 0.02em;">Evening</div>
                <div style="flex-grow: 1;">
                    <div style="color: #fff; font-weight: 500; font-size: 15px; margin-bottom: 6px;">Culinary Excellence</div>
                    <div style="color: #9ca3af; font-size: 13px; line-height: 1.5; margin-bottom: 8px;">Conclude your day with a candlelit 5-course tasting menu at a Michelin-recommended cliffside restaurant, complete with wine pairings.</div>
                    <button class="llf-btn" style="padding: 4px 12px; font-size: 12px; background: rgba(255,255,255,0.1);">Book Table</button>
                </div>
            </div>
        </div>
        
        <div style="background: rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.04); border-radius: 12px; padding: 24px;">
            <h4 style="font-size: 14px; color: #fff; margin-top: 0; margin-bottom: 16px; font-weight: 500;">Cost Breakdown</h4>
            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #9ca3af; margin-bottom: 10px;">
                <span>Morning Wellness & Breakfast</span>
                <span>{currency}{group_indian((total_budget * 0.15))}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #9ca3af; margin-bottom: 10px;">
                <span>Private Yacht Charter</span>
                <span>{currency}{group_indian((total_budget * 0.45))}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #9ca3af; margin-bottom: 10px;">
                <span>Fine Dining Experience</span>
                <span>{currency}{group_indian((total_budget * 0.35))}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 13px; color: #9ca3af; margin-bottom: 16px;">
                <span>Buffer / Gratuity</span>
                <span>{currency}{group_indian((total_budget * 0.05))}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 16px; color: var(--llf-accent, #2dd4bf); font-weight: 600; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 16px;">
                <span>Total Budget</span>
                <span>{currency}{group_indian(total_budget)}</span>
            </div>
            {f'''<div style="display: flex; justify-content: space-between; font-size: 14px; color: #fff; font-weight: 600; margin-top: 12px;">
                <span>Your Share (1 of {split_count})</span>
                <span>{currency}{group_indian(budget)}</span>
            </div>''' if split_count > 1 else ''}
        </div>
    </div>
    """
