"""
MoneyKal Insight — deterministic personal-finance insight generation.

One insight is shown on the Daily Home, and it must be the single most useful
thing we can truthfully say about this user's money right now. That selection is
made here, by rules, not by a language model:

*   Each rule inspects the user's real data and either returns an Insight or
    returns None because the data does not support it. A rule never softens a
    number, never extrapolates, and never fires on a sample too small to mean
    anything (see MIN_* below).
*   Every Insight carries a numeric relevance score. The highest-scoring one
    wins, so the dashboard surfaces "you are about to overdraw" ahead of "your
    groceries went up a bit" without any hand-maintained ordering.
*   related_data carries the raw figures the message was built from. This is the
    seam for later enrichment: a Financial Twin / RAG / LangChain layer can take
    a selected Insight and rephrase or deepen it, while the *choice* of what to
    say and the numbers behind it stay deterministic and auditable. Nothing in
    this module calls an LLM, and nothing downstream needs one for it to work.

To add an insight, write a function taking (ctx, extras) and returning an
Insight or None, and append it to RULES.
"""
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any, Callable, Dict, List, Optional

from backend.services.home_service import (
    HomeContext, format_money, month_bounds,
)

# Thresholds. Below these, a comparison is noise dressed up as a finding.
MIN_TXNS_FOR_INSIGHT = 3        # fewer than this and we say so instead of guessing
MIN_WEEKS_OF_HISTORY = 2        # a weekly average needs at least two prior weeks
NOISE_FLOOR = 300.0             # rupee amounts below this are not worth a headline
MIN_PCT_CHANGE = 10.0           # a change smaller than this is not a story


PRIORITY_RANK = {"high": 3, "medium": 2, "low": 1}


@dataclass
class Insight:
    type: str
    title: str
    message: str
    priority: str                       # high | medium | low
    score: float                        # relevance; highest wins
    related_data: Dict[str, Any] = field(default_factory=dict)
    action: Optional[Dict[str, str]] = None   # {"label": ..., "view": ...}

    def to_dict(self) -> Dict[str, Any]:
        return {
            "type": self.type,
            "title": self.title,
            "message": self.message,
            "priority": self.priority,
            "related_data": self.related_data,
            "action": self.action,
            # Marks where the wording came from. A future LLM/RAG layer that
            # rephrases an insight should flip this, leaving the audit trail
            # honest about what was computed vs. what was generated.
            "generated_by": "rules",
        }


# ---------------------------------------------------------------------------
# Shared derivations, computed once and passed to every rule
# ---------------------------------------------------------------------------

def _week_bounds(anchor: date) -> tuple:
    monday = anchor - timedelta(days=anchor.weekday())
    return monday, monday + timedelta(days=6)


def derive(ctx: HomeContext) -> Dict[str, Any]:
    """Everything the rules compare against, derived once from the ledger."""
    today = ctx.today
    out = ctx.out_txns

    week_start, week_end = _week_bounds(today)
    this_week = [t for t in out if week_start <= t.txn_date <= week_end]
    this_week_total = sum(t.amount for t in this_week)

    # Historical weekly average, excluding the current (partial) week so a
    # Monday-morning comparison is not automatically "you are spending less".
    prior_weeks: Dict[date, float] = {}
    for t in out:
        if t.txn_date >= week_start:
            continue
        wk = t.txn_date - timedelta(days=t.txn_date.weekday())
        prior_weeks[wk] = prior_weeks.get(wk, 0.0) + t.amount
    weekly_avg = (sum(prior_weeks.values()) / len(prior_weeks)) if prior_weeks else None

    m_first, m_last = month_bounds(today)
    p_last = m_first - timedelta(days=1)
    p_first, _ = month_bounds(p_last)
    this_month = [t for t in out if m_first <= t.txn_date <= m_last]
    prev_month = [t for t in out if p_first <= t.txn_date <= p_last]
    this_month_total = sum(t.amount for t in this_month)
    prev_month_total = sum(t.amount for t in prev_month)

    def bucket(txns):
        b: Dict[str, float] = {}
        for t in txns:
            b[t.category or "Uncategorized"] = b.get(t.category or "Uncategorized", 0.0) + t.amount
        return b

    # Money in, this month vs last — used for the savings-improving rule.
    inc = ctx.in_txns
    this_month_in = sum(t.amount for t in inc if m_first <= t.txn_date <= m_last)
    prev_month_in = sum(t.amount for t in inc if p_first <= t.txn_date <= p_last)

    return {
        "today": today,
        "week_start": week_start,
        "this_week_total": this_week_total,
        "this_week_count": len(this_week),
        "weekly_avg": weekly_avg,
        "prior_week_count": len(prior_weeks),
        "this_month_total": this_month_total,
        "prev_month_total": prev_month_total,
        "this_month_txns": this_month,
        "prev_month_txns": prev_month,
        "this_month_by_cat": bucket(this_month),
        "prev_month_by_cat": bucket(prev_month),
        "this_month_in": this_month_in,
        "prev_month_in": prev_month_in,
        "month_name": m_first.strftime("%B"),
        "prev_month_name": p_first.strftime("%B"),
        # Fraction of the month elapsed — lets a mid-month total be compared
        # against a full previous month without overstating the gap.
        "month_progress": (today - m_first).days / max((m_last - m_first).days, 1),
    }


# ---------------------------------------------------------------------------
# Rules — each returns an Insight or None
# ---------------------------------------------------------------------------

def rule_weekly_spending_vs_average(ctx: HomeContext, d: Dict[str, Any]) -> Optional[Insight]:
    """This week's spend against the user's own historical weekly average."""
    avg = d["weekly_avg"]
    if avg is None or d["prior_week_count"] < MIN_WEEKS_OF_HISTORY:
        return None
    if avg < NOISE_FLOOR or d["this_week_total"] < NOISE_FLOOR:
        return None

    change = (d["this_week_total"] - avg) / avg * 100
    if abs(change) < MIN_PCT_CHANGE:
        return None

    higher = change > 0
    pct = abs(round(change))
    return Insight(
        type="spending_increase" if higher else "spending_decrease",
        title="Spending is higher this week" if higher else "Spending is lighter this week",
        message=(
            "Your spending this week is %d%% %s than your usual pattern, %s so far against a "
            "typical %s." % (
                pct, "higher" if higher else "lower",
                format_money(ctx.currency, d["this_week_total"]),
                format_money(ctx.currency, avg),
            )
        ),
        priority="high" if higher and pct >= 25 else ("medium" if higher else "low"),
        # Weighted by how unusual the week is, so a 60% jump outranks a 12% one.
        score=(58 if higher else 30) + min(pct, 60) * 0.35,
        related_data={
            "this_week_total": round(d["this_week_total"], 2),
            "weekly_average": round(avg, 2),
            "change_pct": round(change, 1),
            "weeks_of_history": d["prior_week_count"],
        },
        action={"label": "Review in Hisaab", "view": "hisaab"},
    )


def rule_month_over_month(ctx: HomeContext, d: Dict[str, Any]) -> Optional[Insight]:
    """This month's spend against last month, pace-adjusted for the part of the
    month that has actually elapsed."""
    prev = d["prev_month_total"]
    if prev < NOISE_FLOOR or not d["prev_month_txns"]:
        return None
    if d["this_month_total"] < NOISE_FLOOR:
        return None

    progress = max(d["month_progress"], 0.15)   # avoid wild projections on day 1
    projected = d["this_month_total"] / progress
    change = (projected - prev) / prev * 100
    if abs(change) < MIN_PCT_CHANGE:
        return None

    higher = change > 0
    pct = abs(round(change))
    return Insight(
        type="monthly_trend_up" if higher else "monthly_trend_down",
        title=("On pace to outspend %s" % d["prev_month_name"]) if higher
              else ("Tracking below %s" % d["prev_month_name"]),
        message=(
            "You have spent %s so far in %s. At this pace you would finish around %d%% %s than "
            "%s's %s." % (
                format_money(ctx.currency, d["this_month_total"]), d["month_name"],
                pct, "higher" if higher else "lower",
                d["prev_month_name"], format_money(ctx.currency, prev),
            )
        ),
        priority="medium" if higher else "low",
        score=(46 if higher else 26) + min(pct, 50) * 0.25,
        related_data={
            "this_month_total": round(d["this_month_total"], 2),
            "previous_month_total": round(prev, 2),
            "projected_total": round(projected, 2),
            "change_pct": round(change, 1),
        },
        action={"label": "Review in Hisaab", "view": "hisaab"},
    )


# A category has to move real money, not just a big percentage of a small
# number, before it is worth the one insight slot: a 100% jump on 900 rupees is
# arithmetically true and practically meaningless.
CATEGORY_SPIKE_MIN_DELTA = NOISE_FLOOR * 2          # absolute rupees moved
CATEGORY_SPIKE_MIN_SHARE = 5.0                      # % of the month's total spend


def rule_category_spike(ctx: HomeContext, d: Dict[str, Any]) -> Optional[Insight]:
    """The category responsible for the largest real increase this month.

    Ranked by rupees moved rather than by percentage change, so the message's
    claim to be the user's biggest category movement is literally true, and a
    tiny category doubling cannot outrank a genuine shift in where the money
    goes."""
    if not d["prev_month_by_cat"]:
        return None
    month_total = d["this_month_total"]
    if month_total <= 0:
        return None

    best = None
    for cat, amount in d["this_month_by_cat"].items():
        if amount < NOISE_FLOOR:
            continue
        prev = d["prev_month_by_cat"].get(cat, 0.0)
        if prev < NOISE_FLOOR:
            continue
        delta = amount - prev
        if delta < CATEGORY_SPIKE_MIN_DELTA:
            continue
        share = delta / month_total * 100
        if share < CATEGORY_SPIKE_MIN_SHARE:
            continue
        change = delta / prev * 100
        if change < 25:
            continue
        if best is None or delta > best[0]:
            best = (delta, cat, amount, prev, change, share)

    if not best:
        return None
    delta, cat, amount, prev, change, share = best
    pct = round(change)
    return Insight(
        type="category_spike",
        title="%s is up this month" % cat,
        message=(
            "%s spending is %d%% higher than last month, %s versus %s. That %s swing is your "
            "biggest category movement." % (
                cat, pct,
                format_money(ctx.currency, amount), format_money(ctx.currency, prev),
                format_money(ctx.currency, delta),
            )
        ),
        priority="medium",
        # Weighted by how much of the month's spending the swing accounts for,
        # so the score tracks impact rather than ratio.
        score=42 + min(share, 50) * 0.7,
        related_data={
            "category": cat,
            "this_month": round(amount, 2),
            "previous_month": round(prev, 2),
            "increase": round(delta, 2),
            "share_of_month_pct": round(share, 1),
            "change_pct": round(change, 1),
        },
        action={"label": "Review in Hisaab", "view": "hisaab"},
    )


def rule_upcoming_vs_available(ctx: HomeContext, upcoming: Dict[str, Any],
                               available: Dict[str, Any]) -> Optional[Insight]:
    """Committed outflows over the next 30 days, weighed against what is
    actually available. The highest-stakes thing the dashboard can say."""
    total = upcoming.get("next_30_days_total") or 0
    if total < NOISE_FLOOR or not upcoming.get("next_30_days_count"):
        return None
    money = available.get("value")
    if money is None or money <= 0:
        return None

    share = total / money * 100
    if share < 25:
        return None

    tight = share >= 60
    return Insight(
        type="upcoming_pressure",
        title="Upcoming payments need room" if tight else "Payments due in the next month",
        message=(
            "%s across %d payment%s falls due in the next 30 days, about %d%% of the %s you "
            "have available." % (
                format_money(ctx.currency, total),
                upcoming["next_30_days_count"],
                "" if upcoming["next_30_days_count"] == 1 else "s",
                round(share), format_money(ctx.currency, money),
            )
        ),
        priority="high" if tight else "medium",
        # Deliberately the strongest scorer: a liquidity squeeze outranks any
        # retrospective spending comparison.
        score=68 + min(share, 100) * 0.30,
        related_data={
            "upcoming_total": round(total, 2),
            "available_money": round(money, 2),
            "share_pct": round(share, 1),
            "payment_count": upcoming["next_30_days_count"],
        },
        action={"label": "See what's due", "view": "overview"},
    )


def rule_goal_pace(ctx: HomeContext, goals: Dict[str, Any]) -> Optional[Insight]:
    """Whether the primary goal is ahead of or behind the pace its own deadline
    requires. Only fires for a goal that actually has a deadline."""
    goal = goals.get("primary_goal")
    if not goal or not goal.get("target_date") or goal.get("percentage") is None:
        return None
    days_left = goal.get("days_left")
    if days_left is None or days_left <= 0:
        return None
    if goal["target_amount"] < NOISE_FLOOR:
        return None

    monthly = goal.get("monthly_required")
    if monthly is None:
        return None

    # Compare the required monthly contribution against the surplus the user's
    # own stated income and expenses imply.
    surplus = ctx.fin.surplus if ctx.fin else None
    if surplus is None or surplus <= 0:
        # No surplus to judge against — still worth reporting the requirement.
        return Insight(
            type="goal_pace",
            title="%s needs %s a month" % (goal["name"], goal["monthly_required_display"]),
            message=(
                "You are %s%% of the way to %s. Reaching it by %s means setting aside about %s "
                "a month from here." % (
                    _fmt_pct(goal["percentage"]), goal["name"],
                    _fmt_date(goal["target_date"]), goal["monthly_required_display"],
                )
            ),
            priority="medium",
            score=40,
            related_data={"goal": goal["name"], "percentage": goal["percentage"],
                          "monthly_required": monthly, "days_left": days_left},
            action={"label": "Simulate it", "view": "simulate"},
        )

    behind = monthly > surplus
    if not behind and surplus > 0:
        # Calculate how early they will hit it
        months_needed = (goal["target_amount"] - (goal.get("current_amount") or 0)) / surplus
        days_needed = months_needed * 30.44
        days_early = days_left - days_needed
        if days_early > 30:
            months_early = int(days_early / 30.44)
            message = (
                "If you maintain your current savings rate of %s, you'll reach your %s goal "
                "%d month%s early." % (
                    format_money(ctx.currency, surplus), goal["name"],
                    months_early, "" if months_early == 1 else "s"
                )
            )
        else:
            message = (
                "You are %s%% of the way to %s. Hitting %s by %s needs about %s a month, against the "
                "%s your income leaves you." % (
                    _fmt_pct(goal["percentage"]), goal["name"], goal["target_display"],
                    _fmt_date(goal["target_date"]), goal["monthly_required_display"],
                    format_money(ctx.currency, surplus),
                )
            )
    else:
        message = (
            "You are %s%% of the way to %s. Hitting %s by %s needs about %s a month, against the "
            "%s your income leaves you." % (
                _fmt_pct(goal["percentage"]), goal["name"], goal["target_display"],
                _fmt_date(goal["target_date"]), goal["monthly_required_display"],
                format_money(ctx.currency, surplus),
            )
        )

    return Insight(
        type="goal_behind" if behind else "goal_on_track",
        title=("%s is behind pace" % goal["name"]) if behind else ("%s is on track" % goal["name"]),
        message=message,
        priority="medium" if behind else "low",
        score=(50 if behind else 28),
        related_data={
            "goal": goal["name"],
            "percentage": goal["percentage"],
            "monthly_required": monthly,
            "monthly_surplus": round(surplus, 2),
            "days_left": days_left,
        },
        action={"label": "Simulate it", "view": "simulate"},
    )


def rule_savings_improving(ctx: HomeContext, d: Dict[str, Any]) -> Optional[Insight]:
    """Net position this month against last, from recorded activity only."""
    if not d["prev_month_txns"] or not d["this_month_txns"]:
        return None
    this_net = d["this_month_in"] - d["this_month_total"]
    prev_net = d["prev_month_in"] - d["prev_month_total"]
    if abs(prev_net) < NOISE_FLOOR:
        return None
    delta = this_net - prev_net
    if delta <= NOISE_FLOOR:
        return None

    return Insight(
        type="savings_improving",
        title="You are keeping more this month",
        message=(
            "Money in minus money out is %s so far in %s, %s better than %s." % (
                format_money(ctx.currency, this_net), d["month_name"],
                format_money(ctx.currency, delta), d["prev_month_name"],
            )
        ),
        priority="low",
        score=34,
        related_data={
            "this_month_net": round(this_net, 2),
            "previous_month_net": round(prev_net, 2),
            "improvement": round(delta, 2),
        },
    )


def rule_thin_buffer(ctx: HomeContext, available: Dict[str, Any]) -> Optional[Insight]:
    """Available money measured in months of the user's own expenses."""
    money = available.get("value")
    expenses = ctx.fin.expenses if ctx.fin else 0
    if money is None or not expenses or expenses <= 0:
        return None
    months = money / expenses
    if months >= 6:
        return None

    return Insight(
        type="buffer_thin",
        title="Your buffer is under six months",
        message=(
            "The %s you have available covers about %.1f months of your %s monthly expenses. Six "
            "months is the usual safety mark." % (
                format_money(ctx.currency, money), months,
                format_money(ctx.currency, expenses),
            )
        ),
        priority="high" if months < 3 else "medium",
        score=52 + max(0, (6 - months)) * 3.5,
        related_data={
            "available_money": round(money, 2),
            "monthly_expenses": round(expenses, 2),
            "buffer_months": round(months, 1),
        },
        action={"label": "Simulate it", "view": "simulate"},
    )


def rule_no_goal(ctx: HomeContext, goals: Dict[str, Any]) -> Optional[Insight]:
    """A low-scoring nudge that only wins when nothing more substantial applies."""
    if goals.get("primary_goal"):
        return None
    if not ctx.transactions:
        return None
    return Insight(
        type="no_goal",
        title="You have not set a goal yet",
        message=(
            "MoneyKal is tracking your spending, but nothing to aim at. Setting one goal turns "
            "these numbers into progress."
        ),
        priority="low",
        score=14,
        related_data={},
        action={"label": "Set a goal", "view": "overview"},
    )


def _fmt_pct(v: Optional[float]) -> str:
    if v is None:
        return "0"
    return ("%.0f" % v) if abs(v - round(v)) < 0.05 else ("%.1f" % v)


def _fmt_date(iso: Optional[str]) -> str:
    if not iso:
        return "the deadline"
    try:
        return date.fromisoformat(iso).strftime("%d %b %Y")
    except ValueError:
        return iso


def rule_savings_pace(ctx: HomeContext, d: Dict[str, Any]) -> Optional[Insight]:
    """If the user is on track to save more than they did last month."""
    if not d["prev_month_txns"] or d["this_month_in"] <= 0:
        return None
    prev_net = d["prev_month_in"] - d["prev_month_total"]
    if prev_net < NOISE_FLOOR:
        return None
        
    progress = max(d["month_progress"], 0.15)
    projected_in = d["this_month_in"] / progress
    projected_out = d["this_month_total"] / progress
    projected_net = projected_in - projected_out
    
    delta = projected_net - prev_net
    if delta < NOISE_FLOOR:
        return None
        
    return Insight(
        type="savings_pace",
        title="On track to save more than last month",
        message=(
            "You are on track to save %s more than last month. If you maintain this pace, you'll "
            "end %s with a surplus of %s." % (
                format_money(ctx.currency, delta), d["month_name"],
                format_money(ctx.currency, projected_net),
            )
        ),
        priority="low",
        score=36 + min(delta / prev_net * 100, 50) * 0.25,
        related_data={
            "projected_surplus": round(projected_net, 2),
            "previous_surplus": round(prev_net, 2),
            "increase": round(delta, 2),
        }
    )

# Rules taking only (ctx, derived). Rules needing the built sections are
# invoked explicitly in generate_insight below.
RULES: List[Callable[[HomeContext, Dict[str, Any]], Optional[Insight]]] = [
    rule_weekly_spending_vs_average,
    rule_month_over_month,
    rule_category_spike,
    rule_savings_improving,
    rule_savings_pace,
]


# ---------------------------------------------------------------------------
# Selection
# ---------------------------------------------------------------------------

def insufficient_history_insight(ctx: HomeContext, has_data: bool) -> Insight:
    """What we say when the data cannot support a real finding. Explicitly an
    insight of its own rather than a blank card, so the page always answers the
    question it asks — and tells the user how to unlock a better answer."""
    if not has_data:
        return Insight(
            type="onboarding",
            title="Let's get your twin started",
            message=(
                "Add your income, savings and expenses, or log your first transaction, and "
                "MoneyKal will start reading your money for you."
            ),
            priority="medium",
            score=0,
            related_data={},
            action={"label": "Add your details", "view": "overview"},
        )
    return Insight(
        type="insufficient_history",
        title="Building your picture",
        message=(
            "Keep using MoneyKal to unlock personalised insights, a couple of weeks of "
            "transactions is enough to start spotting patterns in your spending."
        ),
        priority="low",
        score=0,
        related_data={"transactions_logged": len(ctx.transactions)},
        action={"label": "Log a transaction", "view": "hisaab"},
    )


def generate_insight(ctx: HomeContext, upcoming: Dict[str, Any], goals: Dict[str, Any],
                     available: Dict[str, Any], has_data: bool) -> Dict[str, Any]:
    """Runs every rule and returns the single most relevant insight.

    Rules that depend on data outside the ledger (upcoming payments, goals, the
    available-money figure) are called with what they need; the rest take only
    the derived ledger stats."""
    candidates: List[Insight] = []

    # These do not need transaction history — an upcoming payment the user
    # entered today is a legitimate finding on day one.
    for produced in (
        rule_upcoming_vs_available(ctx, upcoming, available),
        rule_goal_pace(ctx, goals),
        rule_thin_buffer(ctx, available),
    ):
        if produced:
            candidates.append(produced)

    # Ledger-derived rules need enough history to mean something.
    if len(ctx.transactions) >= MIN_TXNS_FOR_INSIGHT:
        derived = derive(ctx)
        for rule in RULES:
            try:
                produced = rule(ctx, derived)
            except (TypeError, ValueError, ZeroDivisionError):
                # A single misbehaving rule must never take the dashboard down.
                produced = None
            if produced:
                candidates.append(produced)
        nudge = rule_no_goal(ctx, goals)
        if nudge:
            candidates.append(nudge)

    if not candidates:
        return insufficient_history_insight(ctx, has_data).to_dict()

    best = max(candidates, key=lambda i: (i.score, PRIORITY_RANK.get(i.priority, 0)))
    payload = best.to_dict()
    # The runners-up are returned too: they cost nothing extra to compute and
    # give a future Ask-Twin / WhatsApp layer more than one thing to talk about
    # without re-deriving any of this.
    payload["alternatives"] = [
        i.to_dict() for i in sorted(candidates, key=lambda i: -i.score) if i is not best
    ][:3]
    return payload
