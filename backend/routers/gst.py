"""
Startup GST Calculator API.

Scoped to the Startup persona, on the same pattern as routers/fundraise.py and
routers/compliance.py. The Individual Tax Calculator is fenced to Individuals
in exactly this way; this is its counterpart on the other side.

Surface:
    GET  /startup/gst/config        rates, slabs, supply types, scheme rules
    POST /startup/gst/calculate     stateless calculation
    GET  /startup/gst/gstin         decode and check a GSTIN
    GET  /startup/gst/hsn           search the HSN/SAC catalogue
    GET  /startup/gst/profile       load the saved working set for a year
    PUT  /startup/gst/profile       save the working set for a year
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.core.config import gst_config as cfg
from backend.core.config import gst_reference as ref
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import GSTProfile, Profile, User
from backend.schemas.gst_models import (
    GSTCalculateRequest,
    GSTCalculateResponse,
    GSTProfileSave,
)
from backend.services import gst_service
from backend.services.compliance_service import fy_label, parse_fy

router = APIRouter(prefix="/startup/gst", tags=["GST Calculator"])


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
            detail="The GST Calculator is available to Startup profiles only.",
        )
    if not profile.startup_profile:
        raise HTTPException(
            status_code=404,
            detail="Startup profile not found. Please complete Startup onboarding first.",
        )
    return profile


@router.get("/config")
def get_gst_config(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Everything the UI needs to render its forms and labels.

    Served from the backend so the frontend never hardcodes a rate or a
    threshold — the same contract GET /tax/config holds for income tax.
    """
    profile = _startup_profile(current_user, db)
    sp = profile.startup_profile
    return {
        "default_rate_structure": cfg.DEFAULT_RATE_STRUCTURE,
        "rate_structures": cfg.RATE_STRUCTURES,
        "default_rate": cfg.DEFAULT_RATE,
        "supply_types": cfg.SUPPLY_TYPES,
        "default_supply_type": cfg.DEFAULT_SUPPLY_TYPE,
        "head_labels": cfg.HEAD_LABELS,
        "calc_modes": cfg.CALC_MODES,
        "default_calc_mode": cfg.DEFAULT_CALC_MODE,
        "composition_categories": cfg.COMPOSITION_CATEGORIES,
        "composition_restrictions": cfg.COMPOSITION_RESTRICTIONS,
        "registration_thresholds": cfg.REGISTRATION_THRESHOLDS,
        "rcm_common_cases": cfg.RCM_COMMON_CASES,
        "rcm_note": cfg.RCM_NOTE,
        "rounding_note": cfg.ROUNDING_NOTE,
        "rcm_payer_notes": cfg.RCM_PAYER_NOTES,
        "limits": {"max_lines": cfg.MAX_LINES, "max_rate_pct": cfg.MAX_RATE_PCT,
                   "max_cess_rate_pct": cfg.MAX_CESS_RATE_PCT},
        "company": {
            "name": sp.company_name,
            "gstin": (sp.gst_number or "").strip() or None,
            "industry": sp.industry,
        },
        "applicability_rules": cfg.APPLICABILITY_RULES,
        "eway_bill": {"threshold": cfg.EWAY_BILL_THRESHOLD, "note": cfg.EWAY_BILL_NOTE},
        "state_codes": ref.STATE_CODES,
        "hsn_catalogue": ref.HSN_SAC_CATALOGUE,
        "hsn_disclaimer": ref.HSN_SAC_DISCLAIMER,
        "field_guidance": ref.FIELD_GUIDANCE,
        "filing_guides": ref.FILING_GUIDES,
        "disclaimer": cfg.DISCLAIMER,
    }


@router.post("/calculate", response_model=GSTCalculateResponse)
def calculate_gst(
    payload: GSTCalculateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Run the calculation.

    Stateless — nothing is persisted. The UI posts this on every change to keep
    the running total live, exactly as POST /tax/collect does for income tax.
    """
    _startup_profile(current_user, db)
    _validate_request(payload)
    return gst_service.calculate(payload)


def _validate_request(payload: GSTCalculateRequest) -> None:
    """Refuse inputs that would produce a meaningless figure.

    A negative amount is not a credit note — it silently produces a negative
    tax invoice — so it is rejected with a reason instead of computed.
    """
    if len(payload.lines or []) > cfg.MAX_LINES:
        raise HTTPException(status_code=400,
                            detail=f"A maximum of {cfg.MAX_LINES} line items can be calculated at once.")
    for n, line in enumerate(payload.lines or [], start=1):
        if line.rate is not None and not (0 <= line.rate <= cfg.MAX_RATE_PCT):
            raise HTTPException(status_code=400,
                                detail=f"Line {n}: the GST rate must be between 0 and {cfg.MAX_RATE_PCT:g}.")
        if line.cess_rate is not None and not (0 <= line.cess_rate <= cfg.MAX_CESS_RATE_PCT):
            raise HTTPException(status_code=400,
                                detail=f"Line {n}: the cess rate must be between 0 and {cfg.MAX_CESS_RATE_PCT:g}.")
        if (line.amount or 0) < 0:
            raise HTTPException(status_code=400,
                                detail=f"Line {n}: amount cannot be negative. Record a credit note separately.")
        if line.quantity is not None and line.quantity < 0:
            raise HTTPException(status_code=400, detail=f"Line {n}: quantity cannot be negative.")
        if (line.discount or 0) < 0:
            raise HTTPException(status_code=400, detail=f"Line {n}: discount cannot be negative.")
    if (payload.input_tax_credit or 0) < 0:
        raise HTTPException(status_code=400, detail="Input tax credit cannot be negative.")
    if payload.annual_turnover is not None and payload.annual_turnover < 0:
        raise HTTPException(status_code=400, detail="Annual turnover cannot be negative.")
    if payload.invoice_date and gst_service.parse_invoice_date(payload.invoice_date) is None:
        raise HTTPException(status_code=400, detail="invoice_date must be a date in YYYY-MM-DD form.")

@router.get("/gstin")
def check_gstin(
    value: str = Query(..., description="The 15-character GSTIN to decode and verify."),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Decode a GSTIN and verify its Luhn mod 36 check digit.

    Offline and deterministic — no call is made to the GST portal. A passing
    check digit proves the number is well-formed, not that the registration
    exists or is active, and the response says so.
    """
    _startup_profile(current_user, db)
    return gst_service.validate_gstin(value)


@router.get("/hsn")
def search_hsn(
    q: str = Query("", description="Search the catalogue by code or description."),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Search the curated HSN/SAC catalogue.

    A convenience list of codes startups commonly use, not the notified
    schedule. Classification stays the founder's judgement.
    """
    _startup_profile(current_user, db)
    return gst_service.search_hsn(q)


@router.get("/profile")
def get_gst_profile(
    fy: str = Query(None, description="Financial year, e.g. FY2026-27."),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Load the saved working set for a year, or empty defaults.

    Mirrors GET /tax/profile on the Individual side.
    """
    profile = _startup_profile(current_user, db)
    year = fy_label(parse_fy(fy))

    saved = (
        db.query(GSTProfile)
        .filter(GSTProfile.profile_id == profile.id, GSTProfile.fy == year)
        .first()
    )
    if not saved:
        return {"fy": year, "inputs": GSTCalculateRequest().model_dump(),
                "last_result": None, "exists": False}
    return {
        "fy": saved.fy,
        "inputs": saved.inputs or {},
        "last_result": saved.last_result,
        "exists": True,
        "updated_at": saved.updated_at.isoformat() if saved.updated_at else None,
    }


@router.put("/profile")
def save_gst_profile(
    payload: GSTProfileSave,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Save the working set for a year, upserting on (profile, fy).

    The computed result is cached alongside so the view reopens without a round
    trip, but `inputs` stays the source of truth — the cache is always
    regenerated, never trusted. Same contract as PUT /tax/profile.
    """
    profile = _startup_profile(current_user, db)
    _validate_request(payload.request)
    year = fy_label(parse_fy(payload.fy))

    result = gst_service.calculate(payload.request)

    saved = (
        db.query(GSTProfile)
        .filter(GSTProfile.profile_id == profile.id, GSTProfile.fy == year)
        .first()
    )
    if not saved:
        saved = GSTProfile(profile_id=profile.id, fy=year)
        db.add(saved)

    saved.inputs = payload.request.model_dump()
    saved.last_result = result.model_dump()
    db.commit()

    return {"status": "ok", "fy": year, "result": result.model_dump()}
