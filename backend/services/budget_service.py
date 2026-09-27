"""
Budget service — compares actual monthly spending against user-defined limits.

`get_budget_status` is the single read path: every caller (API, WhatsApp bot,
scheduler) uses it so the math is never duplicated. It reads `StartupTransaction`
rows for the current calendar month and joins them against `BudgetGoal` rows for
the same profile, returning a per-category status dict that the UI, bot, and
alert system all consume.
"""
from backend.core.money import group_indian
import logging
from datetime import date, datetime
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session
from sqlalchemy import extract

logger = logging.getLogger(__name__)


def get_budget_status(profile_id: int, db: Session, month: Optional[str] = None) -> List[Dict[str, Any]]:
    """Return current-month spending vs. budget limits for every active goal.

    Args:
        profile_id: The user's profile ID.
        db: SQLAlchemy session.
        month: Optional 'YYYY-MM' string. Defaults to the current month.

    Returns:
        List of dicts, one per budget goal:
        {
          id, category, monthly_limit, spent, remaining, pct_used,
          status: 'ok' | 'warning' | 'over',
          currency
        }
    """
    from backend.models.domain import BudgetGoal, StartupTransaction, Profile

    if month:
        year, mon = int(month.split("-")[0]), int(month.split("-")[1])
    else:
        today = date.today()
        year, mon = today.year, today.month

    profile = db.query(Profile).filter(Profile.id == profile_id).first()
    currency = (profile.currency if profile else None) or "Rs."

    goals = db.query(BudgetGoal).filter(
        BudgetGoal.profile_id == profile_id,
        BudgetGoal.is_active == True,
    ).all()

    if not goals:
        return []

    # Load all outflow transactions for the target month in one query
    month_txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile_id,
        StartupTransaction.type == "out",
        extract("year", StartupTransaction.txn_date) == year,
        extract("month", StartupTransaction.txn_date) == mon,
    ).all()

    # Aggregate spending per category
    spent_by_cat: Dict[str, float] = {}
    for t in month_txns:
        key = (t.category or "Other").strip()
        spent_by_cat[key] = spent_by_cat.get(key, 0.0) + (t.amount or 0.0)

    results = []
    for goal in goals:
        spent = round(spent_by_cat.get(goal.category, 0.0), 2)
        limit = goal.monthly_limit
        remaining = round(limit - spent, 2)
        pct_used = round(spent / limit * 100, 1) if limit > 0 else 0.0

        if pct_used >= 100:
            status = "over"
        elif pct_used >= 80:
            status = "warning"
        else:
            status = "ok"

        results.append({
            "id": goal.id,
            "category": goal.category,
            "monthly_limit": limit,
            "spent": spent,
            "remaining": remaining,
            "pct_used": pct_used,
            "status": status,
            "currency": currency,
            "notes": goal.notes,
        })

    return sorted(results, key=lambda x: -x["pct_used"])


def check_and_fire_alerts(db: Session) -> int:
    """Check all active budget goals and send WhatsApp alerts when thresholds
    are crossed. Throttled to at most one alert per goal per calendar day.

    Returns the number of alerts sent.
    """
    from backend.models.domain import BudgetGoal, Profile
    from backend.services.whatsapp_service import send_message

    today = date.today()
    now = datetime.utcnow()
    sent = 0

    profiles = db.query(Profile).filter(Profile.whatsapp_phone.isnot(None)).all()
    for profile in profiles:
        statuses = get_budget_status(profile.id, db)
        for s in statuses:
            if s["status"] not in ("warning", "over"):
                continue

            # Load the goal row to check last_alerted_at
            goal = db.query(BudgetGoal).filter(BudgetGoal.id == s["id"]).first()
            if not goal:
                continue

            # Skip if already alerted today
            if goal.last_alerted_at and goal.last_alerted_at.date() >= today:
                continue

            currency = s["currency"]
            pct = s["pct_used"]
            cat = s["category"]
            limit = s["monthly_limit"]
            spent = s["spent"]
            remaining = s["remaining"]

            if s["status"] == "over":
                msg = (
                    f"🚨 Over Budget Alert!\n"
                    f"You've spent {currency}{group_indian(spent)} on {cat} this month, "
                    f"exceeding your {currency}{group_indian(limit)} limit by {currency}{group_indian(-remaining)}.\n"
                    f"Consider reviewing your {cat} expenses."
                )
            else:
                msg = (
                    f"⚠️ Budget Warning: {cat}\n"
                    f"You've used {pct}% of your {currency}{group_indian(limit)} {cat} budget "
                    f"({currency}{group_indian(spent)} spent, {currency}{group_indian(remaining)} remaining).\n"
                    f"Keep an eye on your {cat} spending!"
                )

            try:
                send_message(profile.whatsapp_phone, msg)
                goal.last_alerted_at = now
                db.commit()
                sent += 1
                logger.info(f"Sent budget alert to profile {profile.id} for category '{cat}' ({pct}%)")
            except Exception as e:
                logger.error(f"Failed to send budget alert to profile {profile.id}: {e}")

    return sent
