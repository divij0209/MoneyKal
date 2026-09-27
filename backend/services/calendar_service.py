"""
Financial Calendar — one dated view of everything the user's money is about to do.

This is a *projection*, not a store. There is no calendar table: every event is
derived on read from something that already exists —

    upcoming_payments  ->  bills, EMIs, card payments, subscriptions, insurance,
                           tax deadlines, investment debits, expected salary
                           (manual entries and Gmail detections alike)
    financial_goals    ->  contribution dates and target dates
    Hisaab ledger      ->  detected recurring salary, and what actually happened
                           on days that have already passed

so a bill can never exist in two places and drift. Confirming a Gmail-detected
payment through the existing review flow is all it takes for it to appear here.

Adding a future source (WhatsApp, a tax service, a payroll integration) means
writing one provider function and appending it to PROVIDERS. Nothing else in
this module, the API or the frontend has to change: they all work on the
CalendarEvent shape.

Two rules the whole module obeys:

*   An event that is not confirmed is never counted. Detections still awaiting
    review are returned with `tentative: True` and excluded from every total, so
    an uncertain obligation cannot quietly become a number the user relies on.
*   Nothing is invented. A provider that has no data returns no events rather
    than a plausible-looking placeholder.
"""
from dataclasses import dataclass, field, asdict
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional

from backend.services.home_service import (
    HomeContext, add_months, format_money, month_bounds, occurrences_in_range,
)

__all__ = [
    "CalendarEvent", "build_calendar", "build_timeline", "PROVIDERS",
    "EVENT_ICONS", "detect_salary",
]

# Icon and human label per event type. The calendar reads type, never category,
# so a future source only has to pick a type it already understands.
EVENT_ICONS = {
    "salary":       {"icon": "💰", "label": "Salary"},
    "bill":         {"icon": "🧾", "label": "Bill"},
    "credit_card":  {"icon": "💳", "label": "Card payment"},
    "emi":          {"icon": "🏦", "label": "EMI"},
    "subscription": {"icon": "🔁", "label": "Subscription"},
    "insurance":    {"icon": "🛡️", "label": "Insurance"},
    "tax":          {"icon": "🧮", "label": "Tax"},
    "investment":   {"icon": "📈", "label": "Investment"},
    "goal":         {"icon": "🎯", "label": "Goal"},
    "activity":     {"icon": "📊", "label": "Activity"},
    "other":        {"icon": "💸", "label": "Payment"},
}

# Rough ordering when several events land on one day: money arriving first,
# then obligations by how hard they are to move.
TYPE_ORDER = ["salary", "emi", "bill", "credit_card", "insurance", "tax",
              "subscription", "investment", "goal", "other", "activity"]


@dataclass
class CalendarEvent:
    """One dated money event, whatever produced it.

    `source` records where it came from ('upcoming', 'goal', 'ledger') and
    `origin` how it got there ('manual', 'gmail', 'detected'), so the UI can
    say why an event is on the calendar and a future source slots in without a
    new field.
    """
    date: date
    type: str
    title: str
    amount: Optional[float]
    direction: str                 # out | in | none  ('none' = a date, not a payment)
    source: str
    origin: str
    tentative: bool = False        # awaiting the user's confirmation
    ref_id: Optional[int] = None   # the row it came from, for deep links
    detail: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self, currency: str, today: date) -> Dict[str, Any]:
        icon = EVENT_ICONS.get(self.type, EVENT_ICONS["other"])
        d = asdict(self)
        d["date"] = self.date.isoformat()
        d["days_until"] = (self.date - today).days
        d["is_past"] = self.date < today
        d["is_today"] = self.date == today
        d["icon"] = icon["icon"]
        d["type_label"] = icon["label"]
        d["amount_display"] = (format_money(currency, self.amount)
                               if self.amount is not None else None)
        return d


# ---------------------------------------------------------------------------
# Providers — each turns one existing source into events for a window
# ---------------------------------------------------------------------------

def events_from_upcoming(ctx: HomeContext, start: date, end: date) -> List[CalendarEvent]:
    """Bills, EMIs, subscriptions, tax, investments and expected salary.

    Recurring rows are expanded across the window, so a monthly bill shows on
    every month the user pages to rather than only on its next occurrence.
    Rows still in review are carried through as tentative rather than dropped —
    the user should see that something was detected, just not have it counted.
    """
    out: List[CalendarEvent] = []
    for item in ctx.upcoming:
        status = item.status or "confirmed"
        if status == "dismissed":
            continue
        meta = item.source_meta or {}
        for when in occurrences_in_range(item, start, end):
            out.append(CalendarEvent(
                date=when,
                type=item.event_type or _type_from_category(item.category),
                title=item.name or "Payment",
                amount=item.amount,
                direction=item.direction or "out",
                source="upcoming",
                origin=item.source or "manual",
                tentative=(status == "review"),
                ref_id=item.id,
                detail=item.category,
                meta={
                    "recurrence": item.recurrence or "none",
                    "confidence": item.confidence,
                    "sender_domain": meta.get("sender_domain"),
                    "status": status,
                },
            ))
    return out


def events_from_goals(ctx: HomeContext, start: date, end: date) -> List[CalendarEvent]:
    """A goal's monthly contribution, and its target date.

    The contribution figure is the one the Daily Home already shows — remaining
    divided by months left — placed on the same day of the month the goal was
    created. It is a plan, not a debit, so it carries direction 'none' and is
    never added to an outflow total.
    """
    out: List[CalendarEvent] = []
    for g in ctx.goals:
        if not g.target_amount or g.target_amount <= 0:
            continue

        target = g.target_date
        if target and start <= target <= end:
            out.append(CalendarEvent(
                date=target, type="goal",
                title="%s (target date)" % (g.name or "Goal"),
                amount=g.target_amount, direction="none",
                source="goal", origin="manual", ref_id=g.id,
                detail="Target date for this goal",
                meta={"kind": "target", "current": g.current_amount or 0},
            ))

        # Only schedule contributions while the goal is still open and unmet.
        if not target or target < ctx.today:
            continue
        remaining = max((g.target_amount or 0) - (g.current_amount or 0), 0)
        if remaining <= 0:
            continue
        days_left = (target - ctx.today).days
        if days_left <= 0:
            continue
        monthly = round(remaining / max(days_left / 30.44, 0.5), 2)

        anchor_day = (g.created_at.date().day if g.created_at else 1)
        cursor = _clamped(ctx.today.year, ctx.today.month, anchor_day)
        # Walk to the first contribution inside the window, then step monthly.
        for _ in range(60):
            if cursor > end or cursor > target:
                break
            if cursor >= start and cursor >= ctx.today:
                out.append(CalendarEvent(
                    date=cursor, type="goal",
                    title="%s (contribution)" % (g.name or "Goal"),
                    amount=monthly, direction="none",
                    source="goal", origin="manual", ref_id=g.id,
                    detail="To stay on pace for %s" % target.strftime("%d %b %Y"),
                    meta={"kind": "contribution", "goal_target": g.target_amount},
                ))
            cursor = add_months(cursor, 1)
    return out


def detect_salary(ctx: HomeContext) -> Optional[Dict[str, Any]]:
    """Finds a recurring salary in the Hisaab ledger.

    Salary is the one calendar event most users never enter by hand, and the
    ledger already holds it: an income entry categorised Salary, arriving on
    roughly the same day each month. Two occurrences is enough to call it a
    pattern; one is a payment, not a schedule.

    Returns the day of month, the typical amount and how many months back it
    was seen — or None, in which case no salary event is produced at all.
    """
    salary_rows = [t for t in ctx.in_txns
                   if (t.category or "").strip().lower() == "salary" and t.txn_date]
    if len(salary_rows) < 2:
        return None

    # One entry per month; a bonus in the same month must not look like a
    # second salary cycle.
    by_month: Dict[str, Any] = {}
    for t in sorted(salary_rows, key=lambda r: r.txn_date):
        by_month[t.txn_date.strftime("%Y-%m")] = t
    if len(by_month) < 2:
        return None

    recent = list(by_month.values())[-6:]
    days = [t.txn_date.day for t in recent]
    amounts = sorted(t.amount for t in recent)

    # The most common pay day, falling back to the latest one.
    day = max(set(days), key=days.count)
    # Median, so a single bonus-inflated month does not move the expectation.
    typical = amounts[len(amounts) // 2]

    return {
        "day": day,
        "amount": round(typical, 2),
        "months_observed": len(by_month),
        "last_seen": recent[-1].txn_date,
    }


def events_from_salary(ctx: HomeContext, start: date, end: date) -> List[CalendarEvent]:
    """Projects the detected salary forward across the window.

    Deliberately skips any month the salary has already landed in — once it is
    in the ledger it is history, and showing it as still expected would be
    wrong.
    """
    pattern = detect_salary(ctx)
    if not pattern:
        return []

    paid_months = {t.txn_date.strftime("%Y-%m") for t in ctx.in_txns
                   if (t.category or "").strip().lower() == "salary" and t.txn_date}

    out: List[CalendarEvent] = []
    cursor = _clamped(start.year, start.month, pattern["day"])
    for _ in range(24):
        if cursor > end:
            break
        if cursor >= start and cursor.strftime("%Y-%m") not in paid_months:
            out.append(CalendarEvent(
                date=cursor, type="salary",
                title="Salary expected", amount=pattern["amount"], direction="in",
                source="ledger", origin="detected",
                detail="From %d months of Hisaab entries" % pattern["months_observed"],
                meta={"day_of_month": pattern["day"]},
            ))
        cursor = add_months(cursor, 1)
    return out


def events_from_activity(ctx: HomeContext, start: date, end: date) -> List[CalendarEvent]:
    """What actually happened on days that have already passed.

    One rolled-up event per day rather than one per transaction, so clicking a
    past date answers "what did I spend?" without turning the calendar into a
    second Hisaab list.
    """
    by_day: Dict[date, Dict[str, float]] = {}
    for t in ctx.transactions:
        if not t.txn_date or not (start <= t.txn_date <= end) or t.txn_date > ctx.today:
            continue
        e = by_day.setdefault(t.txn_date, {"in": 0.0, "out": 0.0, "count": 0})
        e["count"] += 1
        e["in" if t.type == "in" else "out"] += t.amount

    out = []
    for when, e in by_day.items():
        out.append(CalendarEvent(
            date=when, type="activity",
            title="%d transaction%s" % (e["count"], "" if e["count"] == 1 else "s"),
            amount=round(e["out"], 2) if e["out"] else None,
            direction="out" if e["out"] else "in",
            source="ledger", origin="logged",
            detail="Logged in Hisaab",
            meta={"money_in": round(e["in"], 2), "money_out": round(e["out"], 2),
                  "count": e["count"]},
        ))
    return out


# The extension point. A new source is one function with this signature,
# appended here — the API, the totals and the frontend need no changes.
PROVIDERS: List[Callable[[HomeContext, date, date], List[CalendarEvent]]] = [
    events_from_upcoming,
    events_from_goals,
    events_from_salary,
    events_from_activity,
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clamped(year: int, month: int, day: int) -> date:
    """A date that survives short months — the 31st in February becomes the 28th."""
    first_of_next = date(year + (1 if month == 12 else 0), 1 if month == 12 else month + 1, 1)
    last_day = (first_of_next - timedelta(days=1)).day
    return date(year, month, min(max(day, 1), last_day))


def _type_from_category(category: Optional[str]) -> str:
    """Fallback for rows written before event_type existed and never migrated."""
    mapping = {
        "Subscriptions": "subscription",
        "Utilities & Bills": "bill",
        "Rent / Housing": "bill",
        "Health & Medical": "insurance",
        "Taxes": "tax",
    }
    return mapping.get(category or "", "other")


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def collect_events(ctx: HomeContext, start: date, end: date) -> List[CalendarEvent]:
    """Runs every provider over the window and returns one sorted list.

    A failing provider is skipped rather than allowed to empty the calendar —
    a broken future integration must not take the whole month down with it.
    """
    events: List[CalendarEvent] = []
    for provider in PROVIDERS:
        try:
            events.extend(provider(ctx, start, end) or [])
        except Exception:
            continue
    events.sort(key=lambda e: (
        e.date,
        TYPE_ORDER.index(e.type) if e.type in TYPE_ORDER else len(TYPE_ORDER),
        -(e.amount or 0),
    ))
    return events


def build_calendar(ctx: HomeContext, year: Optional[int] = None,
                   month: Optional[int] = None) -> Dict[str, Any]:
    """A month of events, grouped by day, plus the totals for that month.

    Totals count confirmed, real money movements only: tentative detections and
    goal contributions (which are a plan, not a debit) are reported separately
    so the user can see them without them silently changing a figure.
    """
    anchor = ctx.today
    if year and month:
        try:
            anchor = date(int(year), int(month), 1)
        except ValueError:
            anchor = ctx.today
    first, last = month_bounds(anchor)

    events = collect_events(ctx, first, last)

    days: Dict[str, List[Dict[str, Any]]] = {}
    for e in events:
        days.setdefault(e.date.isoformat(), []).append(e.to_dict(ctx.currency, ctx.today))

    counted = [e for e in events
               if not e.tentative and e.type != "activity" and e.direction in ("in", "out")]
    money_out = round(sum(e.amount or 0 for e in counted if e.direction == "out"), 2)
    money_in = round(sum(e.amount or 0 for e in counted if e.direction == "in"), 2)
    tentative = [e for e in events if e.tentative]

    return {
        "year": first.year,
        "month": first.month,
        "label": first.strftime("%B %Y"),
        "first_day": first.isoformat(),
        "last_day": last.isoformat(),
        # 0 = Sunday, matching the grid the frontend already draws.
        "first_weekday": (first.weekday() + 1) % 7,
        "days_in_month": last.day,
        "today": ctx.today.isoformat(),
        "days": days,
        "totals": {
            "money_out": money_out,
            "money_out_display": format_money(ctx.currency, money_out),
            "money_in": money_in,
            "money_in_display": format_money(ctx.currency, money_in),
            "event_count": len([e for e in events if e.type != "activity"]),
            "tentative_count": len(tentative),
        },
        "currency": ctx.currency,
    }


def build_timeline(ctx: HomeContext, days: int = 30, limit: int = 8) -> Dict[str, Any]:
    """The next N days as a flat list — the calendar's answer without the grid.

    Past activity is excluded here on purpose: this answers "what is coming?",
    and a day that has already happened is not.
    """
    start = ctx.today
    end = ctx.today + timedelta(days=days)
    events = [e for e in collect_events(ctx, start, end) if e.type != "activity"]

    confirmed = [e for e in events if not e.tentative]
    money_out = round(sum(e.amount or 0 for e in confirmed if e.direction == "out"), 2)
    money_in = round(sum(e.amount or 0 for e in confirmed if e.direction == "in"), 2)

    within_7 = [e for e in confirmed if (e.date - ctx.today).days <= 7]
    out_7 = round(sum(e.amount or 0 for e in within_7 if e.direction == "out"), 2)

    return {
        "window_days": days,
        "items": [e.to_dict(ctx.currency, ctx.today) for e in events[:limit]],
        "total_count": len(events),
        "money_out": money_out,
        "money_out_display": format_money(ctx.currency, money_out),
        "money_in": money_in,
        "money_in_display": format_money(ctx.currency, money_in),
        "next_7_days_out": out_7,
        "next_7_days_out_display": format_money(ctx.currency, out_7),
        "next_7_days_count": len(within_7),
        "tentative_count": len([e for e in events if e.tentative]),
    }
