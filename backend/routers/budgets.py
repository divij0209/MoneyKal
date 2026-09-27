"""
Budgets router — CRUD for monthly spending limits.

GET  /budgets        — list all active budget goals for the current user
POST /budgets        — create a new budget goal
PUT  /budgets/{id}   — update a budget goal's limit or notes
DELETE /budgets/{id} — deactivate (soft-delete) a budget goal
GET  /budgets/status — current month's spending vs limits
"""
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import List, Optional

from backend.database import SessionLocal
from backend.models.domain import BudgetGoal, Profile
from backend.core.auth import get_current_user
from backend.services.budget_service import get_budget_status

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/budgets", tags=["Budgets"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Pydantic schemas (local — too small to warrant a separate schema file)
# ---------------------------------------------------------------------------

class BudgetCreate(BaseModel):
    category: str
    monthly_limit: float
    notes: Optional[str] = None


class BudgetUpdate(BaseModel):
    monthly_limit: Optional[float] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None


class BudgetResponse(BaseModel):
    id: int
    category: str
    monthly_limit: float
    is_active: bool
    notes: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("", response_model=List[BudgetResponse])
def list_budgets(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """List all active budget goals for the logged-in user."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return db.query(BudgetGoal).filter(
        BudgetGoal.profile_id == profile.id,
        BudgetGoal.is_active == True,
    ).order_by(BudgetGoal.category).all()


@router.get("/status")
def budget_status(
    month: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Current-month spending vs. limits — the main budget dashboard feed."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return get_budget_status(profile.id, db, month=month)


@router.post("", response_model=BudgetResponse, status_code=201)
def create_budget(
    req: BudgetCreate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Create a new monthly budget limit for a category."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    if req.monthly_limit <= 0:
        raise HTTPException(status_code=400, detail="monthly_limit must be greater than zero")

    # Prevent duplicate active goals for the same category
    existing = db.query(BudgetGoal).filter(
        BudgetGoal.profile_id == profile.id,
        BudgetGoal.category == req.category.strip(),
        BudgetGoal.is_active == True,
    ).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"An active budget for '{req.category}' already exists. Update it instead.")

    goal = BudgetGoal(
        profile_id=profile.id,
        category=req.category.strip(),
        monthly_limit=req.monthly_limit,
        notes=req.notes,
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)
    return goal


@router.put("/{goal_id}", response_model=BudgetResponse)
def update_budget(
    goal_id: int,
    req: BudgetUpdate,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Update an existing budget goal."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    goal = db.query(BudgetGoal).filter(
        BudgetGoal.id == goal_id,
        BudgetGoal.profile_id == profile.id,
    ).first()
    if not goal:
        raise HTTPException(status_code=404, detail="Budget goal not found")

    if req.monthly_limit is not None:
        if req.monthly_limit <= 0:
            raise HTTPException(status_code=400, detail="monthly_limit must be greater than zero")
        goal.monthly_limit = req.monthly_limit
    if req.notes is not None:
        goal.notes = req.notes
    if req.is_active is not None:
        goal.is_active = req.is_active

    db.commit()
    db.refresh(goal)
    return goal


@router.delete("/{goal_id}", status_code=204)
def delete_budget(
    goal_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """Soft-delete a budget goal (sets is_active=False)."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    goal = db.query(BudgetGoal).filter(
        BudgetGoal.id == goal_id,
        BudgetGoal.profile_id == profile.id,
    ).first()
    if not goal:
        raise HTTPException(status_code=404, detail="Budget goal not found")
    goal.is_active = False
    db.commit()
