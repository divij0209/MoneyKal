import io
import re
import csv
import pandas as pd
import PyPDF2
import openpyxl
from fastapi import APIRouter, UploadFile, File, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Optional, Union

from backend.database import get_db
from sqlalchemy.orm import Session
from backend.models.domain import Profile, User, StartupProfile, EnterpriseProfile
from backend.services.gemini_service import gemini_service
from backend.core.auth import get_current_user
from backend.schemas.startup_models import StartupOnboardingRequest, StartupOverviewResponse
from backend.agents.startup_orchestrator import startup_orchestrator
from backend.routers.startup import build_overview_payload, log_startup_decision

router = APIRouter(prefix="/onboard", tags=["Onboarding"])

def extract_text_from_file(file_bytes: bytes, filename: str) -> str:
    if filename.endswith(".pdf"):
        try:
            reader = PyPDF2.PdfReader(io.BytesIO(file_bytes))
            text = ""
            for page in reader.pages:
                extracted = page.extract_text()
                if extracted:
                    text += extracted
            return text
        except Exception:
            return ""
    elif filename.endswith(".csv"):
        try:
            df = pd.read_csv(io.BytesIO(file_bytes))
            return df.to_csv(index=False)
        except:
            return ""
    elif filename.endswith((".xls", ".xlsx")):
        try:
            df = pd.read_excel(io.BytesIO(file_bytes))
            return df.to_csv(index=False)
        except:
            return ""
    return file_bytes.decode('utf-8', errors='ignore')

@router.post("/parse-statement")
async def parse_statement(file: UploadFile = File(...), current_user: User = Depends(get_current_user)):
    contents = await file.read()
    text = extract_text_from_file(contents, file.filename)

    if not gemini_service.available():
        raise HTTPException(status_code=500, detail="LLM client not configured")

    prompt = f"""
    You are a financial data extraction AI. Extract the following from this bank statement/text:
    - Monthly Salary (Income)
    - Total Savings/Balance
    - Average Monthly Expenses (Categorized into Food, Rent, EMI, Shopping, Others)
    - Any active Loans detected

    Text: {text[:5000]}

    Output ONLY valid JSON matching this exact structure:
    {{
        "salary": 0,
        "savings": 0,
        "expenses": {{ "food": 0, "rent": 0, "emi": 0, "shopping": 0, "others": 0 }},
        "loans": 0
    }}
    """

    data = gemini_service.generate_json(prompt, temperature=0.1)
    if data is None:
        raise HTTPException(status_code=500, detail="Failed to parse statement")
    return data

# Bounds for every money field the user types.
#
# These were previously unconstrained floats: an income of −50,000 was accepted
# and stored, and so was a savings balance of ₹999,999,999,999. Both then flowed
# into every downstream projection, the risk model and the LLM prompts, where a
# negative income produces confident nonsense rather than an error.
#
# The ceiling is deliberately generous — ₹1,000 crore covers any individual and
# any startup that would realistically use this — and exists to catch a
# fat-fingered extra digit, not to judge how much money someone has.
MAX_MONEY = 1e12
MAX_DEPENDENTS = 30
_TEXT_MAX = 200


class IndividualOnboardingRequest(BaseModel):
    full_name: Optional[str] = Field("", max_length=_TEXT_MAX)
    email: Optional[str] = Field("", max_length=254)
    mobile: Optional[str] = Field("", max_length=32)
    occupation: Optional[str] = Field("", max_length=_TEXT_MAX)
    # Drives the HRA metro cap in the tax engine, so it is stored on the
    # profile and prefilled into the Tax Calculator on first open.
    city: Optional[str] = Field("", max_length=_TEXT_MAX)
    monthly_income: float = Field(0.0, ge=0, le=MAX_MONEY)
    total_savings: float = Field(0.0, ge=0, le=MAX_MONEY)
    monthly_expenses: float = Field(0.0, ge=0, le=MAX_MONEY)
    outstanding_loans: float = Field(0.0, ge=0, le=MAX_MONEY)
    existing_investments: Optional[float] = Field(0.0, ge=0, le=MAX_MONEY)
    insurance_coverage: Optional[float] = Field(0.0, ge=0, le=MAX_MONEY)
    dependents: Optional[int] = Field(0, ge=0, le=MAX_DEPENDENTS)
    goal_title: Optional[str] = Field("Financial Independence", max_length=_TEXT_MAX)
    goal_target_amount: Optional[float] = Field(0.0, ge=0, le=MAX_MONEY)
    goal_target_date: Optional[str] = Field(None, max_length=32)


class SaveProfileRequest(BaseModel):
    persona: str
    metrics: List[Dict[str, Any]]


@router.post("/confirm")
def confirm_profile(req: Union[IndividualOnboardingRequest, SaveProfileRequest], current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        profile = Profile(user_id=current_user.id)
        db.add(profile)
        db.flush()

    profile.key = "individual"
    profile.label = "Individual"
    profile.currency = "₹"

    if isinstance(req, IndividualOnboardingRequest):
        profile.persona = req.full_name or req.occupation or current_user.username
        profile.raw_inputs = {
            "full_name": req.full_name,
            "email": req.email or current_user.username,
            "mobile": req.mobile,
            "occupation": req.occupation,
            "city": req.city,
            "monthly_income": req.monthly_income,
            "total_savings": req.total_savings,
            "monthly_expenses": req.monthly_expenses,
            "outstanding_loans": req.outstanding_loans,
            "existing_investments": req.existing_investments or 0.0,
            "insurance_coverage": req.insurance_coverage or 0.0,
            "dependents": req.dependents or 0,
            "goal_title": req.goal_title or "Financial Independence",
            "goal_target_amount": req.goal_target_amount or 0.0,
            "goal_target_date": req.goal_target_date
        }
        profile.metrics = [
            {"id": "m_income", "label": "Monthly Income", "value": req.monthly_income, "unit": "₹", "trend": [0, req.monthly_income]},
            {"id": "m_savings", "label": "Total Savings", "value": req.total_savings, "unit": "₹", "trend": [0, req.total_savings]},
            {"id": "m_expenses", "label": "Monthly Expenses", "value": req.monthly_expenses, "unit": "₹", "trend": [0, req.monthly_expenses]},
            {"id": "m_loans", "label": "Active Loans", "value": req.outstanding_loans, "unit": "₹", "trend": [0, req.outstanding_loans]},
            {"id": "m_investments", "label": "Investments", "value": req.existing_investments or 0.0, "unit": "₹", "trend": [0, req.existing_investments or 0.0]},
            {"id": "m_insurance", "label": "Insurance Cover", "value": req.insurance_coverage or 0.0, "unit": "₹", "trend": [0, req.insurance_coverage or 0.0]},
            {"id": "m_dependents", "label": "Dependents", "value": req.dependents or 0, "unit": "", "trend": [0, req.dependents or 0]}
        ]
        profile.goal = {
            "title": req.goal_title or "Financial Independence",
            "target": req.goal_target_amount or 0.0,
            "target_date": req.goal_target_date,
            "progress": 25
        }
    else:
        profile.metrics = req.metrics
        profile.goal = {"title": "Financial Independence", "progress": 25}

    profile.decisionTypes = [
        {"id": "invest_index", "label": "Invest in Index Fund", "primaryLabel": "Est. Return", "primaryUnit": "%", "secondaryLabel": "Risk", "secondaryUnit": " lvl"},
        {"id": "pay_debt", "label": "Pay off Debt", "primaryLabel": "Interest Saved", "primaryUnit": "₹", "secondaryLabel": "Liquidity Hit", "secondaryUnit": "₹"}
    ]

    db.commit()
    return {"status": "ok", "profile_key": "individual"}

class ChatMessage(BaseModel):
    role: str
    content: str

class AiOnboardingRequest(BaseModel):
    messages: List[ChatMessage]

@router.post("/chat")
def ai_onboarding_chat(req: AiOnboardingRequest, current_user: User = Depends(get_current_user)):
    if not gemini_service.available():
        raise HTTPException(status_code=500, detail="LLM client not configured.")

    system_prompt = """You are a financial onboarding AI for Indian users. All amounts are in Indian Rupees (₹) — always use the ₹ symbol when referring to money, never $. Ask the user 3 to 4 short, conversational questions one by one to figure out their monthly salary, total savings, average monthly expenses, and any active loans.

Once you have enough information, reply with the exact word ONBOARDING_COMPLETE followed immediately by a JSON block. The JSON MUST match this exact structure and these exact keys (numbers only, no currency symbols, no strings):

{
    "salary": 0,
    "savings": 0,
    "expenses": { "food": 0, "rent": 0, "emi": 0, "shopping": 0, "others": 0 },
    "loans": 0
}

Do not include any other text, explanation, or markdown after the JSON. Do not rename any keys. If a value wasn't mentioned by the user, estimate 0 for it rather than omitting the key."""

    msgs = [{"role": m.role, "content": m.content} for m in req.messages]
    if not msgs:
        raise HTTPException(status_code=400, detail="No messages provided.")

    try:
        reply = gemini_service.generate(
            msgs[-1]["content"],
            system_instruction=system_prompt,
            chat_history=msgs[:-1],
        )
        return {"reply": reply}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/startup", response_model=StartupOverviewResponse)
def onboard_startup(req: StartupOnboardingRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Builds the Startup Financial Twin from the founder's onboarding wizard —
    completely separate from Individual's /onboard/confirm (own model, own
    engine, own dashboard)."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        profile = Profile(user_id=current_user.id)
        db.add(profile)
        db.flush()

    profile.key = "startup"
    profile.label = "Startup"
    profile.persona = req.company.name
    profile.currency = "₹"
    db.commit()
    db.refresh(profile)

    sp = profile.startup_profile
    if not sp:
        sp = StartupProfile(profile_id=profile.id)
        db.add(sp)

    sp.founder_name = req.founder.name
    sp.founder_email = req.founder.email
    sp.founder_mobile = req.founder.mobile
    sp.preferred_language = req.founder.preferred_language
    sp.company_name = req.company.name
    sp.industry = req.company.industry
    sp.business_model = req.company.business_model
    sp.founded_year = req.company.founded_year
    sp.stage = req.company.stage
    sp.location = req.company.location
    sp.website = req.company.website
    sp.headcount = req.company.headcount

    if req.company.gst_number and req.company.gst_number.strip():
        gst_clean = req.company.gst_number.strip().upper()
        if not re.match(GSTIN_REGEX, gst_clean):
            raise HTTPException(status_code=400, detail="Invalid GST Number format. Must be a valid 15-character GSTIN (e.g. 27AAAAA0000A1Z5).")
        sp.gst_number = gst_clean
    else:
        sp.gst_number = None
    sp.is_pre_revenue = req.revenue.is_pre_revenue
    sp.monthly_revenue = None if req.revenue.is_pre_revenue else req.revenue.monthly_revenue
    sp.revenue_streams = req.revenue.revenue_streams
    sp.revenue_growth_pct_input = req.revenue.revenue_growth_pct
    sp.paying_customers = req.revenue.paying_customers
    sp.fixed_costs = req.expenses.fixed_costs
    sp.variable_costs = req.expenses.variable_costs
    sp.current_cash = req.cash.current_cash
    sp.monthly_burn_input = req.cash.monthly_burn
    sp.business_loans_debt = req.debt.business_loans_debt
    sp.total_funding = req.funding.total_funding
    sp.last_round = req.funding.last_round
    sp.currently_fundraising = req.funding.currently_fundraising
    sp.fundraising_target = req.funding.fundraising_target
    sp.planned_hires = req.team.planned_hires
    sp.cost_per_hire = req.team.cost_per_hire
    sp.goals = [g.model_dump() for g in req.goals]
    sp.current_decision = req.current_decision

    db.commit()
    db.refresh(profile)
    db.refresh(sp)

    # Log the founder's "current financial decision" as the first Recent Decision,
    # if it parses into a computable scenario (deterministic — same pipeline as Simulate).
    if req.current_decision and req.current_decision.strip():
        try:
            sim_response = startup_orchestrator.run_scenario_simulation(profile, req.current_decision.strip())
            log_startup_decision(db, profile, req.current_decision.strip(), sim_response)
        except Exception:
            pass  # Onboarding should never fail because the decision text didn't parse cleanly.

    return build_overview_payload(db, profile)


GSTIN_REGEX = r"^\d{2}[A-Z]{5}\d{4}[A-Z]{1}\d[A-Z]{1}[A-Z\d]{1}$"


class EnterpriseOnboardingRequest(BaseModel):
    cfo_name: Optional[str] = ""
    corporate_email: Optional[str] = ""
    corporate_mobile: Optional[str] = ""
    org_name: str
    industry: Optional[str] = ""
    headcount: Optional[int] = 0
    gst_number: str
    treasury_balance: float
    annual_turnover: Optional[float] = 0.0
    quarterly_cash_flow: float
    operating_expenses: Optional[float] = 0.0
    fx_exposure_pct: float
    currently_fundraising: Optional[bool] = False
    debt_amount: Optional[float] = 0.0


@router.post("/enterprise", deprecated=True)
def onboard_enterprise(req: EnterpriseOnboardingRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Retired. Kept as an explicit 410 rather than deleted.

    The Enterprise persona was withdrawn: the picker no longer offers it, and
    backend/routers/auth.py refuses to sign in any profile whose key is
    "enterprise". This route, however, stayed live and unguarded, so any
    authenticated caller could set their own profile to that key and be locked
    out of their account permanently, with no way back through the UI.

    Returning 410 documents that the endpoint existed and is gone, which is more
    useful to an integrator than a 404, and — unlike deleting the function —
    leaves no route free to be re-registered by accident.
    """
    raise HTTPException(
        status_code=410,
        detail=(
            "Enterprise onboarding has been retired. Choose the Individual or "
            "Startup profile instead."
        ),
    )


def _onboard_enterprise_retired(req, current_user, db):
    gst_clean = (req.gst_number or "").strip().upper()
    if not gst_clean or not re.match(GSTIN_REGEX, gst_clean):
        raise HTTPException(status_code=400, detail="Invalid GST Number format. Must be a valid 15-character GSTIN (e.g. 27AAAAA0000A1Z5).")

    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        profile = Profile(user_id=current_user.id)
        db.add(profile)
        db.flush()

    profile.key = "enterprise"
    profile.label = "Enterprise"
    profile.persona = req.org_name or req.cfo_name or "Enterprise CFO"
    profile.currency = "₹"

    ep = profile.enterprise_profile
    if not ep:
        ep = EnterpriseProfile(profile_id=profile.id)
        db.add(ep)

    ep.cfo_name = req.cfo_name
    ep.corporate_email = req.corporate_email or current_user.username
    ep.corporate_mobile = req.corporate_mobile
    ep.org_name = req.org_name
    ep.industry = req.industry
    ep.headcount = req.headcount
    ep.gst_number = gst_clean
    ep.treasury_balance = req.treasury_balance
    ep.annual_turnover = req.annual_turnover or 0.0
    ep.quarterly_cash_flow = req.quarterly_cash_flow
    ep.operating_expenses = req.operating_expenses or 0.0
    ep.fx_exposure_pct = req.fx_exposure_pct
    ep.currently_fundraising = req.currently_fundraising or False
    ep.debt_amount = req.debt_amount or 0.0

    profile.metrics = [
        {"id": "treasury", "label": "Treasury balance", "value": req.treasury_balance, "unit": " Cr", "trend": [req.treasury_balance], "isPercent": False},
        {"id": "cashflow", "label": "Quarterly cash flow", "value": req.quarterly_cash_flow, "unit": " Cr", "trend": [req.quarterly_cash_flow], "isPercent": False},
        {"id": "fxExposure", "label": "FX exposure", "value": req.fx_exposure_pct, "unit": "%", "trend": [req.fx_exposure_pct], "isPercent": False},
        {"id": "turnover", "label": "Annual turnover", "value": req.annual_turnover or 0.0, "unit": " Cr", "trend": [req.annual_turnover or 0.0], "isPercent": False}
    ]
    profile.goal = {"title": "Optimize Treasury", "progress": 0, "target": 100}

    db.commit()
    db.refresh(profile)
    return {"status": "ok"}


class IndividualUpdateRequest(BaseModel):
    """Edits from the account centre.

    Every bound here mirrors IndividualOnboardingRequest above. Without them
    this route is a second, unguarded way to store a negative income or a
    twelve-digit savings balance — the onboarding route rejects both, and a
    value that cannot be entered at sign-up should not be enterable later.
    """
    full_name: Optional[str] = Field(None, max_length=_TEXT_MAX)
    email: Optional[str] = Field(None, max_length=254)
    mobile: Optional[str] = Field(None, max_length=32)
    occupation: Optional[str] = Field(None, max_length=_TEXT_MAX)
    # Drives the HRA metro cap in the tax engine, and is prefilled into the
    # Tax Calculator, so it has to be editable once onboarding is done.
    city: Optional[str] = Field(None, max_length=_TEXT_MAX)
    monthly_income: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    total_savings: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    monthly_expenses: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    outstanding_loans: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    existing_investments: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    insurance_coverage: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    dependents: Optional[int] = Field(None, ge=0, le=MAX_DEPENDENTS)
    goal_title: Optional[str] = Field(None, max_length=_TEXT_MAX)
    goal_target_amount: Optional[float] = Field(None, ge=0, le=MAX_MONEY)
    goal_target_date: Optional[str] = Field(None, max_length=32)
    insights_schedule: Optional[str] = Field(None, max_length=32)
    whatsapp_phone: Optional[str] = Field(None, max_length=32)


@router.put("/individual/update")
def update_individual_profile(req: IndividualUpdateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile or profile.key != "individual":
        raise HTTPException(status_code=400, detail="Active profile is not an Individual profile.")

    raw = dict(profile.raw_inputs or {})
    for k, v in req.dict(exclude_unset=True).items():
        if k == "insights_schedule":
            if v is not None:
                profile.insights_schedule = v
            continue
        if k == "whatsapp_phone":
            profile.whatsapp_phone = v  # allow empty string to clear
            continue
        if v is not None:
            raw[k] = v

    profile.raw_inputs = raw
    if req.full_name:
        profile.persona = req.full_name

    income = raw.get("monthly_income", 0.0)
    savings = raw.get("total_savings", 0.0)
    expenses = raw.get("monthly_expenses", 0.0)
    loans = raw.get("outstanding_loans", 0.0)
    investments = raw.get("existing_investments", 0.0)
    insurance = raw.get("insurance_coverage", 0.0)
    dependents = raw.get("dependents", 0)

    profile.metrics = [
        {"id": "m_income", "label": "Monthly Income", "value": income, "unit": "₹", "trend": [0, income]},
        {"id": "m_savings", "label": "Total Savings", "value": savings, "unit": "₹", "trend": [0, savings]},
        {"id": "m_expenses", "label": "Monthly Expenses", "value": expenses, "unit": "₹", "trend": [0, expenses]},
        {"id": "m_loans", "label": "Active Loans", "value": loans, "unit": "₹", "trend": [0, loans]},
        {"id": "m_investments", "label": "Investments", "value": investments, "unit": "₹", "trend": [0, investments]},
        {"id": "m_insurance", "label": "Insurance Cover", "value": insurance, "unit": "₹", "trend": [0, insurance]},
        {"id": "m_dependents", "label": "Dependents", "value": dependents, "unit": "", "trend": [0, dependents]}
    ]

    if req.goal_title or req.goal_target_amount or req.goal_target_date:
        g = dict(profile.goal or {})
        if req.goal_title is not None: g["title"] = req.goal_title
        if req.goal_target_amount is not None: g["target"] = req.goal_target_amount
        if req.goal_target_date is not None: g["target_date"] = req.goal_target_date
        profile.goal = g

    db.commit()
    db.refresh(profile)
    return {"status": "ok", "message": "Individual profile updated successfully."}


class EnterpriseUpdateRequest(BaseModel):
    cfo_name: Optional[str] = None
    corporate_email: Optional[str] = None
    corporate_mobile: Optional[str] = None
    org_name: Optional[str] = None
    industry: Optional[str] = None
    headcount: Optional[int] = None
    gst_number: Optional[str] = None
    treasury_balance: Optional[float] = None
    annual_turnover: Optional[float] = None
    quarterly_cash_flow: Optional[float] = None
    operating_expenses: Optional[float] = None
    fx_exposure_pct: Optional[float] = None
    currently_fundraising: Optional[bool] = None
    debt_amount: Optional[float] = None
    insights_schedule: Optional[str] = None


@router.put("/enterprise/update")
def update_enterprise_profile(req: EnterpriseUpdateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile or profile.key != "enterprise":
        raise HTTPException(status_code=400, detail="Active profile is not an Enterprise profile.")

    ep = profile.enterprise_profile
    if not ep:
        ep = EnterpriseProfile(profile_id=profile.id)
        db.add(ep)

    if req.gst_number is not None:
        gst_clean = req.gst_number.strip().upper()
        if not gst_clean or not re.match(GSTIN_REGEX, gst_clean):
            raise HTTPException(status_code=400, detail="Invalid GST Number format. Must be a valid 15-digit GSTIN (e.g. 27AAAAA0000A1Z5).")
        ep.gst_number = gst_clean

    for field, val in req.dict(exclude_unset=True).items():
        if field == "insights_schedule":
            if val is not None:
                profile.insights_schedule = val
            continue
        if field != "gst_number" and val is not None:
            setattr(ep, field, val)

    if req.org_name:
        profile.persona = req.org_name

    profile.metrics = [
        {"id": "treasury", "label": "Treasury balance", "value": ep.treasury_balance or 0.0, "unit": " Cr", "trend": [ep.treasury_balance or 0.0], "isPercent": False},
        {"id": "cashflow", "label": "Quarterly cash flow", "value": ep.quarterly_cash_flow or 0.0, "unit": " Cr", "trend": [ep.quarterly_cash_flow or 0.0], "isPercent": False},
        {"id": "fxExposure", "label": "FX exposure", "value": ep.fx_exposure_pct or 0.0, "unit": "%", "trend": [ep.fx_exposure_pct or 0.0], "isPercent": False},
        {"id": "turnover", "label": "Annual turnover", "value": ep.annual_turnover or 0.0, "unit": " Cr", "trend": [ep.annual_turnover or 0.0], "isPercent": False}
    ]

    db.commit()
    db.refresh(profile)
    return {"status": "ok", "message": "Enterprise profile updated successfully."}


class StartupUpdateRequest(BaseModel):
    founder_name: Optional[str] = None
    founder_email: Optional[str] = None
    founder_mobile: Optional[str] = None
    preferred_language: Optional[str] = None
    company_name: Optional[str] = None
    industry: Optional[str] = None
    business_model: Optional[str] = None
    founded_year: Optional[int] = None
    stage: Optional[str] = None
    location: Optional[str] = None
    website: Optional[str] = None
    headcount: Optional[int] = None
    gst_number: Optional[str] = None
    is_pre_revenue: Optional[bool] = None
    monthly_revenue: Optional[float] = None
    revenue_growth_pct_input: Optional[float] = None
    paying_customers: Optional[int] = None
    fixed_costs: Optional[float] = None
    variable_costs: Optional[float] = None
    current_cash: Optional[float] = None
    monthly_burn_input: Optional[float] = None
    business_loans_debt: Optional[float] = None
    total_funding: Optional[float] = None
    last_round: Optional[str] = None
    currently_fundraising: Optional[bool] = None
    fundraising_target: Optional[float] = None
    planned_hires: Optional[int] = None
    cost_per_hire: Optional[float] = None
    insights_schedule: Optional[str] = None


@router.put("/startup/update")
def update_startup_profile(req: StartupUpdateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile or profile.key != "startup":
        raise HTTPException(status_code=400, detail="Active profile is not a Startup profile.")

    sp = profile.startup_profile
    if not sp:
        raise HTTPException(status_code=404, detail="Startup profile record not found.")

    if req.gst_number is not None:
        if req.gst_number.strip():
            gst_clean = req.gst_number.strip().upper()
            if not re.match(GSTIN_REGEX, gst_clean):
                raise HTTPException(status_code=400, detail="Invalid GST Number format. Must be a valid 15-character GSTIN (e.g. 27AAAAA0000A1Z5).")
            sp.gst_number = gst_clean
        else:
            sp.gst_number = None

    for field, val in req.dict(exclude_unset=True).items():
        if field == "insights_schedule":
            if val is not None:
                profile.insights_schedule = val
            continue
        if field != "gst_number" and val is not None:
            setattr(sp, field, val)

    if req.company_name:
        profile.persona = req.company_name

    db.commit()
    db.refresh(profile)
    return {"status": "ok", "message": "Startup profile updated successfully."}


@router.get("/excel/template")
def download_excel_template(
    persona: str = Query("individual", description="individual, enterprise, or startup")
):
    persona_clean = persona.lower().strip()
    schema_map = {
        "individual": IndividualUpdateRequest,
        "enterprise": EnterpriseUpdateRequest,
        "startup": StartupUpdateRequest
    }
    model_cls = schema_map.get(persona_clean, IndividualUpdateRequest)
    fields = list(model_cls.__fields__.keys())

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = f"{persona_clean.capitalize()} Data"

    ws.append(fields)

    sample_row = []
    for field in fields:
        field_info = model_cls.__fields__[field]
        field_type_str = str(getattr(field_info, 'annotation', getattr(field_info, 'outer_type_', str(field_info)))).lower()
        if field == "gst_number":
            sample_row.append("27AAAAA0000A1Z5")
        elif "int" in field_type_str:
            sample_row.append(10)
        elif "float" in field_type_str:
            sample_row.append(50000.0)
        elif "bool" in field_type_str:
            sample_row.append("true")
        else:
            sample_row.append(f"Sample {field.replace('_', ' ').title()}")
    ws.append(sample_row)

    for col in ws.columns:
        max_len = max(len(str(cell.value or '')) for cell in col)
        col_letter = openpyxl.utils.get_column_letter(col[0].column)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 15)

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    filename = f"{persona_clean}_onboarding_template.xlsx"
    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'}
    )


@router.post("/excel/upload")
async def upload_excel_file(
    file: UploadFile = File(...),
    persona_override: Optional[str] = Query(None),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found for current user.")

    active_persona = (persona_override or profile.key or "individual").lower().strip()
    if active_persona != profile.key:
        raise HTTPException(status_code=400, detail=f"Uploaded persona '{active_persona}' does not match user's active profile key '{profile.key}'.")

    contents = await file.read()
    if len(contents) > 5 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File size exceeds the 5 MB limit.")

    filename = (file.filename or "").lower()
    if not (filename.endswith(".xlsx") or filename.endswith(".xls") or filename.endswith(".csv")):
        raise HTTPException(status_code=400, detail="Unsupported file format. Please upload an .xlsx, .xls, or .csv file.")

    raw_row_data = {}
    try:
        if filename.endswith(".csv"):
            text_str = contents.decode("utf-8-sig", errors="ignore")
            reader = csv.DictReader(io.StringIO(text_str))
            for row in reader:
                for k, v in row.items():
                    if k and k.strip():
                        raw_row_data[k.strip()] = v
                break
        else:
            wb = openpyxl.load_workbook(io.BytesIO(contents), data_only=True)
            ws = wb.active
            rows = list(ws.iter_rows(values_only=True))
            if not rows or len(rows) < 2:
                raise HTTPException(status_code=400, detail="Excel sheet appears empty or missing data row.")
            
            headers = [str(h).strip() if h else "" for h in rows[0]]
            data_row = rows[1]
            for idx, h in enumerate(headers):
                if h and idx < len(data_row):
                    raw_row_data[h] = data_row[idx]
    except Exception as e:
        if isinstance(e, HTTPException): raise e
        raise HTTPException(status_code=400, detail=f"Failed to parse spreadsheet: {str(e)}")

    schema_map = {
        "individual": IndividualUpdateRequest,
        "enterprise": EnterpriseUpdateRequest,
        "startup": StartupUpdateRequest
    }
    model_cls = schema_map.get(active_persona, IndividualUpdateRequest)
    known_fields = model_cls.__fields__

    valid_payload = {}
    errors = []

    for key, val in raw_row_data.items():
        if key not in known_fields:
            continue

        if val is None:
            continue
        val_str = str(val).strip()
        if not val_str or val_str.lower() in ["n/a", "none", "null", "undefined"]:
            continue

        field_info = known_fields[key]
        field_type_str = str(getattr(field_info, 'annotation', getattr(field_info, 'outer_type_', str(field_info)))).lower()

        try:
            if key == "gst_number":
                gst_clean = val_str.upper()
                if not re.match(GSTIN_REGEX, gst_clean):
                    errors.append({"field": key, "value": val_str, "error": "Invalid 15-character GSTIN format (e.g. 27AAAAA0000A1Z5)"})
                    continue
                valid_payload[key] = gst_clean
            elif "bool" in field_type_str:
                valid_payload[key] = val_str.lower() in ["true", "1", "yes"]
            elif "int" in field_type_str:
                parsed_val = int(float(val_str))
                if parsed_val < 0 and key not in ["quarterly_cash_flow"]:
                    errors.append({"field": key, "value": val_str, "error": "Value cannot be negative"})
                    continue
                valid_payload[key] = parsed_val
            elif "float" in field_type_str:
                parsed_val = float(val_str)
                if parsed_val < 0 and key not in ["quarterly_cash_flow"]:
                    errors.append({"field": key, "value": val_str, "error": "Value cannot be negative"})
                    continue
                valid_payload[key] = parsed_val
            else:
                valid_payload[key] = val_str
        except Exception as ex:
            errors.append({"field": key, "value": val_str, "error": f"Invalid type format for field '{key}'"})

    if not valid_payload:
        return {
            "status": "warning",
            "message": "No valid fields were updated from the sheet.",
            "updated_fields": [],
            "errors": errors
        }

    if active_persona == "individual":
        req = IndividualUpdateRequest(**valid_payload)
        update_individual_profile(req, current_user, db)
    elif active_persona == "enterprise":
        req = EnterpriseUpdateRequest(**valid_payload)
        update_enterprise_profile(req, current_user, db)
    elif active_persona == "startup":
        req = StartupUpdateRequest(**valid_payload)
        update_startup_profile(req, current_user, db)

    return {
        "status": "success" if not errors else "partial_success",
        "message": f"Successfully updated {len(valid_payload)} fields." + (" Some cells were skipped due to formatting errors." if errors else ""),
        "updated_count": len(valid_payload),
        "updated_fields": list(valid_payload.keys()),
        "errors": errors
    }

