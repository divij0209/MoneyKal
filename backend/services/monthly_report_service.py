"""
Monthly financial report builder.

`build_monthly_report` computes a structured summary of a profile's finances for
a given month: income, expenses, top categories, budget performance, goal progress,
and a short Gemini-generated financial tip retrieved from the RAG knowledge base.

`format_monthly_report_whatsapp` renders the report as a WhatsApp-friendly string.
"""
import logging
from datetime import date, timedelta
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session
from sqlalchemy import extract

logger = logging.getLogger(__name__)


def _get_month_bounds(year: int, month: int):
    first = date(year, month, 1)
    if month == 12:
        last = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        last = date(year, month + 1, 1) - timedelta(days=1)
    return first, last


def build_monthly_report(profile, db: Session, target_month: Optional[date] = None) -> Dict[str, Any]:
    """Compute a complete monthly financial report.

    Args:
        profile: The Profile ORM object.
        db: SQLAlchemy session.
        target_month: A date object within the target month. Defaults to last month
                      (because this runs on the 1st, looking back at the month just ended).
    Returns:
        A structured dict with all report fields.
    """
    from backend.models.domain import StartupTransaction, FinancialGoal
    from backend.services.budget_service import get_budget_status

    # Default to last month (report runs on the 1st for the month just ended)
    if not target_month:
        today = date.today()
        first_of_this_month = today.replace(day=1)
        target_month = first_of_this_month - timedelta(days=1)

    year, month = target_month.year, target_month.month
    month_name = target_month.strftime("%B %Y")
    currency = profile.currency or "Rs."

    # Fetch all transactions for target month
    txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile.id,
        extract("year", StartupTransaction.txn_date) == year,
        extract("month", StartupTransaction.txn_date) == month,
    ).all()

    income = round(sum(t.amount for t in txns if t.type == "in"), 2)
    expenses = round(sum(t.amount for t in txns if t.type == "out"), 2)
    net_savings = round(income - expenses, 2)

    # Category breakdown
    by_cat: Dict[str, float] = {}
    for t in txns:
        if t.type == "out":
            key = t.category or "Other"
            by_cat[key] = by_cat.get(key, 0.0) + (t.amount or 0.0)
    top_categories = sorted(by_cat.items(), key=lambda x: -x[1])[:3]

    # Previous month comparison
    prev_month = target_month.replace(day=1) - timedelta(days=1)
    prev_txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile.id,
        StartupTransaction.type == "out",
        extract("year", StartupTransaction.txn_date) == prev_month.year,
        extract("month", StartupTransaction.txn_date) == prev_month.month,
    ).all()
    prev_expenses = round(sum(t.amount for t in prev_txns), 2)
    mom_change_pct = None
    if prev_expenses > 0:
        mom_change_pct = round((expenses - prev_expenses) / prev_expenses * 100, 1)

    # Budget performance for the month
    budget_statuses = get_budget_status(profile.id, db, month=f"{year}-{month:02d}")
    over_budget = [b for b in budget_statuses if b["status"] == "over"]
    on_track = [b for b in budget_statuses if b["status"] == "ok"]

    # Goal progress
    goal_summary = None
    try:
        goal = db.query(FinancialGoal).filter(
            FinancialGoal.profile_id == profile.id,
            FinancialGoal.status == "active",
            FinancialGoal.is_primary == True,
        ).first()
        if goal and goal.target_amount:
            pct = round(min((goal.current_amount or 0) / goal.target_amount * 100, 100), 1)
            goal_summary = {"name": goal.name, "pct": pct, "current": goal.current_amount, "target": goal.target_amount}
    except Exception:
        pass

    # AI financial tip (from RAG)
    financial_tip = _get_financial_tip(top_categories, over_budget)

    return {
        "month": month_name,
        "currency": currency,
        "income": income,
        "expenses": expenses,
        "net_savings": net_savings,
        "top_categories": [{"category": c, "amount": round(a, 2)} for c, a in top_categories],
        "prev_month_expenses": prev_expenses,
        "mom_change_pct": mom_change_pct,
        "budget_over": over_budget,
        "budget_on_track": on_track,
        "goal": goal_summary,
        "financial_tip": financial_tip,
        "transaction_count": len(txns),
    }


def _get_financial_tip(top_categories, over_budget) -> str:
    """Use RAG to fetch a relevant financial tip based on the user's situation."""
    try:
        from backend.services.rag_service import rag_service
        if over_budget:
            query = f"how to reduce {over_budget[0]['category']} spending budget tips"
        elif top_categories:
            query = f"personal finance tips for {top_categories[0][0]} spending India"
        else:
            query = "monthly savings tips personal finance India"

        results = rag_service.search(query, top_k=1)
        if results:
            # Extract the first 200 characters as a concise tip
            tip = results[0][:250].strip()
            return tip
    except Exception as e:
        logger.warning(f"RAG tip retrieval failed: {e}")
    return "Track your spending every month to identify where your money goes — awareness is the first step to saving more."


def format_monthly_report_whatsapp(report: Dict[str, Any]) -> str:
    """Render a monthly report as a WhatsApp message."""
    c = report["currency"]
    lines = [
        f"📊 *MoneyKal Monthly Report — {report['month']}*",
        "",
        f"💰 Income:    {c}{report['income']:,.0f}",
        f"💸 Expenses:  {c}{report['expenses']:,.0f}",
        f"🏦 Net Saved: {c}{report['net_savings']:,.0f}",
    ]

    # Month-over-month
    if report.get("mom_change_pct") is not None:
        chg = report["mom_change_pct"]
        emoji = "📈" if chg > 0 else "📉"
        lines.append(f"{emoji} vs Last Month: {'+' if chg > 0 else ''}{chg}% in spending")

    # Top categories
    if report["top_categories"]:
        lines.append("")
        lines.append("🏆 *Top Spending Categories:*")
        for i, cat in enumerate(report["top_categories"], 1):
            lines.append(f"  {i}. {cat['category']}: {c}{cat['amount']:,.0f}")

    # Budget alerts
    if report["budget_over"]:
        lines.append("")
        lines.append("🚨 *Over Budget:*")
        for b in report["budget_over"]:
            lines.append(f"  • {b['category']}: {b['pct_used']}% of {c}{b['monthly_limit']:,.0f}")

    # Goal progress
    if report.get("goal"):
        g = report["goal"]
        lines.append("")
        lines.append(f"🎯 Goal '{g['name']}': {g['pct']}% complete ({c}{g['current']:,.0f} / {c}{g['target']:,.0f})")

    # AI tip
    if report.get("financial_tip"):
        lines.append("")
        lines.append(f"💡 *Tip of the Month:*")
        lines.append(report["financial_tip"])

    lines.append("")
    lines.append("View full details on your MoneyKal dashboard!")
    return "\n".join(lines)
