from typing import Dict, Any, List
from sqlalchemy.orm import Session
from datetime import datetime, date, timedelta
from backend.models.domain import Profile, FinancialGoal, StartupTransaction
from backend.services import home_service
import json

def process_sweeps(db: Session, profile: Profile, today: date = None) -> Dict[str, Any]:
    """
    Calculates underspend for the past week/month and automatically 
    sweeps it into the user's active goals based on their sweep rules.
    """
    if not today:
        today = datetime.utcnow().date()
        
    if not profile.auto_sweep_enabled:
        return {"swept": False, "reason": "auto_sweep_disabled"}
        
    # Get all active goals
    goals = db.query(FinancialGoal).filter(
        FinancialGoal.profile_id == profile.id,
        FinancialGoal.status == "active"
    ).all()
    
    if not goals:
        return {"swept": False, "reason": "no_active_goals"}

    # Define the time window for underspend calculation (last 30 days)
    start_date = today - timedelta(days=30)
    
    # Get budget (from metrics or raw_inputs)
    budget = 0
    if profile.metrics:
        for metric in profile.metrics:
            if metric.get("key") == "monthly_budget":
                budget = float(metric.get("value", 0))
    if not budget:
        budget = 50000 # default fallback
        
    # Get actual spend
    spend_txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile.id,
        StartupTransaction.type == "out",
        StartupTransaction.txn_date >= start_date,
        StartupTransaction.txn_date <= today
    ).all()
    
    actual_spend = sum(t.amount for t in spend_txns)
    underspend = max(0, budget - actual_spend)
    
    if underspend <= 0:
        return {"swept": False, "reason": "no_underspend"}
        
    sweep_rules = profile.sweep_rules or {}
    swept_amount = 0
    distributed = []
    
    primary_goal = next((g for g in goals if g.is_primary), goals[0])
    
    # Simplified logic: sweep 50% of underspend to primary goal
    sweep_amount = round(underspend * 0.5, 2)
    primary_goal.current_amount += sweep_amount
    swept_amount += sweep_amount
    distributed.append({"goal_id": primary_goal.id, "amount": sweep_amount})
    
    db.commit()
    
    return {
        "swept": True,
        "total_amount": swept_amount,
        "distributed": distributed
    }
