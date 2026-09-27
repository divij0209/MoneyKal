"""
Pydantic models for the Individual Tax Calculator.

Step 1 scope: collecting every head of income. The computation engine
(Step 4) consumes these same models, so the shapes here are the contract for
the whole feature.

All amounts are ANNUAL and in rupees unless a field name says otherwise.
"""

from typing import List, Optional, Literal
from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Taxpayer basics
# ---------------------------------------------------------------------------

class TaxpayerProfile(BaseModel):
    name: Optional[str] = ""
    age: int = Field(30, ge=0, le=120)
    city: Optional[str] = ""
    is_metro: bool = False
    tax_year: Optional[str] = None            # defaults to config DEFAULT_TAX_YEAR
    # Flags that only affect ITR form selection (Step 6)
    is_director: bool = False
    holds_unlisted_shares: bool = False
    has_foreign_income: bool = False
    has_foreign_assets: bool = False
    agricultural_income: float = 0.0


# ---------------------------------------------------------------------------
# 1. Salary — CTC structure
#
# Mirrors the reference workbook's "Main Input Template" + "CTC structure
# working" sheets. Percentages are of CTC or of (Basic + DA) as noted.
# ---------------------------------------------------------------------------

class SalaryComponent(BaseModel):
    """A single structured allowance / reimbursement line."""
    enabled: bool = False
    # 'fixed'   -> `amount` is an absolute annual rupee figure
    # 'percent' -> `percent_of_basic_da` applies to (Basic + DA)
    # 'count'   -> `count` children / meals, priced from config
    mode: Literal["fixed", "percent", "count"] = "fixed"
    amount: float = 0.0
    percent_of_basic_da: float = 0.0
    count: int = 0


class MotorCarPerquisite(BaseModel):
    """Rule 15 Table II valuation — mirrors the workbook's hidden sheet."""
    enabled: bool = False
    car_owner: Literal["employer", "employee"] = "employer"
    expense_bearer: Literal["employer", "employee"] = "employer"
    usage: Literal["official", "personal", "mixed"] = "mixed"
    engine_type: Literal["small", "large"] = "small"   # small = <=1.6L or EV
    chauffeur_provided: bool = False
    months_available: int = Field(12, ge=0, le=12)
    actual_cost_of_car: float = 0.0
    annual_running_expenses: float = 0.0
    driver_salary_annual: float = 0.0
    actual_reimbursement: float = 0.0
    employee_recovery: float = 0.0
    # Transfer of a used car to the employee
    transferred_to_employee: bool = False
    completed_years: int = 0
    amount_paid_on_transfer: float = 0.0


class SalaryIncome(BaseModel):
    enabled: bool = False
    annual_ctc: float = 0.0

    # Basic + DA. The workbook keeps Basic + DA at 50% of CTC (Labour Code
    # 2025); basic_percent_of_ctc drives Basic, and DA takes the remainder.
    basic_percent_of_ctc: float = 30.0
    da_percent_of_ctc: float = 20.0

    # Employer contributions
    gratuity_applicable: bool = False
    employer_nps: bool = False
    employer_pf: bool = False

    # HRA (the exemption itself is computed in Step 2)
    hra: SalaryComponent = SalaryComponent()
    rent_paid_annual: float = 0.0

    # Allowances and reimbursements
    conveyance_allowance: SalaryComponent = SalaryComponent()
    food_coupons: SalaryComponent = SalaryComponent()
    children_education_allowance: SalaryComponent = SalaryComponent()
    children_hostel_allowance: SalaryComponent = SalaryComponent()
    uniform_allowance: SalaryComponent = SalaryComponent()
    telephone_internet: SalaryComponent = SalaryComponent()
    employer_medical_premium: SalaryComponent = SalaryComponent()
    professional_course: SalaryComponent = SalaryComponent()
    health_club: SalaryComponent = SalaryComponent()
    gift_vouchers: SalaryComponent = SalaryComponent()
    leave_travel_concession: SalaryComponent = SalaryComponent()

    motor_car: MotorCarPerquisite = MotorCarPerquisite()

    # Fallback for users who know their figures but not their CTC breakdown
    use_simple_mode: bool = False
    gross_salary_simple: float = 0.0

    tds_deducted: float = 0.0


# ---------------------------------------------------------------------------
# 2. House property
# ---------------------------------------------------------------------------

class HouseProperty(BaseModel):
    label: Optional[str] = "Property"
    property_type: Literal["self_occupied", "let_out", "deemed_let_out"] = "self_occupied"
    annual_rent_received: float = 0.0
    municipal_taxes_paid: float = 0.0
    housing_loan_interest: float = 0.0
    tds_deducted: float = 0.0


class HousePropertyIncome(BaseModel):
    enabled: bool = False
    properties: List[HouseProperty] = []


# ---------------------------------------------------------------------------
# 3. PGBP — business / profession
# ---------------------------------------------------------------------------

class PresumptiveBusiness(BaseModel):
    enabled: bool = False
    scheme: Literal["44AD", "44ADA"] = "44AD"
    gross_turnover: float = 0.0
    cash_receipts: float = 0.0          # drives the 6% vs 8% split under 44AD
    digital_receipts: float = 0.0
    # Optional: declare a higher profit than the deemed percentage
    declared_profit_override: Optional[float] = None


class RegularBusiness(BaseModel):
    enabled: bool = False
    gross_receipts: float = 0.0
    total_expenses: float = 0.0
    depreciation: float = 0.0
    net_profit_override: Optional[float] = None


class PGBPIncome(BaseModel):
    enabled: bool = False
    presumptive: PresumptiveBusiness = PresumptiveBusiness()
    regular: RegularBusiness = RegularBusiness()
    tds_deducted: float = 0.0


# ---------------------------------------------------------------------------
# 4. Capital gains
#
# 111A and 112A are modelled separately from other assets because they carry
# their own special rates, their own exemption, and are excluded from both the
# rebate and Chapter VI-A deductions.
# ---------------------------------------------------------------------------

class CapitalGainsIncome(BaseModel):
    enabled: bool = False

    # Listed equity / equity mutual funds, STT paid
    stcg_111a: float = 0.0              # taxed at the 111A rate
    ltcg_112a: float = 0.0              # taxed at 112A rate above the exemption

    # Everything else
    stcg_other: float = 0.0             # taxed at slab rates
    ltcg_other: float = 0.0             # taxed at the 112 rate

    # Carried-forward losses to set off
    brought_forward_stcl: float = 0.0
    brought_forward_ltcl: float = 0.0

    tds_deducted: float = 0.0


# ---------------------------------------------------------------------------
# 5. Other sources
# ---------------------------------------------------------------------------

class OtherSourcesIncome(BaseModel):
    enabled: bool = False
    savings_interest: float = 0.0       # eligible for 80TTA / 80TTB
    fd_interest: float = 0.0
    other_interest: float = 0.0
    dividend_income: float = 0.0
    winnings: float = 0.0               # taxed at a flat special rate
    family_pension: float = 0.0
    other_income: float = 0.0
    tds_deducted: float = 0.0


# ---------------------------------------------------------------------------
# 6. Deductions (Step 3 detail; declared here so the shape is stable)
# ---------------------------------------------------------------------------

class DeductionEntry(BaseModel):
    key: str                            # matches a key in tax_config.DEDUCTIONS
    amount: float = 0.0
    is_senior_citizen_claim: bool = False
    is_severe_disability: bool = False


class DeductionsInput(BaseModel):
    entries: List[DeductionEntry] = []
    # Convenience mirrors of the most common ones
    employee_pf_contribution: float = 0.0
    home_loan_principal: float = 0.0


# ---------------------------------------------------------------------------
# The full submission
# ---------------------------------------------------------------------------

class TaxProfileInput(BaseModel):
    taxpayer: TaxpayerProfile = TaxpayerProfile()
    salary: SalaryIncome = SalaryIncome()
    house_property: HousePropertyIncome = HousePropertyIncome()
    pgbp: PGBPIncome = PGBPIncome()
    capital_gains: CapitalGainsIncome = CapitalGainsIncome()
    other_sources: OtherSourcesIncome = OtherSourcesIncome()
    deductions: DeductionsInput = DeductionsInput()
    advance_tax_paid: float = 0.0
    self_assessment_tax_paid: float = 0.0


# ---------------------------------------------------------------------------
# Responses
# ---------------------------------------------------------------------------

class LineItem(BaseModel):
    """One row in a computation breakdown, with its statutory basis."""
    label: str
    amount: float
    section: Optional[str] = None
    note: Optional[str] = None


class HRALimb(BaseModel):
    """One of the three competing limits in the HRA exemption test."""
    key: str
    label: str
    amount: float
    formula: str
    is_binding: bool = False       # True for the limb that turned out lowest


class HRAExemptionDetail(BaseModel):
    """
    Worked HRA exemption.

    Exempt is the LOWEST of three limbs; `binding_limb` names which one
    actually bit, which is what makes the result explainable rather than a
    bare number. Old regime only — `exempt_amount` is reported here and
    applied by the regime engine, never silently netted off.
    """
    applicable: bool = False
    exempt_amount: float = 0.0
    taxable_hra: float = 0.0
    limbs: List[HRALimb] = []
    binding_limb: Optional[str] = None
    basic_da: float = 0.0
    rent_paid: float = 0.0
    is_metro: bool = False
    metro_percent_applied: float = 0.0
    allowed_in_new_regime: bool = False
    notes: List[str] = []


class HeadSummary(BaseModel):
    """Aggregated result for a single head of income."""
    head: str
    label: str
    gross: float = 0.0
    exempt: float = 0.0
    deductions: float = 0.0
    net: float = 0.0
    tds: float = 0.0
    line_items: List[LineItem] = []
    warnings: List[str] = []
    # Salary head only; None elsewhere. `net` above stays regime-neutral (HRA
    # fully taxable); the regime engine subtracts this under the old regime.
    hra_exemption: Optional[HRAExemptionDetail] = None
    # Salary exemptions split by regime. Allowances like conveyance, meal
    # coupons and children's allowances are withdrawn under the new regime, so
    # `net` (which nets off both) is the OLD-regime figure; the engine adds
    # `exempt_old_regime_only` back when computing under the new regime.
    exempt_both_regimes: float = 0.0
    exempt_old_regime_only: float = 0.0


class DeductionResult(BaseModel):
    """One deduction, showing what was claimed against what actually qualifies."""
    key: str
    section: str
    label: str
    short_label: str
    claimed: float = 0.0
    qualifying: float = 0.0          # after the statutory ceiling
    # Employer NPS is deductible under both regimes but at different rates
    # (10% of salary old, 14% new), so the qualifying amount is regime-specific.
    # For every other deduction these both equal `qualifying`.
    qualifying_old: float = 0.0
    qualifying_new: float = 0.0
    limit: Optional[float] = None    # the ceiling that applied, if any
    limit_reason: Optional[str] = None
    regimes: List[str] = []
    is_capped: bool = False
    headroom: float = 0.0            # unused allowance, drives Step 5 advice
    notes: List[str] = []


class DeductionsSummary(BaseModel):
    """
    Chapter VI-A / Schedule XV totals.

    Computed per regime because almost every deduction is old-regime only —
    the employer NPS contribution is the notable exception that survives in
    both.
    """
    entries: List[DeductionResult] = []
    total_old_regime: float = 0.0
    total_new_regime: float = 0.0
    total_claimed: float = 0.0
    restricted_to_gti: bool = False
    warnings: List[str] = []


class TDSEntry(BaseModel):
    head: str
    label: str
    amount: float = 0.0


class TDSSummary(BaseModel):
    """
    Tax already paid, netted against the final liability in Step 4.

    Mirrors what a taxpayer reconciles from Form 26AS / AIS: TDS by head,
    plus advance tax and self-assessment tax paid directly.
    """
    by_head: List[TDSEntry] = []
    total_tds: float = 0.0
    advance_tax: float = 0.0
    self_assessment_tax: float = 0.0
    total_prepaid: float = 0.0
    notes: List[str] = []


class SlabBand(BaseModel):
    """One slab band and the tax it contributed."""
    from_amount: float
    to_amount: Optional[float] = None    # None = "and above"
    rate: float
    taxable_in_band: float = 0.0
    tax: float = 0.0


class SpecialRateItem(BaseModel):
    """Income taxed at its own statutory rate rather than at slab rates."""
    key: str
    label: str
    section: Optional[str] = None
    gross: float = 0.0
    exemption_applied: float = 0.0
    basic_exemption_setoff: float = 0.0
    taxable: float = 0.0
    rate: float = 0.0
    tax: float = 0.0


class RegimeComputation(BaseModel):
    """
    A full tax computation under one regime, kept step by step so every figure
    on screen can be traced to the one above it.
    """
    regime: str
    label: str

    # Income build-up
    salary_net: float = 0.0
    house_property_net: float = 0.0
    pgbp_net: float = 0.0
    other_sources_net: float = 0.0
    capital_gains_net: float = 0.0
    gross_total_income: float = 0.0

    # Salary reliefs applied under this regime
    hra_exemption: float = 0.0
    allowances_exempt: float = 0.0
    standard_deduction: float = 0.0
    professional_tax: float = 0.0

    chapter_via_deductions: float = 0.0
    total_income: float = 0.0

    # Rate split
    normal_income: float = 0.0
    special_rate_items: List[SpecialRateItem] = []
    slab_bands: List[SlabBand] = []

    tax_on_normal_income: float = 0.0
    tax_on_special_income: float = 0.0
    tax_before_rebate: float = 0.0

    rebate: float = 0.0
    rebate_section: Optional[str] = None
    rebate_marginal_relief: float = 0.0
    tax_after_rebate: float = 0.0

    surcharge_rate: float = 0.0
    surcharge_before_relief: float = 0.0
    surcharge_marginal_relief: float = 0.0
    surcharge: float = 0.0

    cess_rate: float = 0.0
    cess: float = 0.0

    total_tax_liability: float = 0.0
    prepaid_tax: float = 0.0
    net_payable: float = 0.0        # positive = pay, negative = refund
    is_refund: bool = False

    effective_rate: float = 0.0     # total liability / gross total income
    notes: List[str] = []


class RegimeComparison(BaseModel):
    """Old vs new, side by side, with the reason one wins."""
    old: RegimeComputation
    new: RegimeComputation
    recommended_regime: str = "new"
    saving: float = 0.0
    # Extra old-regime deductions needed to draw level, when new regime wins.
    # None when the old regime already wins, or when no amount of deduction
    # could close the gap.
    breakeven_extra_deductions: Optional[float] = None
    default_regime: str = "new"
    summary: str = ""


class Recommendation(BaseModel):
    """
    One rule-based suggestion.

    Every item is derived from the computed figures — no model is involved.
    `estimated_saving` drives the ordering, so the advice worth the most money
    appears first.
    """
    key: str
    category: str            # regime | deduction | hra | capital_gains | compliance | structure
    priority: str            # high | medium | low
    title: str
    detail: str
    estimated_saving: Optional[float] = None
    action: Optional[str] = None
    section: Optional[str] = None


class ITRRuledOut(BaseModel):
    form: str
    reason: str


class ITRFormRecommendation(BaseModel):
    """Which return form the entered income points to, and why."""
    form: str
    name: str
    description: str
    reasons: List[str] = []
    ruled_out: List[ITRRuledOut] = []
    warnings: List[str] = []


class IncomeCollectionResponse(BaseModel):
    """Step 1 output — every head aggregated, before any tax computation."""
    tax_year: str
    tax_year_label: str
    governing_act: str
    heads: List[HeadSummary] = []
    gross_total_income: float = 0.0
    total_tds: float = 0.0
    # Heads that are present — drives ITR form selection in Step 6
    active_heads: List[str] = []
    warnings: List[str] = []
    disclaimer: str = ""
    deductions: Optional[DeductionsSummary] = None
    tds: Optional[TDSSummary] = None
    comparison: Optional[RegimeComparison] = None
    recommendations: List[Recommendation] = []
    itr_form: Optional[ITRFormRecommendation] = None
