"""
MoneyKal Financial Health Score Service.

Calculates a 0-100 deterministic health score based on the user's
financial position, spending habits, debt, and goal progress.
"""
from typing import Any, Dict, List
from datetime import date
from backend.services.home_service import HomeContext
from backend.services.live_life_service import EMERGENCY_BUFFER_MONTHS, _complete_month_windows, _has_activity, _sum_out, ESSENTIAL_CATEGORIES

def calculate_health_score(ctx: HomeContext) -> Dict[str, Any]:
    score = 0
    improvements: List[str] = []
    hurting: List[str] = []

    fin = ctx.fin

    # 1. Savings Rate / Surplus (20 points)
    # Target: Save at least 15% of income
    income = fin.income or 0.0
    surplus = fin.surplus or 0.0
    if income > 0:
        savings_rate = surplus / income
        if savings_rate >= 0.20:
            score += 20
            improvements.append("Strong savings rate (20%+ of income)")
        elif savings_rate >= 0.10:
            score += 15
            improvements.append("Healthy savings rate")
        elif savings_rate > 0:
            score += 10
            hurting.append("Savings rate is below recommended 15%")
        else:
            hurting.append("Spending exceeds or matches income")
    else:
        hurting.append("Income data is missing or zero")

    # 2. Emergency Fund (20 points)
    # Target: 3+ months of essential expenses
    savings = fin.savings or 0.0
    expenses = fin.expenses or 0.0
    
    # Calculate measured essential monthly from ledger if possible
    essential_totals = []
    for start, end in _complete_month_windows(ctx.today, 3):
        if _has_activity(ctx, start, end):
            essential_totals.append(_sum_out(ctx, start, end, ESSENTIAL_CATEGORIES))
    
    avg_essential = (sum(essential_totals)/len(essential_totals)) if essential_totals else expenses
    if avg_essential <= 0:
        avg_essential = 1.0 # prevent div by zero

    buffer = savings / avg_essential
    if buffer >= EMERGENCY_BUFFER_MONTHS:
        score += 20
        improvements.append(f"Emergency fund is fully funded ({int(EMERGENCY_BUFFER_MONTHS)}+ months)")
    elif buffer >= 1.5:
        score += 10
        hurting.append("Emergency fund is building, but below 3 month target")
    else:
        hurting.append("Emergency fund is dangerously low")

    # 3. Debt Management (20 points)
    # Target: Loans should be a manageable multiple of income, or 0
    loans = fin.loans or 0.0
    if loans <= 0:
        score += 20
        improvements.append("Debt-free status")
    else:
        if income > 0:
            dti = loans / (income * 12) # Debt to annual income approx
            if dti < 0.3:
                score += 15
                improvements.append("Debt levels are manageable")
            elif dti < 0.6:
                score += 10
                hurting.append("Moderate debt burden")
            else:
                hurting.append("High debt-to-income ratio")
        else:
            score += 5
            hurting.append("Outstanding loans with no stated income")

    # 4. Spending Control (15 points)
    # Compare this month's spending pace to last month's
    import calendar
    days_in_month = calendar.monthrange(ctx.today.year, ctx.today.month)[1]
    progress_pct = ctx.today.day / days_in_month
    
    this_month_spent = sum(t.amount for t in ctx.out_txns if t.txn_date.month == ctx.today.month and t.txn_date.year == ctx.today.year)
    prev_month_spent = sum(t.amount for t in ctx.out_txns if t.txn_date.month == (ctx.today.month - 1 or 12)) # simplistic prev month
    
    # If no prev month data, look at stated expenses
    baseline = prev_month_spent if prev_month_spent > 0 else expenses
    
    if baseline > 0:
        expected_spent_so_far = baseline * progress_pct
        if this_month_spent <= expected_spent_so_far * 1.05:
            score += 15
            improvements.append("Spending is well-controlled this month")
        else:
            score += 5
            hurting.append("Spending is pacing higher than usual this month")
    else:
        score += 10 # Neutral if no data

    # 5. Goal Progress (15 points)
    active_goals = [g for g in ctx.goals if (g.target_amount or 0) > 0 and (g.status or "active") == "active"]
    if not active_goals:
        score += 5
        hurting.append("No active financial goals set")
    else:
        # Give points based on having goals and some progress
        score += 15
        improvements.append(f"Actively working towards {len(active_goals)} goal(s)")

    # 6. Bill Management (10 points)
    # Overdue upcoming payments
    overdue = [p for p in ctx.upcoming if p.due_date and p.due_date < ctx.today and p.status != "dismissed"]
    if overdue:
        score += 0
        hurting.append(f"{len(overdue)} overdue bill(s) detected")
    else:
        score += 10
        improvements.append("All bills are paid on time")

    # Determine status string
    if score >= 80:
        status_text = "Healthy"
        status_color = "green"
    elif score >= 60:
        status_text = "Fair"
        status_color = "yellow"
    else:
        status_text = "Needs Work"
        status_color = "red"

    return {
        "score": score,
        "status_text": status_text,
        "status_color": status_color,
        "improvements": improvements[:3], # Top 3
        "hurting": hurting[:3],           # Top 3
    }
