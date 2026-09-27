"""Request/response models for live.life.fully.

Typed the same way home_models.py is: the response bodies stay loose where a
section carries a calculation block or a rule-specific payload (a new moment
rule should not force a schema edit), while the request model — the only place
validation protects anything — is strict.
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class LiveLifeUser(BaseModel):
    name: str
    currency: str
    local_date: str


class LiveLifeResponse(BaseModel):
    user: LiveLifeUser
    # The identity block lives server-side so the tagline and its two lines are
    # one string away from being localised, A/B'd or personalised later.
    identity: Dict[str, Any]
    freedom_balance: Dict[str, Any]
    # The same balance, explained: the flow from income to what is left, what
    # is shaping it, what would change it, and a plain-language reading.
    # Optional so an older client, or the mobile app, can ignore it.
    freedom_story: Optional[Dict[str, Any]] = None
    stash: Dict[str, Any]
    categories: List[Dict[str, Any]] = []
    # The single strongest "go and live" moment, its runners-up, and — when
    # nothing qualified — an honest explanation of what would unlock one.
    moment: Optional[Dict[str, Any]] = None
    moment_alternatives: List[Dict[str, Any]] = []
    moment_locked: Optional[Dict[str, Any]] = None
    upcoming_adventure: Optional[Dict[str, Any]] = None
    recommendation: Optional[Dict[str, Any]] = None
    tradeoffs: Optional[Dict[str, Any]] = None
    # False for a brand-new account, so the client can show the onboarding
    # state instead of a screen of dashes.
    has_financial_data: bool = True
    generated_at: str


class AffordabilityRequest(BaseModel):
    amount: float = Field(gt=0, le=1_000_000_000)
    # When present, the delay estimate is reported against this goal rather
    # than whichever one has the nearest deadline.
    goal_id: Optional[int] = None
    local_date: Optional[str] = None      # ISO YYYY-MM-DD, the viewer's own date
    split_count: int = 1

class ItineraryRequest(BaseModel):
    category_id: str
    category_name: str
    budget: float
    currency: str = "₹"
    split_count: int = 1
