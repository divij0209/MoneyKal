"""
Agent Tools Registry for MoneyKal's AI Bot.

These Python functions are registered as native Gemini tools, allowing the AI
to call them autonomously when answering complex user questions. Each function
must have clear type hints and a detailed docstring — Gemini reads the docstring
to understand when and how to use the tool.
"""
import logging
from datetime import date, timedelta
from typing import Optional
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Financial Data Tools (read from the user's live database)
# ---------------------------------------------------------------------------

def get_spending_breakdown(profile_id: int, db: Session, month: Optional[str] = None) -> dict:
    """
    Get a breakdown of the user's spending by category for a given month.
    Use this when the user asks about spending habits, monthly expenses, or
    wants to know where their money is going.

    Args:
        profile_id: The user's profile ID.
        db: The database session.
        month: Optional. A month in 'YYYY-MM' format (e.g., '2026-09'). Defaults to the current month.

    Returns:
        A dict with 'total_spent', 'by_category' (list), and 'month' (string).
    """
    from backend.models.domain import StartupTransaction
    from sqlalchemy import extract

    if month:
        year, mon = int(month.split("-")[0]), int(month.split("-")[1])
    else:
        today = date.today()
        year, mon = today.year, today.month

    txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile_id,
        StartupTransaction.type == "out",
        extract("year", StartupTransaction.txn_date) == year,
        extract("month", StartupTransaction.txn_date) == mon,
    ).all()

    by_category: dict = {}
    for t in txns:
        key = t.category or "Other"
        by_category[key] = by_category.get(key, 0.0) + (t.amount or 0.0)

    total = sum(by_category.values())
    sorted_cats = sorted(by_category.items(), key=lambda x: -x[1])

    return {
        "month": f"{year}-{mon:02d}",
        "total_spent": round(total, 2),
        "by_category": [{"category": c, "amount": round(a, 2)} for c, a in sorted_cats],
    }


def get_upcoming_bills(profile_id: int, db: Session, days_ahead: int = 30) -> dict:
    """
    Get a list of the user's upcoming bills and subscriptions due within a
    specified number of days. Use this when the user asks about upcoming payments,
    bills due, or wants to plan for future expenses.

    Args:
        profile_id: The user's profile ID.
        db: The database session.
        days_ahead: How many days in the future to look. Defaults to 30.

    Returns:
        A dict with 'bills' (list of upcoming payments) and 'count'.
    """
    from backend.models.domain import UpcomingPayment

    today = date.today()
    deadline = today + timedelta(days=days_ahead)

    upcoming = db.query(UpcomingPayment).filter(
        UpcomingPayment.profile_id == profile_id,
        UpcomingPayment.is_active == True,
        UpcomingPayment.due_date >= today,
        UpcomingPayment.due_date <= deadline,
    ).order_by(UpcomingPayment.due_date).all()

    bills = []
    for u in upcoming:
        days_left = (u.due_date - today).days
        bills.append({
            "name": u.name,
            "amount": u.amount,
            "due_date": u.due_date.isoformat(),
            "days_until_due": days_left,
            "recurrence": u.recurrence or "none",
            "payment_url": (u.source_meta or {}).get("payment_url"),
        })

    return {"count": len(bills), "bills": bills}


def get_financial_summary(profile_id: int, db: Session) -> dict:
    """
    Get a high-level financial summary for the user, including income, expenses,
    savings balance, and current month's spending. Use this when the user asks
    about their overall financial health, balance, savings, or wants a summary.

    Args:
        profile_id: The user's profile ID.
        db: The database session.

    Returns:
        A dict with income, expenses, savings, surplus, and current month spending.
    """
    from backend.models.domain import Profile, StartupTransaction
    from sqlalchemy import extract

    profile = db.query(Profile).filter(Profile.id == profile_id).first()
    if not profile:
        return {"error": "Profile not found"}

    fin = profile.financial_info or {}
    today = date.today()

    month_txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile_id,
        StartupTransaction.type == "out",
        extract("year", StartupTransaction.txn_date) == today.year,
        extract("month", StartupTransaction.txn_date) == today.month,
    ).all()

    month_spent = round(sum(t.amount or 0 for t in month_txns), 2)
    income = fin.get("income") or 0
    expenses = fin.get("expenses") or 0
    savings = fin.get("savings") or 0

    return {
        "currency": profile.currency or "Rs.",
        "monthly_income": income,
        "monthly_expenses": expenses,
        "savings_balance": savings,
        "monthly_surplus": round(income - expenses, 2),
        "current_month_spent": month_spent,
        "month": today.strftime("%B %Y"),
    }


def search_financial_knowledge(query: str) -> dict:
    """
    Search the MoneyKal financial knowledge base for expert information on
    taxes, investment strategies, personal finance rules, and regulations.
    Use this when the user asks questions about tax rules, investment advice,
    financial planning strategies, SEBI guidelines, or any general financial concept.

    Args:
        query: The user's question or a keyword to look up in the knowledge base.

    Returns:
        A dict with 'results' (list of relevant text excerpts) and 'found' (bool).
    """
    try:
        from backend.services.rag_service import rag_service
        results = rag_service.search(query, top_k=3)
        return {"found": bool(results), "results": results}
    except Exception as e:
        logger.warning(f"RAG search failed: {e}")
        return {"found": False, "results": [], "error": str(e)}


# ---------------------------------------------------------------------------
# Market Data Tools
# ---------------------------------------------------------------------------

def get_stock_or_index_price(ticker: str) -> dict:
    """
    Get the current or recent price of an Indian stock or index by its ticker symbol.
    Use this when the user asks about Nifty50, Sensex, or a specific company's
    current stock price before making an investment decision.

    Args:
        ticker: The Yahoo Finance ticker symbol (e.g., '^NSEI' for Nifty50,
                'RELIANCE.NS' for Reliance, '^BSESN' for Sensex).

    Returns:
        A dict with 'ticker', 'price', 'currency', and 'status'.
    """
    try:
        import yfinance as yf
        t = yf.Ticker(ticker)
        info = t.fast_info
        price = getattr(info, "last_price", None)
        currency = getattr(info, "currency", "INR")
        if price:
            return {"ticker": ticker, "price": round(price, 2), "currency": currency, "status": "ok"}
        return {"ticker": ticker, "price": None, "status": "unavailable"}
    except Exception as e:
        return {"ticker": ticker, "error": str(e), "status": "error"}


def get_budget_status_tool(profile_id: int, db: Session) -> dict:
    """
    Get the current month's spending vs. budget limits for every category the user
    has set a budget for. Use this when the user asks if they are over budget,
    how much they have left in a category, or whether they are on track with spending.

    Args:
        profile_id: The user's profile ID.
        db: The database session.

    Returns:
        A dict with 'statuses' (list per category) showing spent, limit, remaining, and status.
    """
    try:
        from backend.services.budget_service import get_budget_status
        statuses = get_budget_status(profile_id, db)
        return {"statuses": statuses, "count": len(statuses)}
    except Exception as e:
        logger.error(f"get_budget_status_tool failed: {e}")
        return {"error": str(e), "statuses": []}


# ---------------------------------------------------------------------------
# Tool registry for the Gemini API
# ---------------------------------------------------------------------------
# This is what gets passed into generate_with_tools(). Gemini reads
# the function signatures and docstrings to decide when to call each one.
def get_recent_transactions(profile_id: int, db: Session, limit: int = 10, category: Optional[str] = None) -> dict:
    """
    Get a list of the user's most recent individual transactions (spending and income).
    Use this when the user asks for their recent transaction history, asks what they bought
    recently, or wants to see a list of their latest expenses or incomes.

    Args:
        profile_id: The user's profile ID.
        db: The database session.
        limit: How many recent transactions to fetch. Defaults to 10, max 20.
        category: Optional. Filter transactions by a specific category (e.g., "Food & Dining").

    Returns:
        A dict with 'transactions' (list of recent transactions) and 'count'.
    """
    from backend.models.domain import StartupTransaction
    
    query = db.query(StartupTransaction).filter(StartupTransaction.profile_id == profile_id)
    if category:
        query = query.filter(StartupTransaction.category.ilike(f"%{category}%"))
        
    txns = query.order_by(StartupTransaction.txn_date.desc()).limit(min(limit, 20)).all()
    
    result_list = []
    for t in txns:
        result_list.append({
            "date": t.txn_date.isoformat(),
            "amount": t.amount,
            "type": t.type,
            "category": t.category,
            "description": t.description
        })
        
    return {"count": len(result_list), "transactions": result_list}

ALL_TOOLS = [
    get_spending_breakdown,
    get_upcoming_bills,
    get_financial_summary,
    search_financial_knowledge,
    get_stock_or_index_price,
    get_budget_status_tool,
    get_recent_transactions,
]
