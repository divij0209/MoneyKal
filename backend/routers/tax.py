"""
Individual Tax Calculator API.

Scoped to the Individual persona: every endpoint rejects Startup and
Enterprise/CFO profiles, so the feature cannot leak into those views.

Step 1 surface:
    GET  /tax/config           metadata the UI needs to render its forms
    POST /tax/collect          aggregate income heads (stateless preview)
    GET  /tax/profile          load saved inputs for a tax year
    PUT  /tax/profile          save inputs for a tax year
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.core.config import tax_config as cfg
from backend.core import access
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import Profile, TaxProfile, User
from backend.schemas.tax_models import IncomeCollectionResponse, TaxProfileInput
from backend.services import tax_service

router = APIRouter(prefix="/tax", tags=["Tax Calculator"])


def is_individual_key(key) -> bool:
    """
    Whether a profile key denotes an Individual.

    Onboarding writes "individual", but profiles created through other paths
    carry a per-user "custom_<username>" key. Both are Individuals; "startup"
    and "enterprise" are not. This mirrors the existing test in
    backend/routers/startup.py so the two agree on what an Individual is.
    """
    if not key:
        return False
    return key == "individual" or str(key).startswith("custom_")


#: The pay-per-use item this router's results belong to (pricing_config.SERVICES).
TAX_SKU = "tax_calculator"


def _results_unlocked(db: Session, user: User, year_key: str) -> bool:
    """Whether this user may see computed results for this tax year.

    Bought for the year, or included in ACT. Inputs are never locked: a user
    can fill in and save everything, and only the computed figures wait.
    """
    return access.has_service(db, user.id, TAX_SKU, year_key)


def _individual_profile(current_user: User, db: Session) -> Profile:
    """
    Resolve the caller's profile, refusing anything that is not an Individual.

    The sidebar hides this feature for other personas, but that is a UI
    concern; this is the actual boundary.
    """
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found for this user. Please complete onboarding.",
        )
    if not is_individual_key(profile.key):
        raise HTTPException(
            status_code=403,
            detail="The Tax Calculator is available to Individual profiles only.",
        )
    return profile


@router.get("/config")
def get_tax_config(tax_year: str = Query(None, description="e.g. FY2026-27")):
    """
    Everything the UI needs to render its forms and labels.

    Serving this from the backend keeps the statutory figures in one place —
    the frontend never hardcodes a rate or a limit.
    """
    year_key = tax_year or cfg.DEFAULT_TAX_YEAR
    if year_key not in cfg.TAX_YEARS:
        raise HTTPException(status_code=400, detail=f"Unknown tax year {year_key!r}.")

    year = cfg.get_year_config(year_key)
    scheme = year["labels"]["section_scheme"]

    deductions = {}
    for key, d in cfg.DEDUCTIONS.items():
        deductions[key] = {
            "key": key,
            "label": d["label"],
            "short_label": d.get("short_label", d["label"]),
            "section": cfg.section_label(key, year_key),
            "limit": d.get("limit"),
            "limit_senior": d.get("limit_senior"),
            "limit_severe": d.get("limit_severe"),
            "regimes": d["regimes"],
        }

    return {
        "tax_year": year_key,
        "available_years": list(cfg.TAX_YEARS.keys()),
        "labels": year["labels"],
        "section_scheme": scheme,
        "age_bands": cfg.AGE_BANDS,
        "regimes": {
            name: {
                "label": r["label"],
                "standard_deduction": r["standard_deduction"],
                "professional_tax": r["professional_tax"],
                "allows_chapter_via": r["allows_chapter_via"],
                "allows_hra": r["allows_hra"],
                "is_default_regime": r.get("is_default_regime", False),
                "rebate": r["rebate"],
                "surcharge": r["surcharge"],
                "slabs": r["slabs_by_age"],
            }
            for name, r in year["regimes"].items()
        },
        "cess_rate": year["cess_rate"],
        "cess_label": cfg.CESS_LABEL,
        "hra_rules": cfg.HRA_RULES,
        "salary_exemptions": cfg.SALARY_EXEMPTIONS,
        "employer_contributions": cfg.EMPLOYER_CONTRIBUTION_RULES,
        "motor_car": cfg.MOTOR_CAR_PERQUISITE,
        "house_property": cfg.HOUSE_PROPERTY_RULES,
        "capital_gains": cfg.CAPITAL_GAINS_RULES,
        "presumptive": cfg.PRESUMPTIVE_TAXATION,
        "deductions": deductions,
        "itr_forms": cfg.ITR_FORMS,
        "labour_code_basic_da_floor": cfg.LABOUR_CODE_BASIC_DA_FLOOR,
        # Help text and filing guides arrive already rendered for this year, so
        # the figures quoted to the user are the ones the engine just used.
        "field_guidance": cfg.get_field_guidance(year_key),
        "filing_guides": cfg.get_filing_guides(year_key),
        "disclaimer": tax_service.DISCLAIMER,
    }


@router.post("/collect", response_model=IncomeCollectionResponse)
def collect_income(
    payload: TaxProfileInput,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Aggregate all heads of income (Step 1).

    Stateless — nothing is persisted. The UI calls this on every change to
    keep the running summary live; use PUT /tax/profile to save.

    Returns 402 purchase_required until the tax year is unlocked, so the
    figures never leave the server for a locked year.
    """
    _individual_profile(current_user, db)
    access.require_service(db, current_user.id, TAX_SKU,
                           payload.taxpayer.tax_year or cfg.DEFAULT_TAX_YEAR)
    return tax_service.collect_income(payload)


@router.get("/profile")
def get_tax_profile(
    tax_year: str = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Load saved inputs for a tax year. Returns empty defaults when none exist."""
    profile = _individual_profile(current_user, db)
    year_key = tax_year or cfg.DEFAULT_TAX_YEAR

    saved = (
        db.query(TaxProfile)
        .filter(TaxProfile.profile_id == profile.id, TaxProfile.tax_year == year_key)
        .first()
    )
    if not saved:
        seeded, prefilled = _seed_from_profile(profile)
        return {
            "tax_year": year_key,
            "inputs": seeded,
            "last_result": None,
            "exists": False,
            # Which values came from the user's own profile rather than from
            # them typing here. The client marks these as editable estimates;
            # nothing is presented as a filed or confirmed figure.
            "prefilled": bool(prefilled),
            "prefilled_fields": prefilled,
        }

    unlocked = _results_unlocked(db, current_user, saved.tax_year)
    return {
        "tax_year": saved.tax_year,
        "inputs": saved.inputs or {},
        "last_result": saved.last_result if unlocked else None,
        "exists": True,
        "locked": not unlocked,
        "updated_at": saved.updated_at.isoformat() if saved.updated_at else None,
    }


@router.put("/profile")
def save_tax_profile(
    payload: TaxProfileInput,
    tax_year: str = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Save inputs for a tax year, upserting on (profile, year).

    The aggregated result is recomputed and cached alongside so the UI can
    reopen the view without a round trip, but `inputs` remains the source of
    truth — the cache is always regenerated, never trusted.
    """
    profile = _individual_profile(current_user, db)
    year_key = tax_year or payload.taxpayer.tax_year or cfg.DEFAULT_TAX_YEAR
    if year_key not in cfg.TAX_YEARS:
        raise HTTPException(status_code=400, detail=f"Unknown tax year {year_key!r}.")

    result = tax_service.collect_income(payload)

    saved = (
        db.query(TaxProfile)
        .filter(TaxProfile.profile_id == profile.id, TaxProfile.tax_year == year_key)
        .first()
    )
    if not saved:
        saved = TaxProfile(profile_id=profile.id, tax_year=year_key)
        db.add(saved)

    saved.inputs = payload.model_dump()
    saved.last_result = result.model_dump()
    db.commit()

    # Saving is always allowed; the computed result is only returned once the
    # year is unlocked.
    unlocked = _results_unlocked(db, current_user, year_key)
    return {
        "status": "ok",
        "tax_year": year_key,
        "result": result.model_dump() if unlocked else None,
        "locked": not unlocked,
    }


# ---------------------------------------------------------------------------
# First-open prefill
# ---------------------------------------------------------------------------

# Metro status changes the HRA exemption cap (50% of salary rather than 40%),
# so it is worth resolving from the city the user already gave us. The list is
# the four cities the Income-tax Act treats as metros for section 10(13A).
_METRO_CITIES = {"mumbai", "delhi", "new delhi", "kolkata", "calcutta", "chennai", "madras"}


def _seed_from_profile(profile: Profile):
    """Build the opening TaxProfileInput from what onboarding already collected.

    Returns (inputs_dict, prefilled_field_names). Anything the profile does not
    have is simply left at its schema default, so this degrades to exactly the
    previous blank form for a profile with no data.
    """
    seeded = TaxProfileInput()
    prefilled = []

    raw = profile.raw_inputs if isinstance(profile.raw_inputs, dict) else {}

    name = (raw.get("full_name") or profile.persona or "").strip()
    if name:
        seeded.taxpayer.name = name
        prefilled.append("taxpayer.name")

    city = (raw.get("city") or "").strip()
    if city:
        seeded.taxpayer.city = city
        seeded.taxpayer.is_metro = city.lower() in _METRO_CITIES
        prefilled.extend(["taxpayer.city", "taxpayer.is_metro"])

    # Monthly income is the figure the user typed at onboarding; annual CTC is
    # what the salary head wants. Twelve times monthly is an approximation of
    # CTC rather than CTC itself — it excludes employer PF and any bonus — which
    # is precisely why it is flagged as prefilled and left editable.
    monthly = raw.get("monthly_income")
    try:
        monthly = float(monthly) if monthly is not None else 0.0
    except (TypeError, ValueError):
        monthly = 0.0
    if monthly <= 0:
        monthly = _monthly_income_from_metrics(profile)

    if monthly > 0:
        seeded.salary.enabled = True
        seeded.salary.annual_ctc = round(monthly * 12, 2)
        prefilled.extend(["salary.enabled", "salary.annual_ctc"])

    return seeded.model_dump(), prefilled


def _monthly_income_from_metrics(profile: Profile) -> float:
    """Fallback for a profile whose raw_inputs predates the onboarding shape."""
    for metric in (profile.metrics or []):
        if not isinstance(metric, dict):
            continue
        mid = str(metric.get("id") or "").lower()
        label = str(metric.get("label") or "").lower()
        if mid in ("income", "m_income", "salary") or "income" in label:
            try:
                return float(metric.get("value") or 0)
            except (TypeError, ValueError):
                return 0.0
    return 0.0
