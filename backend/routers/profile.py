from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import List

from backend.database import get_db
from backend.models.domain import User, Profile, Alert, DecisionHistory
from backend.core.auth import get_current_user
from backend.services.financial_simulator import build_financial_context
from backend.services.risk_profile import build_risk_profile
from backend.services import avatar_service

router = APIRouter(prefix="/profile", tags=["Profile"])

@router.get("/me")
def get_profile(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found for this user. Please complete onboarding.")

    details = {}
    if profile.key == "startup" and profile.startup_profile:
        sp = profile.startup_profile
        details = {
            "founder_name": sp.founder_name,
            "founder_email": sp.founder_email,
            "founder_mobile": sp.founder_mobile,
            "preferred_language": sp.preferred_language,
            "company_name": sp.company_name,
            "industry": sp.industry,
            "business_model": sp.business_model,
            "founded_year": sp.founded_year,
            "stage": sp.stage,
            "location": sp.location,
            "website": sp.website,
            "headcount": sp.headcount,
            "gst_number": sp.gst_number,
            "is_pre_revenue": sp.is_pre_revenue,
            "monthly_revenue": sp.monthly_revenue,
            "revenue_streams": sp.revenue_streams,
            "revenue_growth_pct_input": sp.revenue_growth_pct_input,
            "paying_customers": sp.paying_customers,
            "fixed_costs": sp.fixed_costs,
            "variable_costs": sp.variable_costs,
            "current_cash": sp.current_cash,
            "monthly_burn_input": sp.monthly_burn_input,
            "business_loans_debt": sp.business_loans_debt,
            "total_funding": sp.total_funding,
            "last_round": sp.last_round,
            "currently_fundraising": sp.currently_fundraising,
            "fundraising_target": sp.fundraising_target,
            "planned_hires": sp.planned_hires,
            "cost_per_hire": sp.cost_per_hire
        }
    elif profile.key == "enterprise" and profile.enterprise_profile:
        ep = profile.enterprise_profile
        details = {
            "cfo_name": ep.cfo_name,
            "corporate_email": ep.corporate_email,
            "corporate_mobile": ep.corporate_mobile,
            "org_name": ep.org_name,
            "industry": ep.industry,
            "headcount": ep.headcount,
            "gst_number": ep.gst_number,
            "treasury_balance": ep.treasury_balance,
            "annual_turnover": ep.annual_turnover,
            "quarterly_cash_flow": ep.quarterly_cash_flow,
            "operating_expenses": ep.operating_expenses,
            "fx_exposure_pct": ep.fx_exposure_pct,
            "currently_fundraising": ep.currently_fundraising,
            "debt_amount": ep.debt_amount
        }
    elif profile.key == "individual":
        details = profile.raw_inputs or {}


    return {
        "key": profile.key,
        "label": profile.label,
        "persona": profile.persona,
        "currency": profile.currency or "₹",
        "metrics": profile.metrics,
        "goal": profile.goal,
        "details": details,
        "raw_inputs": profile.raw_inputs or {},
        # The picture itself (a data URI) and the two-letter fallback, so every
        # avatar on the page can render from one call without a second request.
        "avatar": avatar_service.get_avatar(profile),
        "initials": avatar_service.initials_for(profile, current_user.username),
        "alerts": [{"level": a.level, "text": a.text} for a in profile.alerts],
        "history": [{"title": h.title, "date_str": h.date_str, "outcome": h.outcome, "tag": h.tag} for h in profile.history],
        "decisionTypes": profile.decisionTypes,
        "insights_schedule": profile.insights_schedule,
        "whatsapp_phone": profile.whatsapp_phone,
    }


@router.post("/avatar")
async def upload_avatar(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Replace the caller's profile picture.

    Upload and replace are the same operation: there is one picture per
    profile, so a second upload overwrites the first and no orphan is left
    behind anywhere.

    The image is decoded, centre-cropped, downscaled and re-encoded before it
    is stored — see backend/services/avatar_service.py. That is what keeps a
    4 MB phone photo from becoming 4 MB in a JSON column, and decoding is also
    the only honest way to confirm a file really is an image.
    """
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    data = await file.read()
    try:
        uri = avatar_service.process_upload(data, file.content_type)
    except avatar_service.AvatarError as exc:
        # 422 rather than 400: the request was well-formed, the file was not.
        raise HTTPException(status_code=422, detail=str(exc))

    avatar_service.set_avatar(profile, uri)
    db.commit()
    return {
        "avatar": uri,
        "initials": avatar_service.initials_for(profile, current_user.username),
    }


@router.delete("/avatar")
def remove_avatar(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Drop the picture and fall back to initials. Idempotent."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    avatar_service.set_avatar(profile, None)
    db.commit()
    return {
        "avatar": None,
        "initials": avatar_service.initials_for(profile, current_user.username),
    }


@router.get("/risk")
def get_risk_profile(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """The user's computed risk position, in full, with its drivers.

    Everything here is deterministic — computed from the profile's own figures
    by backend/services/risk_profile.py, never by a model. The response
    deliberately separates three kinds of thing, because collapsing them into a
    single "risk score" is what makes such a score meaningless:

      * capacity  — what the numbers say this person can absorb
      * tolerance — what they have actually told us, or null if they have not
      * unknowns  — what is missing, named rather than assumed

    A null in `tolerance` is a real answer. Risk tolerance is not computable
    from a balance sheet, and inferring one would be inventing a preference on
    the user's behalf.
    """
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    ctx = build_financial_context(profile)
    dna = build_risk_profile(profile, ctx, db=db)
    data = dna.to_dict()

    return {
        "currency": data.get("currency") or "₹",
        "summary": dna.summary_line(),
        "capacity": {
            "score": data.get("capacity_score"),
            "band": data.get("capacity_band"),
            "drivers": data.get("capacity_drivers") or [],
        },
        "reserve": {
            "months": data.get("emergency_buffer_months"),
            "band": data.get("reserve_band"),
            "note": data.get("reserve_note"),
        },
        "debt": {
            "outstanding": data.get("outstanding_debt"),
            "pct_of_annual_income": data.get("debt_to_annual_income_pct"),
            "band": data.get("debt_band"),
            "likely_high_interest": data.get("likely_high_interest_debt"),
            "evidence": data.get("high_interest_evidence") or [],
        },
        "protection": {
            "dependents": data.get("dependents"),
            "insurance_cover": data.get("insurance_cover"),
            "cover_years_of_income": data.get("insurance_cover_years_of_income"),
            "band": data.get("insurance_band"),
        },
        "income": {
            "stability": data.get("income_stability"),
            "basis": data.get("income_stability_basis"),
            "monthly_surplus": data.get("monthly_surplus"),
            "savings_rate_pct": data.get("savings_rate_pct"),
        },
        "investments": {
            "existing": data.get("existing_investments"),
            "exposure_pct": data.get("investment_exposure_pct"),
        },
        # Null until the user says so in conversation. Not inferred.
        "tolerance": {
            "stated": data.get("stated_tolerance"),
            "horizon_years": data.get("stated_horizon_years"),
            "objective": data.get("stated_objective"),
            "loss_comfort": data.get("loss_comfort"),
        },
        "blocking_priorities": data.get("blocking_priorities") or [],
        "constraints": data.get("constraints") or [],
        "unknowns": data.get("unknowns") or [],
        "calculation": {
            "method": (
                "Deterministic. Reserve months = savings / monthly expenses; debt load = "
                "outstanding debt / annual income; capacity is a weighted composite of "
                "reserve, debt, income stability, protection and surplus."
            ),
            "data_source": "Your onboarding figures and your Hisaab ledger.",
            "model_generated": False,
        },
    }
