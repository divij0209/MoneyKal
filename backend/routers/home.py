"""
Daily Home — one consolidated read for the dashboard, plus the minimum CRUD
needed to make goals and upcoming payments real rather than decorative.

Every route resolves the Profile from the authenticated User and filters on
profile_id, so a user can only ever see or mutate their own rows — the same
isolation pattern the startup and twin routers use.
"""
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import FinancialGoal, Profile, UpcomingPayment, User, StartupTransaction
from backend.schemas.api_models import GenericResponse
from backend.schemas.home_models import (
    GoalCreate, GoalResponse, GoalUpdate, HomeResponse,
    UpcomingCreate, UpcomingResponse, UpcomingUpdate,
    VALID_DIRECTION, VALID_EVENT_TYPE, VALID_GOAL_STATUS, VALID_RECURRENCE,
)
from backend.services import (
    calendar_service, home_insights, home_service, insight_schedule_service,
)
from pydantic import BaseModel, Field

router = APIRouter(prefix="/home", tags=["Home"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_profile(current_user: User, db: Session) -> Profile:
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found for this user. Please complete onboarding.",
        )
    return profile


def _parse_date(value: Optional[str], field: str) -> Optional[date]:
    if value in (None, ""):
        return None
    try:
        return date.fromisoformat(value[:10])
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="%s must be an ISO date (YYYY-MM-DD)" % field)


def _greeting_for(hour: int) -> str:
    """Server-side greeting, computed from the hour the client reports. The
    frontend also derives this locally so the page never waits on the network
    to say hello — this exists so any non-browser consumer (WhatsApp, a voice
    call) gets the same wording from the same source."""
    if hour < 12:
        return "Good morning"
    if hour < 17:
        return "Good afternoon"
    return "Good evening"


def _infer_event_type(category: Optional[str]) -> str:
    """Best guess at an event type when the caller did not name one, so a
    manually added bill still gets the right calendar icon without the user
    having to pick a type as well as a category."""
    mapping = {
        "Subscriptions": "subscription",
        "Utilities & Bills": "bill",
        "Rent / Housing": "bill",
        "Health & Medical": "insurance",
        "Taxes": "tax",
    }
    return mapping.get(category or "", "other")


def _clear_other_primaries(db: Session, profile_id: int, keep_id: Optional[int]) -> None:
    """Exactly one goal may be flagged primary."""
    query = db.query(FinancialGoal).filter(
        FinancialGoal.profile_id == profile_id,
        FinancialGoal.is_primary.is_(True),
    )
    if keep_id is not None:
        query = query.filter(FinancialGoal.id != keep_id)
    for other in query.all():
        other.is_primary = False


# ---------------------------------------------------------------------------
# The consolidated dashboard read
# ---------------------------------------------------------------------------

@router.get("", response_model=HomeResponse)
@router.get("/", response_model=HomeResponse, include_in_schema=False)
def get_home(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    local_hour: Optional[int] = Query(
        default=None, ge=0, le=23,
        description="The viewer's local hour (0-23). Sent by the browser so the greeting "
                    "matches the user's own time rather than the server's timezone.",
    ),
    local_date: Optional[str] = Query(
        default=None,
        description="The viewer's local date (YYYY-MM-DD). Keeps 'this month' and due-date "
                    "urgency aligned with the user's calendar, not UTC's.",
    ),
) -> HomeResponse:
    """Everything the Daily Home renders, in one request.

    Consolidated rather than split because the sections share a single ledger
    read and the insight engine needs the other sections' output to choose what
    to say — three separate endpoints would recompute the same context three
    times and could disagree with each other mid-render."""
    profile = _get_profile(current_user, db)

    today = _parse_date(local_date, "local_date") or date.today()
    hour = local_hour if local_hour is not None else datetime.now().hour

    # A user who set a goal before this feature existed keeps it.
    home_service.backfill_legacy_goal(db, profile)

    ctx = home_service.build_home_context(db, profile, today=today)

    available = home_service.build_available_money(ctx)
    spending = home_service.build_monthly_spending(ctx)
    goals = home_service.build_goals(ctx)
    upcoming = home_service.build_upcoming(ctx, limit=5)
    has_data = home_service.has_any_financial_data(ctx)

    # Prefer the insight the scheduler generated for today, so the section
    # reflects the time the user chose rather than the moment they happened to
    # load the page. Falling back to computing live is what keeps this
    # unchanged for a profile that has never been scheduled, for a deployment
    # running without ENABLE_SCHEDULER, and for the minutes of a day before the
    # chosen time arrives.
    insight = insight_schedule_service.get_stored_insight(db, profile.id, today)
    if not insight:
        insight = home_insights.generate_insight(ctx, upcoming, goals, available, has_data)

    # Both new sections are projections over the context already gathered — no
    # extra queries, and the same round trip the dashboard already makes.
    # Named distinctly from `spending` above, which is the headline monthly
    # figure the financial snapshot renders.
    spending_overview = home_service.build_spending_overview(ctx)
    calendar = calendar_service.build_calendar(ctx)
    timeline = calendar_service.build_timeline(ctx)

    from backend.services import health_score_service
    health_score = health_score_service.calculate_health_score(ctx)

    return HomeResponse(
        user={
            "name": home_service.resolve_display_name(profile, current_user.username),
            "greeting": _greeting_for(hour),
            "profile_key": profile.key or "individual",
            "currency": ctx.currency,
            "local_date": today.isoformat(),
        },
        financial_snapshot={
            "available_money": available,
            "monthly_spending": spending,
            "savings_progress": goals["savings_progress"],
        },
        insight=insight,
        upcoming=upcoming,
        primary_goal=goals["primary_goal"],
        goals=goals["goals"],
        spending_overview=spending_overview,
        calendar=calendar,
        timeline=timeline,
        health_score=health_score,
        has_financial_data=has_data,
        generated_at=datetime.utcnow().isoformat(),
    )


@router.get("/calendar")
def get_calendar(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    year: Optional[int] = Query(default=None, ge=1970, le=2200),
    month: Optional[int] = Query(default=None, ge=1, le=12),
    local_date: Optional[str] = Query(
        default=None,
        description="The viewer's local date (YYYY-MM-DD), so 'today' is highlighted "
                    "against their calendar rather than the server's.",
    ),
):
    """One month of financial events, for paging back and forth.

    Deliberately narrow: GET /home already returns the current month, so this
    only serves navigation and returns the month alone rather than re-sending
    the whole dashboard on every arrow press.
    """
    profile = _get_profile(current_user, db)
    today = _parse_date(local_date, "local_date") or date.today()
    ctx = home_service.build_home_context(db, profile, today=today)
    return calendar_service.build_calendar(ctx, year=year, month=month)


# ---------------------------------------------------------------------------
# Goals
# ---------------------------------------------------------------------------

@router.get("/goals", response_model=List[GoalResponse])
def list_goals(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    include_archived: bool = False,
) -> List[GoalResponse]:
    profile = _get_profile(current_user, db)
    query = db.query(FinancialGoal).filter(FinancialGoal.profile_id == profile.id)
    if not include_archived:
        query = query.filter(FinancialGoal.status == "active")
    goals = query.all()
    today = date.today()
    return [home_service.goal_to_dict(g, profile.currency or "₹", today) for g in goals]


@router.post("/goals", response_model=GoalResponse, status_code=201)
def create_goal(
    req: GoalCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalResponse:
    profile = _get_profile(current_user, db)
    target_date = _parse_date(req.target_date, "target_date")

    if req.current_amount > req.target_amount:
        raise HTTPException(status_code=400, detail="current_amount cannot exceed target_amount")

    # The first goal a user creates is their primary one — otherwise the Home
    # dashboard would have nothing to lead with until they set the flag.
    existing = db.query(FinancialGoal).filter(
        FinancialGoal.profile_id == profile.id, FinancialGoal.status == "active"
    ).count()
    is_primary = req.is_primary or existing == 0
    if is_primary:
        _clear_other_primaries(db, profile.id, keep_id=None)

    goal = FinancialGoal(
        profile_id=profile.id,
        name=req.name.strip(),
        icon=req.icon,
        category=req.category or "custom",
        target_amount=req.target_amount,
        current_amount=req.current_amount,
        target_date=target_date,
        is_primary=is_primary,
        status="active",
        shared_with_profile_ids=req.shared_with_profile_ids or []
    )
    db.add(goal)
    db.commit()
    db.refresh(goal)

    home_service.sync_legacy_profile_goal(db, profile)
    db.commit()

    return home_service.goal_to_dict(goal, profile.currency or "₹", date.today())


@router.put("/goals/{goal_id}", response_model=GoalResponse)
def update_goal(
    goal_id: int,
    req: GoalUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GoalResponse:
    profile = _get_profile(current_user, db)
    goal = db.query(FinancialGoal).filter(
        FinancialGoal.id == goal_id, FinancialGoal.profile_id == profile.id
    ).first()
    if not goal:
        raise HTTPException(status_code=404, detail="Goal not found")

    if req.name is not None:
        goal.name = req.name.strip()
    if req.icon is not None:
        goal.icon = req.icon
    if req.category is not None:
        goal.category = req.category
    if req.target_amount is not None:
        goal.target_amount = req.target_amount
    if req.current_amount is not None:
        goal.current_amount = req.current_amount
    if req.target_date is not None:
        goal.target_date = _parse_date(req.target_date, "target_date")
    if req.status is not None:
        if req.status not in VALID_GOAL_STATUS:
            raise HTTPException(
                status_code=400,
                detail="status must be one of: " + ", ".join(sorted(VALID_GOAL_STATUS)),
            )
        goal.status = req.status
    if req.shared_with_profile_ids is not None:
        goal.shared_with_profile_ids = req.shared_with_profile_ids
    if req.is_primary is not None:
        goal.is_primary = req.is_primary
        if req.is_primary:
            _clear_other_primaries(db, profile.id, keep_id=goal.id)

    if (goal.current_amount or 0) > (goal.target_amount or 0):
        raise HTTPException(status_code=400, detail="current_amount cannot exceed target_amount")

    db.commit()
    db.refresh(goal)

    home_service.sync_legacy_profile_goal(db, profile)
    db.commit()

    return home_service.goal_to_dict(goal, profile.currency or "₹", date.today())


@router.delete("/goals/{goal_id}", response_model=GenericResponse)
def delete_goal(
    goal_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GenericResponse:
    profile = _get_profile(current_user, db)
    goal = db.query(FinancialGoal).filter(
        FinancialGoal.id == goal_id, FinancialGoal.profile_id == profile.id
    ).first()
    if not goal:
        raise HTTPException(status_code=404, detail="Goal not found")

    was_primary = goal.is_primary
    db.delete(goal)
    db.commit()

    # Promote another goal so the dashboard is never left without one to lead with.
    if was_primary:
        remaining = db.query(FinancialGoal).filter(
            FinancialGoal.profile_id == profile.id, FinancialGoal.status == "active"
        ).all()
        promoted = home_service.resolve_primary_goal(remaining, date.today())
        if promoted:
            promoted.is_primary = True
        home_service.sync_legacy_profile_goal(db, profile)
        db.commit()

    return GenericResponse(success=True, message="Goal deleted")


# ---------------------------------------------------------------------------
# Upcoming payments
# ---------------------------------------------------------------------------

@router.get("/upcoming", response_model=List[UpcomingResponse])
def list_upcoming(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    limit: int = Query(default=25, ge=1, le=100),
) -> List[UpcomingResponse]:
    profile = _get_profile(current_user, db)
    ctx = home_service.build_home_context(db, profile)
    # Confirmed rows only — suggestions have their own route so a caller can
    # never mistake an unreviewed detection for a real obligation.
    return home_service.build_upcoming(ctx, limit=limit)["items"]


@router.post("/upcoming", response_model=UpcomingResponse, status_code=201)
def create_upcoming(
    req: UpcomingCreate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UpcomingResponse:
    profile = _get_profile(current_user, db)

    recurrence = (req.recurrence or "none").lower()
    if recurrence not in VALID_RECURRENCE:
        raise HTTPException(
            status_code=400,
            detail="recurrence must be one of: " + ", ".join(sorted(VALID_RECURRENCE)),
        )

    due = _parse_date(req.due_date, "due_date")
    if due is None:
        raise HTTPException(status_code=400, detail="due_date is required")

    direction = (req.direction or "out").lower()
    if direction not in VALID_DIRECTION:
        raise HTTPException(
            status_code=400,
            detail="direction must be one of: " + ", ".join(sorted(VALID_DIRECTION)),
        )
    event_type = (req.event_type or "").lower() or None
    if event_type and event_type not in VALID_EVENT_TYPE:
        raise HTTPException(
            status_code=400,
            detail="event_type must be one of: " + ", ".join(sorted(VALID_EVENT_TYPE)),
        )

    meta = {"payment_url": req.payment_url} if req.payment_url else None

    item = UpcomingPayment(
        profile_id=profile.id,
        name=req.name.strip(),
        amount=req.amount,
        due_date=due,
        category=req.category,
        recurrence=recurrence,
        notes=req.notes,
        is_active=True,
        source="manual",
        direction=direction,
        event_type=event_type or _infer_event_type(req.category),
        # A payment the user typed is a fact, never a suggestion. Detection
        # never downgrades or overwrites one of these.
        status="confirmed",
        source_meta=meta
    )
    db.add(item)
    db.commit()
    db.refresh(item)

    return _upcoming_to_response(item, profile.currency or "₹")


@router.put("/upcoming/{item_id}", response_model=UpcomingResponse)
def update_upcoming(
    item_id: int,
    req: UpcomingUpdate,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UpcomingResponse:
    profile = _get_profile(current_user, db)
    item = db.query(UpcomingPayment).filter(
        UpcomingPayment.id == item_id, UpcomingPayment.profile_id == profile.id
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Upcoming payment not found")

    if req.name is not None:
        item.name = req.name.strip()
    if req.amount is not None:
        item.amount = req.amount
    if req.due_date is not None:
        item.due_date = _parse_date(req.due_date, "due_date")
    if req.category is not None:
        item.category = req.category
    if req.recurrence is not None:
        recurrence = req.recurrence.lower()
        if recurrence not in VALID_RECURRENCE:
            raise HTTPException(
                status_code=400,
                detail="recurrence must be one of: " + ", ".join(sorted(VALID_RECURRENCE)),
            )
        item.recurrence = recurrence
    if req.notes is not None:
        item.notes = req.notes
    if req.is_active is not None:
        item.is_active = req.is_active
    if req.direction is not None:
        direction = req.direction.lower()
        if direction not in VALID_DIRECTION:
            raise HTTPException(
                status_code=400,
                detail="direction must be one of: " + ", ".join(sorted(VALID_DIRECTION)),
            )
        item.direction = direction
    if req.event_type is not None:
        event_type = req.event_type.lower() or None
        if event_type and event_type not in VALID_EVENT_TYPE:
            raise HTTPException(
                status_code=400,
                detail="event_type must be one of: " + ", ".join(sorted(VALID_EVENT_TYPE)),
            )
        item.event_type = event_type
    if req.status is not None:
        item.status = req.status
    if req.payment_url is not None:
        meta = item.source_meta or {}
        if req.payment_url == "":
            meta.pop("payment_url", None)
        else:
            meta["payment_url"] = req.payment_url
        item.source_meta = meta

    db.commit()
    db.refresh(item)
    return _upcoming_to_response(item, profile.currency or "₹")





@router.post("/upcoming/{item_id}/mark-paid", response_model=UpcomingResponse)
def mark_upcoming_paid(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UpcomingResponse:
    """Marks the current occurrence settled and logs it to Hisaab.

    A recurring item rolls forward to its next date and stays on the list; a
    one-off is deactivated, since there is no next time. This now automatically
    creates a StartupTransaction in the Hisaab ledger to keep the two connected."""
    profile = _get_profile(current_user, db)
    item = db.query(UpcomingPayment).filter(
        UpcomingPayment.id == item_id, UpcomingPayment.profile_id == profile.id
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Upcoming payment not found")

    today = date.today()
    item.last_paid_on = today

    recurrence = item.recurrence or "none"
    if recurrence == "none":
        item.is_active = False
    else:
        # Step past the occurrence just settled, so it does not immediately
        # reappear as "due today".
        nxt = home_service.next_occurrence(item, today)
        if nxt is not None:
            if recurrence == "weekly":
                item.due_date = nxt + timedelta(days=7)
            else:
                months = {"monthly": 1, "quarterly": 3, "yearly": 12}[recurrence]
                item.due_date = home_service.add_months(nxt, months)

    # Sync to Hisaab
    txn = StartupTransaction(
        profile_id=profile.id,
        txn_date=today,
        type=item.direction,
        amount=item.amount,
        category=item.category or "Other expense",
        description=item.name,
    )
    db.add(txn)

    db.commit()
    db.refresh(item)
    return _upcoming_to_response(item, profile.currency or "₹")


@router.delete("/upcoming/{item_id}", response_model=GenericResponse)
def delete_upcoming(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GenericResponse:
    profile = _get_profile(current_user, db)
    item = db.query(UpcomingPayment).filter(
        UpcomingPayment.id == item_id, UpcomingPayment.profile_id == profile.id
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Upcoming payment not found")
    db.delete(item)
    db.commit()
    return GenericResponse(success=True, message="Upcoming payment deleted")


def _upcoming_to_response(item: UpcomingPayment, currency: str) -> dict:
    """One row, shaped exactly as the dashboard shapes it — same function, so
    the CRUD responses and GET /home can never drift apart."""
    today = date.today()
    due = home_service.next_occurrence(item, today) or item.due_date
    return home_service._upcoming_row(item, due, currency, today)


# ---------------------------------------------------------------------------
# Detected obligations awaiting review
#
# Everything Gmail detection writes with low confidence lands here rather than
# in the user's real figures. These three routes are the only way such a row
# becomes real — nothing promotes itself.
# ---------------------------------------------------------------------------

@router.get("/upcoming/suggestions", response_model=List[UpcomingResponse])
def list_upcoming_suggestions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> List[UpcomingResponse]:
    """Detected payments MoneyKal is not confident enough to add on its own."""
    profile = _get_profile(current_user, db)
    rows = db.query(UpcomingPayment).filter(
        UpcomingPayment.profile_id == profile.id,
        UpcomingPayment.status == "review",
        UpcomingPayment.is_active.is_(True),
    ).order_by(UpcomingPayment.due_date).all()
    currency = profile.currency or "₹"
    return [_upcoming_to_response(r, currency) for r in rows]


@router.post("/upcoming/{item_id}/confirm", response_model=UpcomingResponse)
def confirm_upcoming(
    item_id: int,
    req: UpcomingUpdate = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UpcomingResponse:
    """Accepts a suggestion, optionally correcting it first.

    The correction path matters: a detection that got the amount or date
    slightly wrong should be fixable in one step rather than dismissed and
    re-entered by hand."""
    profile = _get_profile(current_user, db)
    item = db.query(UpcomingPayment).filter(
        UpcomingPayment.id == item_id, UpcomingPayment.profile_id == profile.id
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Upcoming payment not found")

    if req is not None:
        if req.name is not None:
            item.name = req.name.strip()
        if req.amount is not None:
            item.amount = req.amount
        if req.due_date is not None:
            item.due_date = _parse_date(req.due_date, "due_date")
        if req.category is not None:
            item.category = req.category
        if req.recurrence is not None:
            recurrence = req.recurrence.lower()
            if recurrence not in VALID_RECURRENCE:
                raise HTTPException(
                    status_code=400,
                    detail="recurrence must be one of: " + ", ".join(sorted(VALID_RECURRENCE)),
                )
            item.recurrence = recurrence

    item.status = "confirmed"
    item.is_active = True
    db.commit()
    db.refresh(item)
    return _upcoming_to_response(item, profile.currency or "₹")


@router.post("/upcoming/{item_id}/dismiss", response_model=GenericResponse)
def dismiss_upcoming(
    item_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> GenericResponse:
    """Rejects a suggestion.

    The row is marked dismissed rather than deleted, which is what stops the
    next sync from detecting the same email and asking again."""
    profile = _get_profile(current_user, db)
    item = db.query(UpcomingPayment).filter(
        UpcomingPayment.id == item_id, UpcomingPayment.profile_id == profile.id
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Upcoming payment not found")

    item.status = "dismissed"
    item.is_active = False
    db.commit()
    return GenericResponse(success=True, message="Suggestion dismissed")


# ---------------------------------------------------------------------------
# Daily AI Insights — scheduling
#
# Lives here rather than in the profile router because it configures a Home
# section, and the Overview's Schedule dialog should not have to know about the
# profile edit form to save a time. The underlying columns are on `profiles`,
# which is why the previous UI reached for Edit Profile at all.
#
# These endpoints only read and write the preference. They never generate an
# insight and never create a notification: generation belongs to the scheduler
# (backend/scheduler.py -> generate_scheduled_insights).
# ---------------------------------------------------------------------------

class InsightScheduleUpdate(BaseModel):
    enabled: Optional[bool] = None
    frequency: Optional[str] = Field(
        default=None,
        description="One of insight_schedule_service.FREQUENCIES. Anything else "
                    "is snapped to the default rather than rejected, so an older "
                    "client cannot write a value the scheduler cannot honour.",
    )
    time: Optional[str] = Field(
        default=None,
        description="'HH:MM', 24-hour, in the user's own reckoning.",
    )


@router.get("/insight-schedule")
def get_insight_schedule(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """The current Daily AI Insights schedule, plus the frequencies on offer.

    The list is served rather than hard-coded in the client so the dialog can
    never present an option the scheduler does not implement.
    """
    profile = _get_profile(current_user, db)
    schedule = insight_schedule_service.get_schedule(profile)
    schedule["last_generated"] = (
        d.isoformat() if (d := insight_schedule_service.last_generated_date(db, profile.id)) else None
    )
    return schedule


@router.put("/insight-schedule")
def update_insight_schedule(
    req: InsightScheduleUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    profile = _get_profile(current_user, db)
    schedule = insight_schedule_service.save_schedule(
        db, profile,
        enabled=req.enabled,
        frequency=req.frequency,
        time_str=req.time,
    )
    db.commit()
    return schedule


@router.post("/insight-schedule/run-now")
def run_insight_now(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Generate today's insight immediately.

    The dialog offers this so saving a schedule has something to show for
    itself straight away — a user who picks 08:00 at nine in the evening should
    not have to wait until tomorrow to see that the setting works. It writes
    the same row the scheduler writes, through the same service, so there is
    one definition of what generating means.
    """
    profile = _get_profile(current_user, db)
    row = insight_schedule_service.generate_for_profile(db, profile)
    db.commit()
    return {
        "generated": bool(row),
        "insight": (row.payload if row else None),
    }
