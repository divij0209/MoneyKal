"""
Compliance Command Center API.

Scoped to the Startup persona, on the same pattern as routers/fundraise.py.

Surface:
    GET    /startup/compliance            calendar + liabilities + penalty exposure
    GET    /startup/compliance/config     the statutory rules the UI renders against
    PUT    /startup/compliance/filings    record filed / not applicable / amount for deadlines
    DELETE /startup/compliance/filings    forget what was recorded for one deadline
"""

from datetime import date
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from backend.core.config import compliance_config as cfg
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import ComplianceFiling, Profile, StartupTransaction, User
from backend.services.compliance_service import (
    OBLIGATIONS_BY_ID,
    build_compliance,
    current_fy_start_year,
    fy_label,
    is_valid_occurrence,
    parse_fy,
)

router = APIRouter(prefix="/startup/compliance", tags=["Compliance"])

#: A bulk update is one founder action ("mark everything past as filed"); a
#: full year of every obligation is well under this.
MAX_FILINGS_PER_REQUEST = 400


def _startup_profile(current_user: User, db: Session) -> Profile:
    """Resolve the caller's profile, refusing anything that is not a Startup."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found for this user. Please complete onboarding.",
        )
    if profile.key != "startup":
        raise HTTPException(
            status_code=403,
            detail="The Compliance Center is available to Startup profiles only.",
        )
    if not profile.startup_profile:
        raise HTTPException(
            status_code=404,
            detail="Startup profile not found. Please complete Startup onboarding first.",
        )
    return profile


def _parse_date(raw: Optional[str], field: str) -> Optional[date]:
    if raw in (None, ""):
        return None
    try:
        return date.fromisoformat(str(raw)[:10])
    except ValueError:
        raise HTTPException(status_code=400, detail=f"{field} must be a date in YYYY-MM-DD form.")


@router.get("")
def get_compliance(
    fy: str = Query(None, description="Financial year, e.g. FY2026-27. Defaults to the current one."),
    amounts_are: str = Query(
        cfg.DEFAULT_AMOUNTS_ARE,
        description="How to read logged amounts for GST: 'inclusive' or 'exclusive'.",
    ),
    gst_rate: float = Query(
        cfg.ASSUMED_GST_RATE_PCT,
        description="Assumed GST rate percentage applied to taxable supplies.",
    ),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Statutory calendar, estimated liabilities and accrued penalty exposure.

    `amounts_are` and `gst_rate` are exposed because the answer genuinely
    depends on them and the difference is material — a founder logging invoice
    values wants a different reading from one logging bank credits.
    """
    if amounts_are not in ("inclusive", "exclusive"):
        raise HTTPException(status_code=400, detail="amounts_are must be 'inclusive' or 'exclusive'")
    if not (cfg.MIN_ASSUMED_GST_RATE_PCT <= gst_rate <= cfg.MAX_ASSUMED_GST_RATE_PCT):
        raise HTTPException(
            status_code=400,
            detail=f"gst_rate must be between {cfg.MIN_ASSUMED_GST_RATE_PCT:g} and {cfg.MAX_ASSUMED_GST_RATE_PCT:g}",
        )

    profile = _startup_profile(current_user, db)
    transactions = (
        db.query(StartupTransaction)
        .filter(StartupTransaction.profile_id == profile.id)
        .order_by(StartupTransaction.txn_date)
        .all()
    )
    filings = db.query(ComplianceFiling).filter(ComplianceFiling.profile_id == profile.id).all()
    fy_start = parse_fy(fy)
    return build_compliance(
        profile.startup_profile,
        transactions,
        fy_start,
        amounts_are=amounts_are,
        gst_rate_pct=gst_rate,
        filings=filings,
    )


class FilingUpdate(BaseModel):
    obligation_id: str
    due_date: str
    #: filed | not_applicable | pending
    status: str = "filed"
    #: Required for status 'filed'. Defaults to the due date when omitted, i.e.
    #: "filed on time".
    filed_on: Optional[str] = None
    #: The tax or contribution due for the period, when known.
    amount: Optional[float] = None
    note: Optional[str] = Field(default=None, max_length=500)


class FilingBatch(BaseModel):
    filings: List[FilingUpdate]


@router.put("/filings")
def save_filings(
    payload: FilingBatch,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Record what the founder knows about one or more deadlines.

    Upserts on (profile, obligation, due date). Every row is validated before
    any is written, so a bad entry in a bulk update changes nothing.
    """
    profile = _startup_profile(current_user, db)
    if not payload.filings:
        raise HTTPException(status_code=400, detail="Send at least one filing.")
    if len(payload.filings) > MAX_FILINGS_PER_REQUEST:
        raise HTTPException(status_code=400,
                            detail=f"At most {MAX_FILINGS_PER_REQUEST} filings can be saved at once.")

    today = date.today()
    cleaned = []
    seen = set()
    for f in payload.filings:
        ob = OBLIGATIONS_BY_ID.get(f.obligation_id)
        if not ob:
            raise HTTPException(status_code=400, detail=f"Unknown obligation '{f.obligation_id}'.")
        if f.status not in cfg.FILING_STATUSES:
            raise HTTPException(status_code=400,
                                detail=f"status must be one of: {', '.join(cfg.FILING_STATUSES)}.")
        due = _parse_date(f.due_date, "due_date")
        if due is None or not is_valid_occurrence(f.obligation_id, due):
            raise HTTPException(status_code=400,
                                detail=f"{f.due_date} is not a due date for {ob['label']}.")
        filed_on = _parse_date(f.filed_on, "filed_on")
        if f.status == "filed":
            filed_on = filed_on or due
            if filed_on > today:
                raise HTTPException(status_code=400, detail="filed_on cannot be in the future.")
        else:
            filed_on = None
        if f.amount is not None and f.amount < 0:
            raise HTTPException(status_code=400, detail="amount cannot be negative.")
        key = (f.obligation_id, due)
        if key in seen:
            raise HTTPException(status_code=400, detail=f"{ob['label']} on {due} appears twice.")
        seen.add(key)
        cleaned.append((f, due, filed_on))

    existing = {
        (r.obligation_id, r.due_date): r
        for r in db.query(ComplianceFiling).filter(ComplianceFiling.profile_id == profile.id).all()
    }
    saved = 0
    for f, due, filed_on in cleaned:
        rec = existing.get((f.obligation_id, due))
        if rec is None:
            rec = ComplianceFiling(profile_id=profile.id, obligation_id=f.obligation_id, due_date=due)
            db.add(rec)
        rec.status = f.status
        rec.filed_on = filed_on
        # An amount left out of an update keeps the one already recorded, so
        # marking a period filed never erases the figure entered for it.
        if f.amount is not None or rec.amount is None:
            rec.amount = f.amount
        if f.note is not None:
            rec.note = f.note
        saved += 1
    db.commit()
    return {"status": "ok", "saved": saved}


@router.delete("/filings")
def delete_filing(
    obligation_id: str = Query(...),
    due_date: str = Query(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Undo: forget everything recorded for one deadline, returning it to its date-only status."""
    profile = _startup_profile(current_user, db)
    due = _parse_date(due_date, "due_date")
    rec = (
        db.query(ComplianceFiling)
        .filter(ComplianceFiling.profile_id == profile.id,
                ComplianceFiling.obligation_id == obligation_id,
                ComplianceFiling.due_date == due)
        .first()
    )
    if not rec:
        raise HTTPException(status_code=404, detail="Nothing is recorded for that deadline.")
    db.delete(rec)
    db.commit()
    return {"status": "ok"}


@router.get("/config")
def get_compliance_config(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The statutory rules themselves — obligations, penalties and thresholds.

    Served from the backend so no due date or late fee is ever hardcoded in
    the frontend. Mirrors GET /tax/config.
    """
    _startup_profile(current_user, db)
    this_fy = current_fy_start_year()
    return {
        "obligations": [
            {k: v for k, v in ob.items() if k != "month_overrides"} for ob in cfg.OBLIGATIONS
        ],
        "penalties": cfg.PENALTIES,
        "filing_statuses": cfg.FILING_STATUSES,
        "gst": {
            "assumed_rate_pct": cfg.ASSUMED_GST_RATE_PCT,
            "assumed_rate_bounds": [cfg.MIN_ASSUMED_GST_RATE_PCT, cfg.MAX_ASSUMED_GST_RATE_PCT],
            "default_amounts_are": cfg.DEFAULT_AMOUNTS_ARE,
            "taxable_income_categories": sorted(cfg.TAXABLE_INCOME_CATEGORIES),
            "non_supply_income_categories": cfg.NON_SUPPLY_INCOME_CATEGORIES,
            "itc_eligible_categories": sorted(cfg.ITC_ELIGIBLE_CATEGORIES),
            "itc_blocked_categories": cfg.ITC_BLOCKED_CATEGORIES,
            "category_aliases": cfg.CATEGORY_ALIASES,
            "registration_threshold_services": cfg.GST_REGISTRATION_THRESHOLD_SERVICES,
            "registration_threshold_goods": cfg.GST_REGISTRATION_THRESHOLD_GOODS,
        },
        "tds_rules": cfg.TDS_RULES,
        "thresholds": {
            "epf_headcount": cfg.EPF_HEADCOUNT_THRESHOLD,
            "esi_headcount": cfg.ESI_HEADCOUNT_THRESHOLD,
            "due_soon_days": cfg.DUE_SOON_DAYS,
        },
        "available_years": [fy_label(y) for y in range(this_fy, this_fy - cfg.YEARS_OF_HISTORY - 1, -1)],
        "disclaimer": cfg.LIABILITY_DISCLAIMER,
    }
