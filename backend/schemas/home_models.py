"""Request/response models for the Daily Home dashboard.

Response bodies are typed loosely on purpose where a section carries a
calculation block or rule-specific related_data — those are open-ended by
design (a new insight rule adds keys without a schema change), and pinning them
down would force a schema edit for every rule. The request models, where
validation actually protects the database, are strict.
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

class HomeUser(BaseModel):
    name: str
    greeting: str
    profile_key: str
    currency: str
    local_date: str


class HomeSnapshot(BaseModel):
    available_money: Dict[str, Any]
    monthly_spending: Dict[str, Any]
    savings_progress: Dict[str, Any]


class HomeResponse(BaseModel):
    user: HomeUser
    financial_snapshot: HomeSnapshot
    insight: Dict[str, Any]
    upcoming: Dict[str, Any]
    primary_goal: Optional[Dict[str, Any]] = None
    goals: List[Dict[str, Any]] = []
    # This month's outflow split by the user's own Hisaab categories.
    spending_overview: Dict[str, Any] = {}
    # The current month of financial events, plus the next 30 days as a list.
    # Both are projections over upcoming_payments, goals and the ledger.
    calendar: Dict[str, Any] = {}
    timeline: Dict[str, Any] = {}
    # False for a brand-new account, so the frontend can show an onboarding
    # state rather than a grid of dashes.
    has_financial_data: bool = True
    health_score: Optional[Dict[str, Any]] = None
    generated_at: str


class GoalResponse(BaseModel):
    id: int
    name: str
    icon: Optional[str] = None
    category: Optional[str] = None
    current_amount: float
    target_amount: float
    current_display: str
    target_display: str
    percentage: Optional[float] = None
    remaining: Optional[float] = None
    remaining_display: Optional[str] = None
    target_date: Optional[str] = None
    days_left: Optional[int] = None
    monthly_required: Optional[float] = None
    monthly_required_display: Optional[str] = None
    is_primary: bool
    status: str
    shared_with_profile_ids: Optional[List[int]] = None


class UpcomingResponse(BaseModel):
    id: int
    name: str
    # Optional because a detected obligation may carry a confident due date
    # without a parseable amount ("your bill is due on the 25th"). A manually
    # created payment always has one — UpcomingCreate requires it.
    amount: Optional[float] = None
    amount_display: Optional[str] = None
    due_date: str
    days_until: int
    urgency: str
    urgency_level: str
    category: Optional[str] = None
    recurrence: str
    is_recurring: bool
    source: str                              # manual | gmail
    direction: str = "out"                   # out | in
    event_type: str = "other"                # bill | emi | subscription | ...
    status: str = "confirmed"                # confirmed | review | dismissed
    confidence: Optional[float] = None       # 0-1 for detected rows; null when manual
    # Provenance shown on a suggestion so the user can recognise the source
    # mail. Deliberately just the sender domain and a truncated subject.
    source_label: Optional[str] = None
    source_subject: Optional[str] = None
    notes: Optional[str] = None
    payment_url: Optional[str] = None


# ---------------------------------------------------------------------------
# Requests
# ---------------------------------------------------------------------------

VALID_RECURRENCE = {"none", "weekly", "monthly", "quarterly", "yearly"}
VALID_UPCOMING_STATUS = {"confirmed", "review", "dismissed"}
VALID_GOAL_STATUS = {"active", "achieved", "archived"}


class GoalCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    target_amount: float = Field(gt=0)
    current_amount: float = Field(default=0.0, ge=0)
    target_date: Optional[str] = None       # ISO YYYY-MM-DD
    category: Optional[str] = None
    icon: Optional[str] = None
    is_primary: bool = False
    shared_with_profile_ids: Optional[List[int]] = None


class GoalUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    target_amount: Optional[float] = Field(default=None, gt=0)
    current_amount: Optional[float] = Field(default=None, ge=0)
    target_date: Optional[str] = None
    category: Optional[str] = None
    icon: Optional[str] = None
    is_primary: Optional[bool] = None
    status: Optional[str] = None
    shared_with_profile_ids: Optional[List[int]] = None


VALID_DIRECTION = {"out", "in"}
VALID_EVENT_TYPE = {"bill", "credit_card", "emi", "subscription", "insurance",
                    "tax", "investment", "salary", "other"}


class UpcomingCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    amount: float = Field(gt=0)
    due_date: str                            # ISO YYYY-MM-DD
    category: Optional[str] = None
    recurrence: str = "none"
    notes: Optional[str] = None
    # Defaults preserve the original meaning of this endpoint: an outflow.
    direction: str = "out"
    event_type: Optional[str] = None
    payment_url: Optional[str] = None


class UpcomingUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    amount: Optional[float] = Field(default=None, gt=0)
    due_date: Optional[str] = None
    category: Optional[str] = None
    recurrence: Optional[str] = None
    notes: Optional[str] = None
    is_active: Optional[bool] = None
    direction: Optional[str] = None
    event_type: Optional[str] = None
    payment_url: Optional[str] = None
