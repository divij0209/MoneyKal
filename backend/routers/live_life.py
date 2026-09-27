"""
live.life.fully — the guilt-free lifestyle read, plus the affordability check.

Two routes and no writes. Everything this feature stores, it stores through
endpoints that already exist: an experience stash is a FinancialGoal, so it is
created with POST /home/goals and funded with PUT /home/goals/{id}. There is
deliberately no /live-life/stash mirror of those — a second write path to the
same table is how two sources of truth start.

Profile resolution and isolation follow the same pattern as routers/home.py:
the Profile is resolved from the authenticated User and every query filters on
profile_id, so a user can only ever see their own position.
"""
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.core.access import require_act
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import Profile, User
from backend.schemas.live_models import AffordabilityRequest, LiveLifeResponse, ItineraryRequest
from backend.services import home_service, live_life_service

router = APIRouter(prefix="/live-life", tags=["Live Life"])

#: The identity block. Held here rather than in the markup so the tagline and
#: its two lines have one home across web, WhatsApp and anything later.
IDENTITY = {
    "tagline": "live.life.fully",
    "lines": [
        "You work hard. We handle the numbers.",
        "You live life. We've got your back.",
    ],
}


def _get_profile(current_user: User, db: Session) -> Profile:
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found for this user. Please complete onboarding.",
        )
    return profile


def _parse_date(value: Optional[str]) -> date:
    if not value:
        return date.today()
    try:
        return date.fromisoformat(value[:10])
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="local_date must be an ISO date (YYYY-MM-DD)")


@router.get("", response_model=LiveLifeResponse)
@router.get("/", response_model=LiveLifeResponse, include_in_schema=False)
def get_live_life(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    local_date: Optional[str] = Query(
        default=None,
        description="The viewer's local date (YYYY-MM-DD), so due dates, countdowns and "
                    "'this month' follow their calendar rather than the server's.",
    ),
) -> LiveLifeResponse:
    """Everything the experience renders, in one request.

    Consolidated for the same reason GET /home is: the sections share one
    ledger read, and the moment rules need the Freedom Balance and the stash as
    input. Splitting them would recompute the same context three times and let
    the three answers disagree mid-render.
    """
    profile = _get_profile(current_user, db)
    today = _parse_date(local_date)

    # A goal set before the Goals table existed still counts as a stash.
    home_service.backfill_legacy_goal(db, profile)

    ctx = home_service.build_home_context(db, profile, today=today)

    freedom = live_life_service.build_freedom_balance(ctx)
    story = live_life_service.build_freedom_story(ctx, freedom)
    stash = live_life_service.build_stash(ctx)
    categories = live_life_service.build_categories(ctx, stash)
    moments = live_life_service.generate_moments(ctx, freedom, stash)
    adventure = live_life_service.build_upcoming_adventure(ctx, stash)
    recommendation = live_life_service.build_recommendation(ctx, freedom)
    tradeoffs = live_life_service.build_tradeoffs(ctx)

    return LiveLifeResponse(
        user={
            "name": home_service.resolve_display_name(profile, current_user.username),
            "currency": ctx.currency,
            "local_date": today.isoformat(),
        },
        identity=IDENTITY,
        freedom_balance=freedom,
        freedom_story=story,
        stash=stash,
        categories=categories,
        moment=moments.get("moment"),
        moment_alternatives=moments.get("alternatives", []),
        moment_locked=moments.get("locked"),
        upcoming_adventure=adventure,
        recommendation=recommendation,
        tradeoffs=tradeoffs,
        has_financial_data=home_service.has_any_financial_data(ctx),
        generated_at=datetime.utcnow().isoformat(),
    )


@router.post("/check")
def check_affordability(
    req: AffordabilityRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """"Can I afford this?" — answered against the same Freedom Balance the
    page shows, so the verdict can never contradict the headline number."""
    profile = _get_profile(current_user, db)
    today = _parse_date(req.local_date)

    ctx = home_service.build_home_context(db, profile, today=today)
    freedom = live_life_service.build_freedom_balance(ctx)
    
    amount_per_person = req.amount / max(1, req.split_count)
    return live_life_service.check_affordability(ctx, freedom, amount_per_person, req.goal_id)

@router.post("/itinerary")
def generate_itinerary_route(
    req: ItineraryRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    budget_per_person = req.budget / max(1, req.split_count)
    
    content = live_life_service.generate_itinerary(
        category_name=req.category_name,
        budget=budget_per_person,
        currency=req.currency,
        split_count=req.split_count
    )
    
    return {"html": content, "markdown": content}

@router.post("/sweep")
def execute_sweep(
    current_user: User = Depends(require_act("auto_sweep")),
    db: Session = Depends(get_db)
):
    from backend.services.sweep_service import process_sweeps
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
        
    return process_sweeps(db, profile)
