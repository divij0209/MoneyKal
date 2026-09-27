"""
Daily Home — the data layer behind "What is happening with my money today?".

Design rules this module holds itself to:

*   It invents no financial primitives. The stated position comes from
    financial_simulator.build_financial_context() — the same grounding step
    Ask Twin and What-If already use — and every rupee of movement comes from
    the existing Hisaab ledger (StartupTransaction, which is keyed on
    profile_id and shared by both personas despite the table name).
*   Every figure carries a status from the same vocabulary the Startup engine
    uses (actual | estimated | insufficient_data) plus a calculation block, so
    the UI can tell the user where a number came from and can refuse to render
    one it cannot stand behind.
*   Nothing is fabricated to fill a gap. Missing data yields insufficient_data,
    never a plausible-looking placeholder.
"""
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from backend.core.money import format_money as _shared_format_money
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.models.domain import (
    FinancialGoal, Profile, StartupTransaction, UpcomingPayment,
)
from backend.services.financial_simulator import build_financial_context


# ---------------------------------------------------------------------------
# Formatting — Indian numbering, matching the rest of the app
# ---------------------------------------------------------------------------

def format_money(currency: str, value: Optional[float]) -> str:
    """Renders 123456 as the Indian-grouped form, which plain thousands
    separators do not produce.

    The grouping itself now lives in backend/core/money.py so that this and the
    startup engine cannot drift apart again — they were producing different
    output for the same magnitude. Behaviour here is unchanged.
    """
    return _shared_format_money(currency, value, none_text="N/A")


def _calc(inputs: Dict[str, Any], formula: str, data_source: str) -> Dict[str, Any]:
    """Mirrors startup_engine._calc_meta so both engines explain themselves the
    same way and the frontend has one shape to render."""
    return {
        "inputs": inputs,
        "formula": formula,
        "data_source": data_source,
        "last_updated": datetime.utcnow().isoformat(),
    }


def month_bounds(anchor: Optional[date] = None) -> tuple:
    """(first, last) day of the calendar month containing anchor."""
    anchor = anchor or date.today()
    first = anchor.replace(day=1)
    nxt = (first + timedelta(days=32)).replace(day=1)
    return first, nxt - timedelta(days=1)


# ---------------------------------------------------------------------------
# Ledger access — one gather, reused by every section below
# ---------------------------------------------------------------------------

@dataclass
class HomeContext:
    """Everything the Home dashboard, the insight engine and the goal/upcoming
    builders need, gathered once so a single request hits the DB a fixed number
    of times regardless of how many sections are rendered."""
    profile: Profile
    currency: str
    fin: Any                              # FinancialContext from financial_simulator
    transactions: List[StartupTransaction]
    goals: List[FinancialGoal]
    upcoming: List[UpcomingPayment]
    today: date

    @property
    def out_txns(self) -> List[StartupTransaction]:
        return [t for t in self.transactions if t.type == "out"]

    @property
    def in_txns(self) -> List[StartupTransaction]:
        return [t for t in self.transactions if t.type == "in"]


def build_home_context(db: Session, profile: Profile, today: Optional[date] = None) -> HomeContext:
    today = today or date.today()
    txns = (db.query(StartupTransaction)
            .filter(StartupTransaction.profile_id == profile.id)
            .order_by(StartupTransaction.txn_date).all())
    goals = (db.query(FinancialGoal)
             .filter(FinancialGoal.profile_id == profile.id,
                     FinancialGoal.status == "active").all())
    # Includes rows awaiting review; build_upcoming separates them and keeps
    # them out of every total. Dismissed rows are filtered here since nothing
    # downstream ever shows them.
    upcoming = (db.query(UpcomingPayment)
                .filter(UpcomingPayment.profile_id == profile.id,
                        UpcomingPayment.is_active.is_(True),
                        (UpcomingPayment.status.is_(None))
                        | (UpcomingPayment.status != "dismissed"))
                .all())
    return HomeContext(
        profile=profile,
        currency=profile.currency or "₹",
        fin=build_financial_context(profile),
        transactions=txns,
        goals=goals,
        upcoming=upcoming,
        today=today,
    )


# ---------------------------------------------------------------------------
# A. Available money / current financial position
# ---------------------------------------------------------------------------

def build_available_money(ctx: HomeContext) -> Dict[str, Any]:
    """The user's stated current financial position, and nothing else.

    This deliberately does NOT add the Hisaab ledger's net movement on top. The
    stated figure (whatever build_financial_context resolves as savings/cash —
    the same number Ask Twin and What-If quote) is the user's own most recent
    declaration of where they stand, and every route that updates it (onboarding,
    Edit Profile, the Excel import) sets it to a present-day balance. Adding
    historical ledger movement to a present-day balance double-counts every
    transaction logged before the user last refreshed the figure.

    The ledger totals are still reported inside `calculation`, explicitly marked
    as context rather than as addends, so the number stays auditable without
    being derived from two overlapping sources. Hisaab remains the sole basis
    for monthly spending, trends, categories and insights — it is only the
    balance that is single-sourced here.
    """
    stated = ctx.fin.savings
    money_in = sum(t.amount for t in ctx.in_txns)
    money_out = sum(t.amount for t in ctx.out_txns)

    formula = "Available money = latest stated savings / cash position"
    inputs = {
        "stated_savings": stated or 0.0,
        # Reported for transparency only — see the docstring. Neither figure is
        # added to the value above.
        "ledger_money_in_not_added": round(money_in, 2),
        "ledger_money_out_not_added": round(money_out, 2),
    }

    if not stated:
        return {
            "value": None,
            "display": "N/A",
            "status": "insufficient_data",
            "label": "Available money",
            "note": "Add your savings in Edit Profile to see your position here.",
            "calculation": _calc(inputs, formula, "Profile financial context"),
        }

    value = round(stated, 2)
    return {
        "value": value,
        "display": format_money(ctx.currency, value),
        # A user-declared balance is 'actual' in the same sense the Startup
        # engine treats founder-reported cash — it is a fact they stated, not
        # something we modelled.
        "status": "actual",
        "label": "Available money",
        "note": "Your latest stated position. Update it in Edit Profile.",
        "calculation": _calc(inputs, formula, "Profile financial context"),
    }


# ---------------------------------------------------------------------------
# B. This month's spending
# ---------------------------------------------------------------------------

def build_monthly_spending(ctx: HomeContext) -> Dict[str, Any]:
    """Actual outflow for the current calendar month, with the previous month
    and the user's own stated monthly expenses as comparison baselines. The
    baseline is labelled as stated, never presented as measured."""
    first, last = month_bounds(ctx.today)
    prev_last = first - timedelta(days=1)
    prev_first, _ = month_bounds(prev_last)

    this_month = [t for t in ctx.out_txns if first <= t.txn_date <= last]
    prev_month = [t for t in ctx.out_txns if prev_first <= t.txn_date <= prev_last]

    spent = round(sum(t.amount for t in this_month), 2)
    prev_spent = round(sum(t.amount for t in prev_month), 2)
    stated = ctx.fin.expenses or None

    by_category: Dict[str, float] = {}
    for t in this_month:
        key = t.category or "Uncategorized"
        by_category[key] = by_category.get(key, 0.0) + t.amount
    top = sorted(by_category.items(), key=lambda kv: -kv[1])

    if not ctx.out_txns:
        return {
            "value": None,
            "display": "N/A",
            "status": "insufficient_data",
            "label": "Spent this month",
            "month": first.strftime("%B %Y"),
            "previous_month": None,
            "change_pct": None,
            "stated_baseline": stated,
            "top_categories": [],
            "note": "No expenses logged yet. Add one in Hisaab.",
            "calculation": _calc({}, "sum of Hisaab 'out' transactions in the current calendar month", "Hisaab ledger"),
        }

    change_pct = None
    if prev_spent > 0:
        change_pct = round((spent - prev_spent) / prev_spent * 100, 1)

    return {
        "value": spent,
        "display": format_money(ctx.currency, spent),
        "status": "actual",
        "label": "Spent this month",
        "month": first.strftime("%B %Y"),
        "previous_month": prev_spent if prev_month else None,
        "change_pct": change_pct,
        "stated_baseline": stated,
        "top_categories": [
            {"category": c, "amount": round(a, 2), "display": format_money(ctx.currency, a)}
            for c, a in top[:3]
        ],
        "note": None if this_month else "Nothing logged this month yet.",
        "calculation": _calc(
            {"transactions_counted": len(this_month),
             "period": first.isoformat() + " → " + last.isoformat()},
            "sum of Hisaab 'out' transactions in the current calendar month",
            "Hisaab ledger",
        ),
    }


# ---------------------------------------------------------------------------
# B2. Spending overview — the same month, broken out by category
# ---------------------------------------------------------------------------

# Icons for the categories the Hisaab form already offers. Keyed on the exact
# stored category string so the overview shows the user's real categories
# rather than inventing a second, coarser taxonomy to group them into.
CATEGORY_ICONS = {
    "Food & Dining": "🍔",
    "Groceries": "🛒",
    "Travel & Transport": "🚗",
    "Shopping": "🛍️",
    "Rent / Housing": "🏠",
    "Utilities & Bills": "💡",
    "Subscriptions": "💳",
    "Entertainment": "🎬",
    "Health & Medical": "🩺",
    "Taxes": "🧾",
    "Professional fees": "💼",
    "Software/Tools": "🧰",
    "Payroll": "👥",
    "Marketing": "📣",
    "Supplies": "📦",
    "Other expense": "💸",
    "Uncategorized": "💸",
}


def build_spending_overview(ctx: HomeContext) -> Dict[str, Any]:
    """This month's outflow split by category, against the same split last month.

    Reads the Hisaab ledger directly — the same rows build_monthly_spending
    totals — so the breakdown can never disagree with the headline figure above
    it. No separate spending records are kept anywhere.

    Categories are the user's own stored Hisaab categories, not a re-grouping
    of them: a summary that renames the categories the user files things under
    stops being a summary of their data.
    """
    first, last = month_bounds(ctx.today)
    prev_last = first - timedelta(days=1)
    prev_first, _ = month_bounds(prev_last)

    this_month = [t for t in ctx.out_txns if first <= t.txn_date <= last]
    prev_month = [t for t in ctx.out_txns if prev_first <= t.txn_date <= prev_last]

    def bucket(rows):
        out: Dict[str, float] = {}
        for t in rows:
            key = t.category or "Uncategorized"
            out[key] = out.get(key, 0.0) + t.amount
        return out

    now_by_cat = bucket(this_month)
    prev_by_cat = bucket(prev_month)
    total = round(sum(now_by_cat.values()), 2)
    prev_total = round(sum(prev_by_cat.values()), 2)

    if not this_month:
        return {
            "status": "insufficient_data",
            "period": first.strftime("%B %Y"),
            "total": None,
            "total_display": "N/A",
            "categories": [],
            "leader": None,
            "insight": None,
            "transaction_count": 0,
            "note": ("No expenses logged this month yet. Add one in Hisaab."
                     if ctx.out_txns else "No expenses logged yet. Add one in Hisaab."),
        }

    categories = []
    for name, amount in sorted(now_by_cat.items(), key=lambda kv: -kv[1]):
        prev_amount = prev_by_cat.get(name, 0.0)
        change_pct = None
        if prev_amount > 0:
            change_pct = round((amount - prev_amount) / prev_amount * 100, 1)
        categories.append({
            "category": name,
            "icon": CATEGORY_ICONS.get(name, "💸"),
            "amount": round(amount, 2),
            "display": format_money(ctx.currency, amount),
            # Share of this month's spend — what the bar length represents.
            "share_pct": round(amount / total * 100, 1) if total > 0 else 0,
            "previous_amount": round(prev_amount, 2) if prev_amount else None,
            "change_pct": change_pct,
            "is_new": prev_amount == 0,
            "transaction_count": sum(1 for t in this_month if (t.category or "Uncategorized") == name),
        })

    leader = categories[0]

    # One line that says something the bars do not. Ordered by how much it
    # would change a decision: a category that jumped beats a category that is
    # merely large, which beats a plain month-over-month total.
    insight = None
    movers = [c for c in categories
              if c["change_pct"] is not None and c["change_pct"] >= 25 and c["amount"] >= 500]
    if movers:
        top = max(movers, key=lambda c: c["amount"] - (c["previous_amount"] or 0))
        insight = "%s is up %d%% on last month, %s against %s." % (
            top["category"], round(top["change_pct"]),
            top["display"], format_money(ctx.currency, top["previous_amount"] or 0))
    elif leader["share_pct"] >= 35:
        insight = "%s alone is %d%% of everything you spent this month." % (
            leader["category"], round(leader["share_pct"]))
    elif prev_total > 0:
        diff = total - prev_total
        insight = "You have spent %s %s than by this point last month." % (
            format_money(ctx.currency, abs(diff)), "more" if diff > 0 else "less")

    return {
        "status": "actual",
        "period": first.strftime("%B %Y"),
        "total": total,
        "total_display": format_money(ctx.currency, total),
        "previous_total": prev_total if prev_month else None,
        "previous_total_display": format_money(ctx.currency, prev_total) if prev_month else None,
        "categories": categories,
        "leader": leader,
        "insight": insight,
        "transaction_count": len(this_month),
        "note": None,
    }


# ---------------------------------------------------------------------------
# C. Goals
# ---------------------------------------------------------------------------

GOAL_ICON_DEFAULTS = {
    "emergency_fund": "🛡️",
    "travel": "✈️",
    "purchase": "🏷️",
    "investment": "📈",
    "custom": "🎯",
    # Experience stashes created from live.life.fully are ordinary goals with
    # their own category slug, so they need an icon here too — otherwise a Goa
    # stash would fall back to the generic target on the Daily Home card.
    "experience_trips": "✈️",
    "experience_party": "🎉",
    "experience_shopping": "🛍️",
    "experience_concerts": "🎵",
    "experience_weekend": "🌴",
    "experience_adventure": "🏔️",
}


def goal_to_dict(g: FinancialGoal, currency: str, today: date) -> Dict[str, Any]:
    target = g.target_amount or 0.0
    current = g.current_amount or 0.0
    pct = round(min(current / target * 100, 100), 1) if target > 0 else None
    remaining = round(max(target - current, 0), 2) if target > 0 else None

    days_left = None
    monthly_required = None
    if g.target_date:
        days_left = (g.target_date - today).days
        if remaining is not None and days_left > 0:
            months_left = max(days_left / 30.44, 0.5)
            monthly_required = round(remaining / months_left, 2)

    return {
        "id": g.id,
        "name": g.name,
        "icon": g.icon or GOAL_ICON_DEFAULTS.get(g.category or "custom", "🎯"),
        "category": g.category,
        "current_amount": round(current, 2),
        "target_amount": round(target, 2),
        "current_display": format_money(currency, current),
        "target_display": format_money(currency, target),
        "percentage": pct,
        "remaining": remaining,
        "remaining_display": format_money(currency, remaining) if remaining is not None else None,
        "target_date": g.target_date.isoformat() if g.target_date else None,
        "days_left": days_left,
        "monthly_required": monthly_required,
        "monthly_required_display": (format_money(currency, monthly_required)
                                     if monthly_required is not None else None),
        "is_primary": bool(g.is_primary),
        "status": g.status or "active",
    }


def resolve_primary_goal(goals: List[FinancialGoal], today: date) -> Optional[FinancialGoal]:
    """Primary goal selection, in the order the product asked for:
    1. an explicit is_primary flag,
    2. otherwise the nearest future deadline,
    3. otherwise the goal closest to completion (most momentum to show),
    4. otherwise the most recently created."""
    fundable = [g for g in goals if (g.target_amount or 0) > 0]
    if not fundable:
        return None

    flagged = [g for g in fundable if g.is_primary]
    if flagged:
        return flagged[0]

    dated = [g for g in fundable if g.target_date and g.target_date >= today]
    if dated:
        return min(dated, key=lambda g: g.target_date)

    def completion(g: FinancialGoal) -> float:
        return (g.current_amount or 0) / g.target_amount

    scored = [g for g in fundable if completion(g) > 0]
    if scored:
        return max(scored, key=completion)

    return max(fundable, key=lambda g: g.created_at or datetime.min)


def build_goals(ctx: HomeContext) -> Dict[str, Any]:
    """Returns the primary goal, the full active list, and the aggregate
    savings progress across every goal (which is what the snapshot shows — a
    distinct figure from the primary goal whenever more than one goal exists)."""
    fundable = [g for g in ctx.goals if (g.target_amount or 0) > 0]
    primary = resolve_primary_goal(ctx.goals, ctx.today)

    total_target = sum(g.target_amount for g in fundable)
    total_current = sum(g.current_amount or 0 for g in fundable)
    savings_pct = round(min(total_current / total_target * 100, 100), 1) if total_target > 0 else None

    return {
        "primary_goal": goal_to_dict(primary, ctx.currency, ctx.today) if primary else None,
        "goals": [goal_to_dict(g, ctx.currency, ctx.today)
                  for g in sorted(fundable, key=lambda g: (not g.is_primary, g.target_date or date.max))],
        "savings_progress": {
            "current": round(total_current, 2),
            "target": round(total_target, 2),
            "current_display": format_money(ctx.currency, total_current),
            "target_display": format_money(ctx.currency, total_target),
            "percentage": savings_pct,
            "goal_count": len(fundable),
            "status": "actual" if fundable else "insufficient_data",
            "label": "Savings progress",
            "note": None if fundable else "Set a goal to start tracking savings progress.",
            "calculation": _calc(
                {"goals_counted": len(fundable), "saved": round(total_current, 2),
                 "target": round(total_target, 2)},
                "sum(current_amount) / sum(target_amount) across active goals",
                "Financial goals",
            ),
        },
    }


def sync_legacy_profile_goal(db: Session, profile: Profile, today: Optional[date] = None) -> None:
    """Keeps the pre-existing Profile.goal JSON blob pointed at the primary goal.

    What-If, Ask Twin and Market Pulse all read Profile.goal["progress"], which
    onboarding hardcodes to 25. Rather than change those consumers (and risk
    breaking them), the blob is mirrored from the real goal here — so they keep
    working unchanged but now see a computed percentage instead of a constant."""
    today = today or date.today()
    goals = (db.query(FinancialGoal)
             .filter(FinancialGoal.profile_id == profile.id,
                     FinancialGoal.status == "active").all())
    primary = resolve_primary_goal(goals, today)
    if not primary:
        return

    target = primary.target_amount or 0.0
    current = primary.current_amount or 0.0
    progress = round(min(current / target * 100, 100), 1) if target > 0 else 0

    existing = dict(profile.goal or {})
    existing.update({
        "title": primary.name,
        "target": target,
        "progress": progress,
        "target_date": primary.target_date.isoformat() if primary.target_date else None,
    })
    profile.goal = existing


def backfill_legacy_goal(db: Session, profile: Profile) -> Optional[FinancialGoal]:
    """One-time, lazy migration of the legacy Profile.goal blob into a real row,
    so a user who set a goal before this feature existed does not lose it.

    Only runs when the user has no goals at all and the legacy blob names a real
    target. current_amount is derived from the progress percentage the user was
    already being shown, so the migration preserves their view rather than
    silently resetting it to zero."""
    if db.query(FinancialGoal).filter(FinancialGoal.profile_id == profile.id).first():
        return None

    legacy = profile.goal or {}
    title = (legacy.get("title") or "").strip()
    try:
        target = float(legacy.get("target") or 0)
    except (TypeError, ValueError):
        target = 0.0
    if not title or target <= 0:
        return None

    try:
        progress = float(legacy.get("progress") or 0)
    except (TypeError, ValueError):
        progress = 0.0

    target_date = None
    raw_date = legacy.get("target_date")
    if raw_date:
        try:
            target_date = date.fromisoformat(str(raw_date)[:10])
        except ValueError:
            target_date = None

    goal = FinancialGoal(
        profile_id=profile.id,
        name=title,
        category="custom",
        target_amount=target,
        current_amount=round(target * max(min(progress, 100), 0) / 100, 2),
        target_date=target_date,
        is_primary=True,
        status="active",
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return goal


# ---------------------------------------------------------------------------
# D. What's coming up
# ---------------------------------------------------------------------------

def add_months(d: date, months: int) -> date:
    """Calendar-correct month addition that clamps to the last valid day, so a
    31st-of-the-month bill lands on the 30th (or the 28th/29th) rather than
    raising."""
    month_index = d.month - 1 + months
    year = d.year + month_index // 12
    month = month_index % 12 + 1
    first_of_next = date(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1)
    last_day = (first_of_next - timedelta(days=1)).day
    return date(year, month, min(d.day, last_day))


def next_occurrence(item: UpcomingPayment, today: date) -> Optional[date]:
    """The next date this obligation falls due, on or after today.

    Derived rather than stored, so a monthly bill whose due_date was never
    rolled forward still reports the correct upcoming date. A non-recurring item
    whose date has passed returns None — it is history, not upcoming."""
    if not item.due_date:
        return None
    due = item.due_date
    if due >= today:
        return due

    rec = (item.recurrence or "none").lower()
    if rec == "none":
        return None
    if rec == "weekly":
        weeks = ((today - due).days + 6) // 7
        return due + timedelta(days=7 * weeks)

    step = {"monthly": 1, "quarterly": 3, "yearly": 12}.get(rec)
    if not step:
        return None
    # Bounded walk — 400 steps covers decades, and prevents an unbounded loop
    # if a row ever carries an absurd date.
    candidate = due
    for _ in range(400):
        candidate = add_months(candidate, step)
        if candidate >= today:
            return candidate
    return None


def occurrences_in_range(item: UpcomingPayment, start: date, end: date,
                         cap: int = 64) -> List[date]:
    """Every date this obligation falls due between `start` and `end`.

    `next_occurrence` answers "when is the next one", which is all the Daily
    Home list needs. A calendar needs all of them inside a window, so a monthly
    bill appears on the month being viewed rather than only on the next one.

    Walks forward from the stored date rather than backward from `start`, so a
    bill dated after the window simply yields nothing and a long-stale bill is
    still placed correctly. `cap` bounds the walk against an absurd stored date.
    """
    if not item.due_date or end < start:
        return []

    rec = (item.recurrence or "none").lower()
    if rec == "none":
        return [item.due_date] if start <= item.due_date <= end else []

    out: List[date] = []
    cursor = item.due_date

    if rec == "weekly":
        # Jump straight to the first occurrence on or after the window start
        # instead of stepping a week at a time from a possibly ancient date.
        if cursor < start:
            weeks = ((start - cursor).days + 6) // 7
            cursor = cursor + timedelta(days=7 * weeks)
        while cursor <= end and len(out) < cap:
            if cursor >= start:
                out.append(cursor)
            cursor = cursor + timedelta(days=7)
        return out

    step = {"monthly": 1, "quarterly": 3, "yearly": 12}.get(rec)
    if not step:
        return []
    for _ in range(cap * 12):
        if cursor > end:
            break
        if cursor >= start:
            out.append(cursor)
            if len(out) >= cap:
                break
        cursor = add_months(cursor, step)
    return out


def urgency_label(due: date, today: date) -> str:
    days = (due - today).days
    if days <= 0:
        return "Due today"
    if days == 1:
        return "Due tomorrow"
    if days <= 6:
        return "Due in %d days" % days
    if days <= 13:
        return "Due next week"
    if days <= 31:
        return "Due in %d weeks" % round(days / 7)
    return "Due " + due.strftime("%d %b")


def urgency_level(due: date, today: date) -> str:
    days = (due - today).days
    if days <= 1:
        return "critical"
    if days <= 7:
        return "soon"
    return "later"


def _upcoming_row(item: UpcomingPayment, due: date, currency: str, today: date) -> Dict[str, Any]:
    meta = item.source_meta or {}
    return {
        "id": item.id,
        "name": item.name,
        "amount": round(item.amount or 0, 2) if item.amount is not None else None,
        "amount_display": format_money(currency, item.amount) if item.amount is not None else None,
        "due_date": due.isoformat(),
        "days_until": (due - today).days,
        "urgency": urgency_label(due, today),
        "urgency_level": urgency_level(due, today),
        "category": item.category,
        "recurrence": item.recurrence or "none",
        "is_recurring": (item.recurrence or "none") != "none",
        "source": item.source or "manual",
        "status": item.status or "confirmed",
        "confidence": item.confidence,
        "direction": item.direction or "out",
        "event_type": item.event_type or "other",
        "notes": item.notes,
        # Provenance the UI shows on a suggestion so the user can recognise the
        # mail it came from. Never the email body.
        "source_label": meta.get("sender_domain"),
        "source_subject": meta.get("subject"),
        "payment_url": meta.get("payment_url"),
    }


def build_upcoming(ctx: HomeContext, limit: int = 5) -> Dict[str, Any]:
    """The nearest confirmed obligations, plus anything awaiting review.

    Detected-but-uncertain rows are kept strictly out of `items` and out of
    every total: a suggestion the user has not accepted must never move a figure
    on the dashboard. They are returned alongside as `suggestions` so the UI can
    ask, rather than assert.

    The 30-day total is also what the insight engine weighs against available
    money, which is a second reason it may only ever contain confirmed rows.
    """
    confirmed, suggestions = [], []
    for item in ctx.upcoming:
        due = next_occurrence(item, ctx.today)
        if not due:
            continue
        status = item.status or "confirmed"
        if status == "dismissed":
            continue
        row = _upcoming_row(item, due, ctx.currency, ctx.today)
        (suggestions if status == "review" else confirmed).append(row)

    confirmed.sort(key=lambda r: (r["days_until"], -(r["amount"] or 0)))
    suggestions.sort(key=lambda r: (r["days_until"], -(r["confidence"] or 0)))

    horizon = ctx.today + timedelta(days=30)
    # Income events (an expected salary) live in this table too now, but the
    # 30-day figure answers "how much is leaving?" — counting an inflow there
    # would understate what the user has to cover.
    next_30 = [r for r in confirmed
               if date.fromisoformat(r["due_date"]) <= horizon and r["direction"] != "in"]
    total_30 = round(sum(r["amount"] or 0 for r in next_30), 2)

    return {
        "items": confirmed[:limit],
        "total_count": len(confirmed),
        "next_30_days_total": total_30,
        "next_30_days_display": format_money(ctx.currency, total_30),
        "next_30_days_count": len(next_30),
        "status": "actual" if confirmed else "empty",
        # Detected obligations awaiting a yes/no. Excluded from every figure above.
        "suggestions": suggestions,
        "suggestion_count": len(suggestions),
    }


# ---------------------------------------------------------------------------
# Assembly helpers
# ---------------------------------------------------------------------------

def resolve_display_name(profile: Profile, username: str) -> str:
    """The user's actual name, preferring what they typed at onboarding and
    falling back to a tidied-up username so the greeting is never blank."""
    raw = profile.raw_inputs or {}
    for key in ("full_name", "founder_name", "cfo_name"):
        value = (raw.get(key) or "").strip()
        if value:
            return value.split()[0]

    if profile.startup_profile and (profile.startup_profile.founder_name or "").strip():
        return profile.startup_profile.founder_name.strip().split()[0]

    persona = (profile.persona or "").strip()
    if persona and "@" not in persona and "·" not in persona:
        return persona.split()[0]

    name = (username or "").split("@")[0]
    name = name.replace(".", " ").replace("_", " ").replace("-", " ").strip()
    return name.title() if name else "there"


def has_any_financial_data(ctx: HomeContext) -> bool:
    """Whether we know anything at all about this user's money. Drives the
    onboarding empty state — a brand-new user must never be shown a dashboard
    of zeroes dressed up as figures."""
    return bool(
        ctx.transactions
        or ctx.goals
        or ctx.upcoming
        or ctx.fin.savings
        or ctx.fin.income
        or ctx.fin.expenses
    )
