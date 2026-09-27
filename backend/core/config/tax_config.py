"""
Tax rate configuration for the Individual Tax Calculator.

EVERY statutory figure lives in this file. Nothing in the service or router
layer hardcodes a rate, threshold, or limit — Union Budgets change these
annually, and the point of this module is that updating a year means editing
this file and nothing else.

--------------------------------------------------------------------------
WHICH ACT APPLIES
--------------------------------------------------------------------------
The Income-tax Act, 2025 came into force on 1 April 2026, replacing the
Income-tax Act, 1961. Practically:

    FY 2025-26 (AY 2026-27)  -> filed under the 1961 Act  (80C, 80D, 87A ...)
    FY 2026-27 (AY 2027-28)  -> filed under the 2025 Act  (S.123, S.126, S.156 ...)

The Finance Act, 2026 RETAINED the slab rates, surcharge bands, cess, rebate
and standard deduction unchanged from the previous year. So the two years
below carry identical numbers and differ only in section labelling.

Each deduction carries both its 2025-Act section and its familiar 1961-Act
section so the UI can show "S.123 (80C)" and remain recognisable to users.

--------------------------------------------------------------------------
SOURCES (verified 2026-08)
--------------------------------------------------------------------------
  * Slabs / surcharge / cess / rebate ......... cleartax.in/c/income-tax-slab-rates
                                               taxguru.in (AY 2026-27 & AY 2027-28 rates)
  * ITA 2025 commencement .................... pib.gov.in PRID 2248005
  * 80C -> S.123 renumbering ................. businesstoday.in (24 Mar 2026)
  * S.111A / S.112A capital gains ............ cleartax.in/s/long-term-capital-gains-on-shares

--------------------------------------------------------------------------
A NOTE ON THE REFERENCE SPREADSHEET
--------------------------------------------------------------------------
The CTC Structuring & Tax Planning Tool this feature was modelled on applies
a few allowance limits that are more generous than the statutory exemption
(children education, hostel, gift vouchers). This config uses the STATUTORY
figures. The spreadsheet's values are preserved beside them as
`_SPREADSHEET_OVERRIDE` entries, documented, inactive, and easy to switch to
if the firm's position is deliberate. See SALARY_EXEMPTIONS below.
"""

from typing import Any, Dict

# ---------------------------------------------------------------------------
# Year selection
# ---------------------------------------------------------------------------

DEFAULT_TAX_YEAR = "FY2026-27"

TAX_YEAR_LABELS = {
    "FY2026-27": {
        "fy": "FY 2026-27",
        "ay": "AY 2027-28",
        "act": "Income-tax Act, 2025",
        "section_scheme": "2025",   # UI shows S.123 (80C)
    },
    "FY2025-26": {
        "fy": "FY 2025-26",
        "ay": "AY 2026-27",
        "act": "Income-tax Act, 1961",
        "section_scheme": "1961",   # UI shows 80C
    },
}


# ---------------------------------------------------------------------------
# Slab rates
#
# Slabs are half-open bands: `upto=None` means "and above".
# Old regime is age-banded (the basic exemption rises for senior citizens);
# the new regime has a single set of slabs regardless of age.
# ---------------------------------------------------------------------------

_NEW_REGIME_SLABS = [
    {"upto": 400000, "rate": 0.00},
    {"upto": 800000, "rate": 0.05},
    {"upto": 1200000, "rate": 0.10},
    {"upto": 1600000, "rate": 0.15},
    {"upto": 2000000, "rate": 0.20},
    {"upto": 2400000, "rate": 0.25},
    {"upto": None, "rate": 0.30},
]

# Age bands for the old regime. `below_60` / `senior` (60-79) / `super_senior` (80+).
_OLD_REGIME_SLABS = {
    "below_60": [
        {"upto": 250000, "rate": 0.00},
        {"upto": 500000, "rate": 0.05},
        {"upto": 1000000, "rate": 0.20},
        {"upto": None, "rate": 0.30},
    ],
    "senior": [
        {"upto": 300000, "rate": 0.00},
        {"upto": 500000, "rate": 0.05},
        {"upto": 1000000, "rate": 0.20},
        {"upto": None, "rate": 0.30},
    ],
    "super_senior": [
        {"upto": 500000, "rate": 0.00},
        {"upto": 1000000, "rate": 0.20},
        {"upto": None, "rate": 0.30},
    ],
}


# ---------------------------------------------------------------------------
# Surcharge
#
# Applied on the tax amount (before cess) once TOTAL INCOME crosses a band.
# The new regime caps surcharge at 25% — the 37% band does not apply to it.
#
# `capital_gains_cap` limits the surcharge rate applied to the portion of tax
# arising from S.111A / S.112A gains, which the statute caps at 15% under both
# regimes. The reference spreadsheet does not implement this.
# ---------------------------------------------------------------------------

_SURCHARGE_OLD = [
    {"above": 5000000, "rate": 0.10},
    {"above": 10000000, "rate": 0.15},
    {"above": 20000000, "rate": 0.25},
    {"above": 50000000, "rate": 0.37},
]

_SURCHARGE_NEW = [
    {"above": 5000000, "rate": 0.10},
    {"above": 10000000, "rate": 0.15},
    {"above": 20000000, "rate": 0.25},
    # No 37% band — the new regime caps at 25%.
]

SURCHARGE_CAPITAL_GAINS_CAP = 0.15


# ---------------------------------------------------------------------------
# Rebate  (S.156 under ITA 2025 / S.87A under ITA 1961)
#
# Old regime: flat rebate, no marginal relief.
# New regime: rebate PLUS marginal relief — where income marginally exceeds the
#   threshold, tax is capped at the excess over the threshold, so crossing
#   ₹12,00,000 by ₹1 does not create a ₹60,000 liability.
#
# Neither rebate is available against income taxed at the special S.111A /
# S.112A rates.
# ---------------------------------------------------------------------------

_REBATE_OLD = {
    "section_2025": "S.156",
    "section_1961": "87A",
    "income_threshold": 500000,
    "max_rebate": 12500,
    "marginal_relief": False,
}

_REBATE_NEW = {
    "section_2025": "S.156",
    "section_1961": "87A",
    "income_threshold": 1200000,
    "max_rebate": 60000,
    "marginal_relief": True,
}


# ---------------------------------------------------------------------------
# Cess — Health & Education Cess, on (tax + surcharge), both regimes.
# ---------------------------------------------------------------------------

CESS_RATE = 0.04
CESS_LABEL = "Health & Education Cess"


# ---------------------------------------------------------------------------
# Salary deductions  (S.19 under ITA 2025 / S.16 under ITA 1961)
# ---------------------------------------------------------------------------

_SALARY_DEDUCTIONS = {
    "standard_deduction": {
        "section_2025": "S.19",
        "section_1961": "16(ia)",
        "old_regime": 50000,
        "new_regime": 75000,
    },
    "professional_tax": {
        "section_2025": "S.19",
        "section_1961": "16(iii)",
        "old_regime": 2400,      # statutory ceiling; actual varies by state
        "new_regime": 0,         # not allowed under the new regime
    },
}


# ---------------------------------------------------------------------------
# HRA exemption
#
# Exempt amount is the LOWEST of:
#   (a) actual HRA received
#   (b) rent paid  -  10% of (Basic + DA)
#   (c) 50% of (Basic + DA) in a metro, else 40%
#
# Old regime only. Matches the workbook's "HRA Calculation" sheet exactly.
# ---------------------------------------------------------------------------

HRA_RULES = {
    "section_2025": "S.19 r/w Schedule III",
    "section_1961": "10(13A)",
    "rent_less_percent_of_salary": 0.10,
    "metro_percent": 0.50,
    "non_metro_percent": 0.40,
    "metro_cities": [
        "Mumbai", "Delhi", "Kolkata", "Chennai",
        # The workbook also treats these as metro for HRA. The 1961-Act
        # position recognises only the four above; this wider list follows
        # the reference tool. Flagged for review.
        "Hyderabad", "Pune", "Ahmedabad", "Bengaluru",
    ],
    "metro_cities_strict": ["Mumbai", "Delhi", "Kolkata", "Chennai"],
    "landlord_pan_required_above": 100000,
    "allowed_in_new_regime": False,
}


# ---------------------------------------------------------------------------
# Salary component exemption limits
#
# STATUTORY figures are active. Where the reference spreadsheet is more
# generous, its value sits alongside as `_SPREADSHEET_OVERRIDE` — inactive,
# documented, switchable.
# ---------------------------------------------------------------------------

SALARY_EXEMPTIONS = {
    "children_education_allowance": {
        "label": "Children Education Allowance",
        "per_month_per_child": 100,          # statutory
        "max_children": 2,
        "_SPREADSHEET_OVERRIDE": 3000,       # workbook uses ₹3,000/month/child
        "allowed_in_new_regime": False,
    },
    "children_hostel_allowance": {
        "label": "Children Hostel Allowance",
        "per_month_per_child": 300,          # statutory
        "max_children": 2,
        "_SPREADSHEET_OVERRIDE": 9000,       # workbook uses ₹9,000/month/child
        "allowed_in_new_regime": False,
    },
    "gift_vouchers": {
        "label": "Gift Vouchers",
        "annual_limit": 5000,                # statutory
        "_SPREADSHEET_OVERRIDE": 14900,      # workbook caps at ₹14,900
        "allowed_in_new_regime": False,
    },
    "food_coupons": {
        "label": "Meal Coupons / Sodexo",
        "per_meal": 50,                      # statutory
        "_SPREADSHEET_OVERRIDE_PER_MEAL": 200,   # workbook uses ₹200/meal
        "meals_per_day": 2,
        "working_days": 240,
        "allowed_in_new_regime": False,
    },
    "conveyance_allowance": {
        "label": "Conveyance Allowance",
        "annual_limit": 19200,               # ₹1,600/month
        "allowed_in_new_regime": False,
    },
    "uniform_allowance": {
        "label": "Uniform Allowance",
        "annual_limit": None,                # actual expenditure, no statutory cap
        "allowed_in_new_regime": False,
    },
    "leave_travel_concession": {
        "label": "Leave Travel Concession",
        "journeys_per_block": 2,
        "block_years": "2026-2029",
        "annual_limit": None,                # actual travel fare only
        "allowed_in_new_regime": False,
    },
}


# ---------------------------------------------------------------------------
# Employer contributions
# ---------------------------------------------------------------------------

EMPLOYER_CONTRIBUTION_RULES = {
    "nps": {
        "label": "Employer contribution to NPS",
        "section_2025": "S.124",
        "section_1961": "80CCD(2)",
        "old_regime_percent": 0.10,          # of Basic + DA
        "new_regime_percent": 0.14,
        "combined_cap": 750000,              # NPS + PF + superannuation
    },
    "provident_fund": {
        "label": "Employer contribution to Recognised PF",
        "exempt_percent": 0.12,              # of Basic + DA; excess is taxable
        "combined_cap": 750000,
    },
    "gratuity": {
        "label": "Gratuity",
        "accrual_percent": 0.0481,           # 4.81% of Basic + DA (workbook basis)
        "exemption_cap": 2000000,
    },
}

# The Labour Codes expect Basic + DA to be at least half of CTC. Not a tax
# figure, but the CTC structuring advice is built on it, so it belongs here
# rather than in the form that shows the warning.
LABOUR_CODE_BASIC_DA_FLOOR = 0.50


# ---------------------------------------------------------------------------
# Motor car perquisite — Rule 15, Table II (ITA 2025) / Rule 3(2) (ITA 1961)
# Mirrors the workbook's hidden "Motor Car Perquisite" sheet.
# Values are PER MONTH.
# ---------------------------------------------------------------------------

# The engine-size boundary the two rate tables turn on, in litres.
MOTOR_CAR_SMALL_ENGINE_LITRES = 1.6

MOTOR_CAR_PERQUISITE = {
    "small_engine": {
        "label": "Engine <= 1.6 litre, or Electric Vehicle",
        "employer_bears_expenses": 1800,     # statutory
        "employee_bears_expenses": 600,
        "_SPREADSHEET_OVERRIDE_EMPLOYER": 5000,
        "_SPREADSHEET_OVERRIDE_EMPLOYEE": 2000,
    },
    "large_engine": {
        "label": "Engine > 1.6 litre",
        "employer_bears_expenses": 2400,     # statutory
        "employee_bears_expenses": 900,
        "_SPREADSHEET_OVERRIDE_EMPLOYER": 7000,
        "_SPREADSHEET_OVERRIDE_EMPLOYEE": 3000,
    },
    "chauffeur_per_month": 900,              # statutory
    "_SPREADSHEET_OVERRIDE_CHAUFFEUR": 3000,
    # Official use only => nil perquisite, subject to logbook + employer
    # certificate. Transfer of a used car to the employee is valued at cost
    # depreciated 20% per completed year on WDV, less amount recovered.
    "transfer_depreciation_per_year": 0.20,
}


# ---------------------------------------------------------------------------
# House property
# ---------------------------------------------------------------------------

HOUSE_PROPERTY_RULES = {
    "standard_deduction_percent": 0.30,      # of Net Annual Value
    "self_occupied_interest_cap": {
        "section_2025": "S.22(1)(b)",
        "section_1961": "24(b)",
        "cap": 200000,
        "allowed_in_new_regime": False,
    },
    "let_out_interest_cap": None,            # no cap on let-out interest
    "max_self_occupied_properties": 2,
    "set_off_cap_against_other_heads": 200000,
}


# ---------------------------------------------------------------------------
# Capital gains
#
# The reference spreadsheet has no capital gains handling; these come from
# statute. Two nuances matter and are enforced by the engine:
#   * the S.156 / 87A rebate is NOT available against 111A / 112A income
#   * surcharge on 111A / 112A tax is capped at 15% (SURCHARGE_CAPITAL_GAINS_CAP)
# ---------------------------------------------------------------------------

CAPITAL_GAINS_RULES = {
    "stcg_111a": {
        "label": "STCG on listed equity / equity MF (STT paid)",
        "section_2025": "S.196",
        "section_1961": "111A",
        "rate": 0.20,
        "annual_exemption": 0,               # no exemption for 111A
        "rebate_available": False,
        "chapter_via_deduction_allowed": False,
    },
    "ltcg_112a": {
        "label": "LTCG on listed equity / equity MF (STT paid)",
        "section_2025": "S.197",
        "section_1961": "112A",
        "rate": 0.125,
        "annual_exemption": 125000,
        "rebate_available": False,
        "chapter_via_deduction_allowed": False,
        "indexation_available": False,
    },
    "stcg_other": {
        "label": "STCG: other assets",
        "rate": None,                        # taxed at slab rates
        "taxed_at_slab": True,
    },
    "ltcg_other": {
        "label": "LTCG: other assets",
        "section_1961": "112",
        "rate": 0.125,
        "annual_exemption": 0,
        "indexation_available": False,       # withdrawn for transfers post 23-Jul-2024
    },
    "loss_set_off": {
        "carry_forward_years": 8,
        # A short-term loss may absorb either kind of gain; a long-term loss
        # may only absorb a long-term gain.
        "stcl_sets_off": ["short_term", "long_term"],
        "ltcl_sets_off": ["long_term"],
    },
}


# ---------------------------------------------------------------------------
# Presumptive taxation
# ---------------------------------------------------------------------------

PRESUMPTIVE_TAXATION = {
    "44AD": {
        "label": "Business: presumptive (S.44AD)",
        "section_2025": "S.58",
        "section_1961": "44AD",
        "turnover_limit": 30000000,          # ₹3 cr where cash receipts <= 5%
        "turnover_limit_standard": 10000000, # ₹1 cr otherwise
        "cash_receipts_threshold": 0.05,
        "deemed_profit_percent_cash": 0.08,
        "deemed_profit_percent_digital": 0.06,
    },
    "44ADA": {
        "label": "Profession: presumptive (S.44ADA)",
        "section_2025": "S.58",
        "section_1961": "44ADA",
        "turnover_limit": 7500000,           # ₹75 L where cash receipts <= 5%
        "turnover_limit_standard": 5000000,  # ₹50 L otherwise
        "cash_receipts_threshold": 0.05,
        "deemed_profit_percent": 0.50,
    },
}


# ---------------------------------------------------------------------------
# Chapter VI-A deductions  (Part C / Schedule XV under ITA 2025)
#
# `regimes` lists which regime each deduction survives in. Almost all are
# old-regime-only; the employer NPS contribution is the notable exception.
# ---------------------------------------------------------------------------

DEDUCTIONS = {
    "80C": {
        "section_2025": "S.123",
        "section_1961": "80C",
        "label": "Life insurance, ELSS, PPF, EPF, NSC, tuition fees, home loan principal",
        "short_label": "Investments & savings",
        "limit": 150000,
        "regimes": ["old"],
        "schedule": "Schedule XV",
    },
    "80CCD_1B": {
        "section_2025": "S.124(2)",
        "section_1961": "80CCD(1B)",
        "label": "Additional NPS contribution by employee",
        "short_label": "NPS (additional)",
        "limit": 50000,
        "regimes": ["old"],
    },
    "80CCD_2": {
        "section_2025": "S.124(3)",
        "section_1961": "80CCD(2)",
        "label": "Employer contribution to NPS",
        "short_label": "Employer NPS",
        "limit": None,                       # % of salary; see EMPLOYER_CONTRIBUTION_RULES
        "regimes": ["old", "new"],           # allowed under BOTH regimes
    },
    "80D_self": {
        "section_2025": "S.126",
        "section_1961": "80D",
        "label": "Medical insurance: self, spouse, dependent children",
        "short_label": "Health insurance (self)",
        "limit": 25000,
        "limit_senior": 50000,
        "regimes": ["old"],
    },
    "80D_parents": {
        "section_2025": "S.126",
        "section_1961": "80D",
        "label": "Medical insurance: parents",
        "short_label": "Health insurance (parents)",
        "limit": 25000,
        "limit_senior": 50000,
        "regimes": ["old"],
    },
    "80DD": {
        "section_2025": "S.127",
        "section_1961": "80DD",
        "label": "Maintenance / medical treatment of a dependant with disability",
        "short_label": "Dependant with disability",
        "limit": 75000,
        "limit_severe": 125000,
        "regimes": ["old"],
    },
    "80DDB": {
        "section_2025": "S.128",
        "section_1961": "80DDB",
        "label": "Medical treatment of specified diseases",
        "short_label": "Specified disease treatment",
        "limit": 40000,
        "limit_senior": 100000,
        "regimes": ["old"],
    },
    "80E": {
        "section_2025": "S.130",
        "section_1961": "80E",
        "label": "Interest on education loan",
        "short_label": "Education loan interest",
        "limit": None,                       # no cap; 8 assessment years
        "max_years": 8,
        "regimes": ["old"],
    },
    "80EEA": {
        "section_2025": "S.131",
        "section_1961": "80EEA",
        "label": "Additional interest on affordable housing loan",
        "short_label": "Affordable housing interest",
        "limit": 150000,
        "regimes": ["old"],
    },
    "80G": {
        "section_2025": "S.133",
        "section_1961": "80G",
        "label": "Donations to approved funds and charities",
        "short_label": "Donations",
        "limit": None,                       # 50% / 100%, some qualifying-limit capped
        "regimes": ["old"],
    },
    "80GG": {
        "section_2025": "S.134",
        "section_1961": "80GG",
        "label": "Rent paid where no HRA is received",
        "short_label": "Rent paid (no HRA)",
        "limit": 60000,
        "regimes": ["old"],
    },
    "80TTA": {
        "section_2025": "S.153",
        "section_1961": "80TTA",
        "label": "Interest on savings bank account",
        "short_label": "Savings interest",
        "limit": 10000,
        "regimes": ["old"],
    },
    "80TTB": {
        "section_2025": "S.153",
        "section_1961": "80TTB",
        "label": "Interest income: senior citizens",
        "short_label": "Interest (senior citizen)",
        "limit": 50000,
        "regimes": ["old"],
        "requires_age": "senior",
    },
    "80U": {
        "section_2025": "S.154",
        "section_1961": "80U",
        "label": "Self with disability",
        "short_label": "Self with disability",
        "limit": 75000,
        "limit_severe": 125000,
        "regimes": ["old"],
    },
}


# ---------------------------------------------------------------------------
# ITR form selection rules
#
# Evaluated top-down; the FIRST rule whose conditions all hold wins, so order
# matters — the most restrictive forms are listed last so they override.
# `disqualifiers` force a move to a richer form.
# ---------------------------------------------------------------------------

ITR_FORMS = {
    "ITR-1": {
        "name": "ITR-1 (Sahaj)",
        "eligible_when": {
            "total_income_upto": 5000000,
            "heads_allowed": ["salary", "house_property_single", "other_sources"],
            "ltcg_112a_upto": 125000,        # small LTCG is now permitted in ITR-1
        },
        "disqualifiers": [
            "business_income",
            "capital_gains_other_than_small_112a",
            "more_than_one_house_property",
            "foreign_income",
            "foreign_assets",
            "is_director",
            "unlisted_shares",
            "agricultural_income_above_5000",
        ],
        "description": "Resident individual with salary, one house property and other sources.",
    },
    "ITR-2": {
        "name": "ITR-2",
        "eligible_when": {
            "heads_allowed": [
                "salary", "house_property_multiple", "capital_gains", "other_sources",
            ],
        },
        "disqualifiers": ["business_income"],
        "description": "Individual with capital gains, multiple house properties or foreign assets, but no business income.",
    },
    "ITR-3": {
        "name": "ITR-3",
        "eligible_when": {
            "heads_allowed": [
                "salary", "house_property_multiple", "capital_gains",
                "business_income", "other_sources",
            ],
        },
        "disqualifiers": [],
        "description": "Individual with income from business or profession under normal provisions.",
    },
    "ITR-4": {
        "name": "ITR-4 (Sugam)",
        "eligible_when": {
            "total_income_upto": 5000000,
            "presumptive_only": True,
            "heads_allowed": [
                "salary", "house_property_single", "business_presumptive", "other_sources",
            ],
            "ltcg_112a_upto": 125000,
        },
        "disqualifiers": [
            "capital_gains_other_than_small_112a",
            "more_than_one_house_property",
            "foreign_income",
            "foreign_assets",
            "is_director",
            "unlisted_shares",
        ],
        "description": "Presumptive business or professional income under S.44AD / S.44ADA / S.44AE.",
    },
}

ITR_EVALUATION_ORDER = ["ITR-1", "ITR-4", "ITR-2", "ITR-3"]


# ---------------------------------------------------------------------------
# Age band boundaries
# ---------------------------------------------------------------------------

AGE_BANDS = {
    "below_60": {"label": "Below 60", "min": 0, "max": 59},
    "senior": {"label": "60 to 79 (Senior Citizen)", "min": 60, "max": 79},
    "super_senior": {"label": "80 and above (Super Senior)", "min": 80, "max": 200},
}


# ---------------------------------------------------------------------------
# Assembled per-year configuration
# ---------------------------------------------------------------------------

TAX_YEARS: Dict[str, Dict[str, Any]] = {
    "FY2026-27": {
        "labels": TAX_YEAR_LABELS["FY2026-27"],
        "regimes": {
            "old": {
                "label": "Old Regime",
                "slabs_by_age": _OLD_REGIME_SLABS,
                "surcharge": _SURCHARGE_OLD,
                "rebate": _REBATE_OLD,
                "standard_deduction": _SALARY_DEDUCTIONS["standard_deduction"]["old_regime"],
                "professional_tax": _SALARY_DEDUCTIONS["professional_tax"]["old_regime"],
                "allows_chapter_via": True,
                "allows_hra": True,
            },
            "new": {
                "label": "New Regime",
                "slabs_by_age": {k: _NEW_REGIME_SLABS for k in _OLD_REGIME_SLABS},
                "surcharge": _SURCHARGE_NEW,
                "rebate": _REBATE_NEW,
                "standard_deduction": _SALARY_DEDUCTIONS["standard_deduction"]["new_regime"],
                "professional_tax": _SALARY_DEDUCTIONS["professional_tax"]["new_regime"],
                "allows_chapter_via": False,
                "allows_hra": False,
                "is_default_regime": True,
            },
        },
        "cess_rate": CESS_RATE,
    },
}

# FY 2025-26 carries identical numbers — the Finance Act 2026 made no changes
# to slabs, surcharge, cess, rebate or standard deduction. Only the governing
# Act and section labelling differ.
TAX_YEARS["FY2025-26"] = {
    **TAX_YEARS["FY2026-27"],
    "labels": TAX_YEAR_LABELS["FY2025-26"],
}


# ---------------------------------------------------------------------------
# Accessors — the service layer goes through these, never at the dicts directly
# ---------------------------------------------------------------------------

def get_year_config(tax_year: str = None) -> Dict[str, Any]:
    """Full configuration for a tax year. Falls back to the default year."""
    return TAX_YEARS.get(tax_year or DEFAULT_TAX_YEAR, TAX_YEARS[DEFAULT_TAX_YEAR])


def get_regime_config(regime: str, tax_year: str = None) -> Dict[str, Any]:
    """Configuration for one regime ('old' | 'new') within a tax year."""
    year = get_year_config(tax_year)
    if regime not in year["regimes"]:
        raise ValueError(f"Unknown regime {regime!r}; expected 'old' or 'new'.")
    return year["regimes"][regime]


def get_slabs(regime: str, age_band: str = "below_60", tax_year: str = None):
    """Slab list for a regime + age band."""
    cfg = get_regime_config(regime, tax_year)
    return cfg["slabs_by_age"].get(age_band, cfg["slabs_by_age"]["below_60"])


def section_label(deduction_key: str, tax_year: str = None) -> str:
    """
    Render a deduction's section label for the UI.

    Under the 2025 Act this returns "S.123 (80C)" so the new numbering is
    correct while remaining recognisable; under the 1961 Act it returns "80C".
    """
    d = DEDUCTIONS.get(deduction_key)
    if not d:
        return deduction_key
    scheme = get_year_config(tax_year)["labels"]["section_scheme"]
    if scheme == "2025":
        return f"{d['section_2025']} ({d['section_1961']})"
    return d["section_1961"]


def age_band_for(age: int) -> str:
    """Map an age in years to its slab band key."""
    for key, band in AGE_BANDS.items():
        if band["min"] <= age <= band["max"]:
            return key
    return "below_60"


def deductions_for_regime(regime: str):
    """Deduction keys available under a given regime."""
    return {k: v for k, v in DEDUCTIONS.items() if regime in v["regimes"]}


# ---------------------------------------------------------------------------
# Filing calendar and portals
#
# Due dates, portal addresses and the e-verification window are administrative
# facts that move with CBDT / CBIC notifications. They belong here beside the
# rates for the same reason: the UI that explains them must never hold a
# figure of its own.
# ---------------------------------------------------------------------------

ITR_FILING = {
    "portal_url": "https://www.incometax.gov.in",
    "portal_label": "incometax.gov.in",
    "everify_days": 30,
    "advance_tax_due_dates": ["15 June", "15 September", "15 December", "15 March"],
    "self_assessment_challan": "Challan 280 (minor head 300)",
}

# GST is deliberately absent. This calculator is scoped to the Individual
# persona and computes income tax only; GST is an indirect tax on a
# registered business, so walking an individual through GSTR filing would be
# guidance the rest of this feature cannot stand behind.


# ---------------------------------------------------------------------------
# Field guidance
#
# The help text shown against each input in the calculator. Keys are the
# dotted path of the field in TaxProfileInput, which is the contract the
# frontend already shares with this backend; the UI carries it as data-help.
#
# Every statutory figure appears as a {placeholder} resolved by
# guidance_values() from the dicts above, so this text cannot drift from the
# rates the engine actually applies. Never write a number in literally.
# ---------------------------------------------------------------------------

FIELD_GUIDANCE = {
    # -- taxpayer ----------------------------------------------------------
    "taxpayer.age":
        "Your age as on 31 March of the assessment year. Senior citizen "
        "({senior_age}+) and super-senior ({super_senior_age}+) status changes "
        "your slab rates and raises some deduction limits.",
    "taxpayer.city":
        "The city you live in. Used only for the HRA calculation, metro "
        "cities carry a higher exemption percentage.",
    "taxpayer.is_metro":
        "Tick if you live in {metro_cities}. Metro status raises the HRA "
        "exemption ceiling to {hra_metro_percent} of Basic + DA instead of "
        "{hra_non_metro_percent}.",

    # -- salary ------------------------------------------------------------
    "salary.enabled":
        "Tick if you drew a salary during the year, whether for the whole "
        "year or part of it.",
    "salary.use_simple_mode":
        "Simple mode takes the single gross salary figure from your Form 16 "
        "and skips the component breakdown. Switch it off to structure your "
        "CTC and claim allowance exemptions individually.",
    "salary.gross_salary_simple":
        "Total gross salary for the year as shown in Form 16 Part B, basic, "
        "HRA, allowances, bonus and every other taxable component.",
    "salary.annual_ctc":
        "Total annual Cost to Company from your offer letter or salary "
        "structure, including basic, HRA, allowances, PF, gratuity and bonus.",
    "salary.basic_percent_of_ctc":
        "Basic pay as a percentage of CTC. A higher basic raises PF and "
        "gratuity but shrinks the room for HRA and special allowance. The "
        "Labour Codes expect Basic + DA to reach at least "
        "{labour_code_basic_da_percent} of CTC.",
    "salary.da_percent_of_ctc":
        "Dearness Allowance as a percentage of CTC, commonly zero in private "
        "packages. DA joins Basic when computing HRA, PF and gratuity.",
    "salary.gratuity_applicable":
        "Tick if your CTC includes gratuity. It accrues at about "
        "{gratuity_accrual_percent} of Basic + DA and is exempt up to "
        "{gratuity_exemption_cap} on retirement or after five years of service.",
    "salary.employer_nps":
        "Tick if your employer contributes to the NPS under {nps_section}. "
        "The contribution is deductible up to {nps_new_regime_percent} of "
        "Basic + DA in the new regime and {nps_old_regime_percent} in the old "
        "- one of the few deductions that survives in both.",
    "salary.employer_pf":
        "Tick if your employer contributes to a recognised Provident Fund. "
        "The contribution is exempt up to {pf_exempt_percent} of Basic + DA; "
        "anything above that is taxable as salary.",
    "salary.tds_deducted":
        "Total TDS your employer deducted on salary during the year. Take it "
        "from Form 16 Part A and cross-check it against Form 26AS.",

    # -- HRA ---------------------------------------------------------------
    "salary.hra.enabled":
        "Tick if your salary structure includes House Rent Allowance. The HRA "
        "exemption is available in the old regime only.",
    "salary.hra.percent_of_basic_da":
        "HRA as a percentage of Basic + DA. The exemption is the lowest of "
        "three figures: HRA actually received, rent paid less "
        "{hra_rent_less_percent} of salary, and {hra_metro_percent} in a "
        "metro or {hra_non_metro_percent} elsewhere.",
    "salary.rent_paid_annual":
        "Total rent you paid over the year. Keep the receipts, and your "
        "landlord PAN if the annual rent crosses "
        "{hra_landlord_pan_threshold}.",

    # -- motor car perquisite ---------------------------------------------
    "salary.motor_car.enabled":
        "Tick if your employer provides a car or reimburses car expenses. The "
        "perquisite value turns on who owns the car, who pays to run it, the "
        "engine size and whether a driver comes with it.",
    "salary.motor_car.car_owner":
        "Who owns the car, the employer or you. The valuation rules differ.",
    "salary.motor_car.expense_bearer":
        "Who bears the running and maintenance cost. Employer-borne expenses "
        "carry the higher perquisite rate.",
    "salary.motor_car.usage":
        "How the car is used. Purely official use adds no perquisite, but it "
        "needs a logbook and an employer certificate to stand.",
    "salary.motor_car.engine_type":
        "Small covers engines up to {motor_car_small_engine_litres} litres and "
        "all electric vehicles; large covers anything above. The two carry "
        "different prescribed monthly rates.",
    "salary.motor_car.months_available":
        "Months the car was available to you during the year. The perquisite "
        "is prorated on this figure.",
    "salary.motor_car.chauffeur_provided":
        "Tick if a driver comes with the car. A further "
        "{motor_car_chauffeur_per_month} per month is added to the perquisite.",

    # -- house property ----------------------------------------------------
    "house_property.enabled":
        "Tick if you own any house property, whether self-occupied, let out or "
        "deemed let out. Up to {max_self_occupied_properties} properties may "
        "be treated as self-occupied.",
    "house_property.annual_rent_received":
        "Rent received or receivable for this property over the year. Leave "
        "municipal taxes out of it, they have their own field. A flat "
        "{house_property_standard_deduction} standard deduction is then "
        "allowed on the net annual value.",
    "house_property.municipal_taxes_paid":
        "Municipal and property taxes you actually paid during the year. Only "
        "tax paid is deductible, not tax merely levied.",
    "house_property.housing_loan_interest":
        "Interest paid on the housing loan for this property. For a "
        "self-occupied property the deduction is capped at "
        "{self_occupied_interest_cap} and is available in the old regime only; "
        "let-out interest is uncapped.",

    # -- business and profession ------------------------------------------
    "pgbp.enabled":
        "Tick if you earn from a business or profession, under either the "
        "presumptive scheme or regular books.",
    "pgbp.presumptive.enabled":
        "Presumptive taxation under {presumptive_44ad_section} or "
        "{presumptive_44ada_section} declares a deemed profit on turnover, so "
        "you need not maintain detailed books.",
    "pgbp.presumptive.scheme":
        "{presumptive_44ad_section} covers business such as trading and "
        "manufacturing. {presumptive_44ada_section} covers professions such as "
        "doctors, architects and chartered accountants. The turnover ceilings "
        "and deemed-profit rates differ.",
    "pgbp.presumptive.gross_turnover":
        "Gross turnover or receipts for the year. Under "
        "{presumptive_44ad_section} the ceiling is "
        "{presumptive_44ad_turnover_limit} where cash receipts stay within "
        "{presumptive_cash_threshold} of turnover, and "
        "{presumptive_44ad_turnover_limit_standard} otherwise.",
    "pgbp.presumptive.cash_receipts":
        "The part of your turnover taken in cash or by bearer instrument. "
        "Deemed profit on this portion is {presumptive_44ad_cash_percent} "
        "under {presumptive_44ad_section}.",
    "pgbp.presumptive.digital_receipts":
        "The part received digitally, by bank transfer, UPI, card, NEFT or "
        "RTGS. Deemed profit on this portion is only "
        "{presumptive_44ad_digital_percent}, which is why the split is worth "
        "getting right.",
    "pgbp.regular.enabled":
        "Use regular books, a profit and loss account and balance sheet, if "
        "you are outside the presumptive ceilings or your actual profit is "
        "lower than the deemed profit.",
    "pgbp.regular.gross_receipts":
        "Total business or professional revenue for the year, before expenses.",
    "pgbp.regular.total_expenses":
        "Allowable business expenses, rent, staff salary, materials, "
        "utilities, travel and so on.",
    "pgbp.regular.depreciation":
        "Depreciation claimed on business assets at the rates prescribed by "
        "the income-tax rules, which differ from your book depreciation.",
    "pgbp.tds_deducted":
        "TDS your clients deducted on payments to you. Check Form 26AS or the "
        "AIS for the total.",

    # -- capital gains -----------------------------------------------------
    "capital_gains.enabled":
        "Tick if you sold any capital asset during the year, shares, mutual "
        "funds, property, gold or bonds.",
    "capital_gains.stcg_111a":
        "Net short-term gain on listed equity and equity-oriented mutual fund "
        "units where STT was paid. Taxed at {stcg_111a_rate} under "
        "{stcg_111a_section}, outside your slab.",
    "capital_gains.ltcg_112a":
        "Net long-term gain on listed equity and equity mutual funds where STT "
        "was paid. The first {ltcg_112a_exemption} each year is exempt; the "
        "balance is taxed at {ltcg_112a_rate} under {ltcg_112a_section}.",
    "capital_gains.stcg_other":
        "Net short-term gain on other assets such as property, gold, debt "
        "funds or unlisted shares. This is added to your regular income and "
        "taxed at slab rates.",
    "capital_gains.ltcg_other":
        "Net long-term gain on other assets, taxed at {ltcg_other_rate}. "
        "Indexation is no longer available for most such transfers.",
    "capital_gains.brought_forward_stcl":
        "Short-term capital loss carried forward from earlier years. It can be "
        "set off against both short-term and long-term gains, for up to "
        "{capital_loss_carry_forward_years} assessment years.",
    "capital_gains.brought_forward_ltcl":
        "Long-term capital loss carried forward from earlier years. It can be "
        "set off only against long-term gains, for up to "
        "{capital_loss_carry_forward_years} assessment years.",
    "capital_gains.tds_deducted":
        "TDS deducted on your capital gains, typically on the sale of property "
        "or by your broker on listed securities.",

    # -- other sources -----------------------------------------------------
    "other_sources.enabled":
        "Tick if you earn interest, dividend, pension or anything else outside "
        "salary, house property, business and capital gains.",
    "other_sources.savings_interest":
        "Interest earned across all savings bank accounts. A deduction of up "
        "to {deduction_80TTA_limit} under {deduction_80TTA_section}, or "
        "{deduction_80TTB_limit} under {deduction_80TTB_section} for senior "
        "citizens, is applied for you in the old regime.",
    "other_sources.fd_interest":
        "Interest on fixed, recurring and corporate deposits. Fully taxable at "
        "slab rates, with no equivalent of the savings-interest deduction.",
    "other_sources.other_interest":
        "Interest from any other source - NSC, KVP, post-office schemes, "
        "bonds, debentures, or interest paid on an income-tax refund.",
    "other_sources.dividend_income":
        "Dividend received from shares and mutual funds, taxable in your own "
        "hands at slab rates.",
    "other_sources.family_pension":
        "Pension drawn by a family member after the pensioner has died. A "
        "standard deduction is allowed against it.",
    "other_sources.winnings":
        "Lottery, betting, online gaming, horse racing and game-show income. "
        "Taxed at a flat special rate, with no deduction, exemption or basic "
        "exemption limit available against it.",
    "other_sources.other_income":
        "Any other taxable receipt, gifts beyond the exempt threshold, "
        "royalty, or agricultural income above the exempt limit.",
    "other_sources.tds_deducted":
        "TDS deducted on this income, typically on deposit interest or "
        "dividend. Confirm the total against Form 26AS or the AIS.",

    # -- deductions and taxes paid ----------------------------------------
    "deductions.employee_pf_contribution":
        "Your own share of the EPF contribution for the year, not your "
        "employer's. It counts against the {deduction_80C_limit} ceiling "
        "under {deduction_80C_section}.",
    "deductions.home_loan_principal":
        "Principal repaid on a home loan this year. It also counts against "
        "the same {deduction_80C_limit} ceiling; the interest is claimed "
        "under house property instead.",
    "advance_tax_paid":
        "Advance tax you paid during the year, due in instalments on "
        "{advance_tax_due_dates}. Enter the total of every challan and verify "
        "it against Form 26AS.",
    "self_assessment_tax_paid":
        "Tax paid before filing to settle the balance left after TDS and "
        "advance tax, usually through {self_assessment_challan}.",
}


# ---------------------------------------------------------------------------
# Step-by-step filing guides
#
# Same rule as FIELD_GUIDANCE: every figure and due date is a {placeholder}.
# `link` is delivered as structured data rather than markup, so the UI builds
# the anchor itself and nothing here is rendered as raw HTML.
# ---------------------------------------------------------------------------

FILING_GUIDES = [
    {
        "key": "itr",
        "title": "How to file your ITR",
        "subtitle": "Income tax return, end to end",
        "steps": [
            {
                "title": "Register or log in on the e-filing portal",
                "detail":
                    "Sign in with your PAN, password and Aadhaar OTP. If this "
                    "is your first return, register your PAN first.",
                "link": {"url": "{itr_portal_url}", "label": "{itr_portal_label}"},
            },
            {
                "title": "Download Form 26AS and the AIS / TIS",
                "detail":
                    "Both sit under e-File on the portal. Reconcile every TDS "
                    "entry, advance tax challan and high-value transaction "
                    "before you fill anything in, a mismatch here is the most "
                    "common reason a return draws a notice later.",
            },
            {
                "title": "Pick the right ITR form",
                "detail":
                    "{itr_form_summary} This calculator selects the form for "
                    "you from the heads of income you enter.",
            },
            {
                "title": "Enter income under each head",
                "detail":
                    "Salary from Form 16, house property, business or "
                    "profession, capital gains and other sources. The figures "
                    "this calculator produces map onto the portal's schedules "
                    "head by head.",
            },
            {
                "title": "Claim your deductions",
                "detail":
                    "Investments, health insurance, education loan interest "
                    "and donations. Almost all of these are old-regime only, "
                    "which is what makes the regime comparison worth running.",
            },
            {
                "title": "Choose a regime and compute the tax",
                "detail":
                    "The new regime applies by default, so staying in the old "
                    "one is an active choice. Compare both before you commit; "
                    "the comparison on this page runs on your own figures.",
            },
            {
                "title": "Pay whatever is still outstanding",
                "detail":
                    "If tax remains after TDS and advance tax, pay it through "
                    "e-Pay Tax on the portal using {self_assessment_challan}, "
                    "and keep the BSR code, challan serial number and date.",
            },
            {
                "title": "Submit, then e-verify",
                "detail":
                    "E-verify within {everify_days} days by Aadhaar OTP, net "
                    "banking or digital signature. A return that is filed but "
                    "never verified is treated as never filed at all.",
            },
        ],
    },
]


# ---------------------------------------------------------------------------
# Guidance rendering
#
# guidance_values() is the single bridge between the rate dicts above and the
# prose that describes them. A KeyError here is deliberate and loud: it means
# a template names a figure this config does not carry, and the /config
# response would otherwise ship a half-written sentence.
# ---------------------------------------------------------------------------

def _trim(value: float) -> str:
    """Render a number without trailing zeros: 3, 1.25, 12.5."""
    return f"{value:.2f}".rstrip("0").rstrip(".")


def format_inr(amount) -> str:
    """
    Format a rupee figure the way an Indian reader expects to see it.

    Large round figures read better in crore and lakh than in digits, and
    below a lakh the digit grouping is the same either way.
    """
    if amount is None:
        return "no limit"
    value = float(amount)
    if value >= 10000000:
        return "₹" + _trim(value / 10000000) + " crore"
    if value >= 100000:
        return "₹" + _trim(value / 100000) + " lakh"
    return "₹" + format(int(round(value)), ",")


def format_percent(fraction) -> str:
    """Render a stored fraction (0.125) as a percentage string (12.5%)."""
    return _trim(float(fraction) * 100) + "%"


def _join(items, final="and") -> str:
    """Join a list into readable prose: "a, b and c"."""
    items = [str(i) for i in items]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + f" {final} " + items[-1]


def _itr_form_summary() -> str:
    """One sentence naming each ITR form and who it is for."""
    return " ".join(
        f"{ITR_FORMS[key]['name']}: {ITR_FORMS[key]['description']}"
        for key in ITR_EVALUATION_ORDER
    )


def guidance_values(tax_year: str = None) -> Dict[str, str]:
    """
    Every {placeholder} the guidance text may use, already formatted.

    Values are read from the config dicts rather than restated, so a Budget
    that changes a rate rewrites the help text along with the calculation.
    """
    hra = HRA_RULES
    car = MOTOR_CAR_PERQUISITE
    hp = HOUSE_PROPERTY_RULES
    cg = CAPITAL_GAINS_RULES
    emp = EMPLOYER_CONTRIBUTION_RULES
    p44ad = PRESUMPTIVE_TAXATION["44AD"]
    p44ada = PRESUMPTIVE_TAXATION["44ADA"]

    values = {
        # age bands
        "senior_age": AGE_BANDS["senior"]["min"],
        "super_senior_age": AGE_BANDS["super_senior"]["min"],

        # HRA
        "hra_metro_percent": format_percent(hra["metro_percent"]),
        "hra_non_metro_percent": format_percent(hra["non_metro_percent"]),
        "hra_rent_less_percent": format_percent(hra["rent_less_percent_of_salary"]),
        "hra_landlord_pan_threshold": format_inr(hra["landlord_pan_required_above"]),
        "metro_cities": _join(hra["metro_cities_strict"], final="or"),

        # employer contributions
        "gratuity_accrual_percent": format_percent(emp["gratuity"]["accrual_percent"]),
        "gratuity_exemption_cap": format_inr(emp["gratuity"]["exemption_cap"]),
        "nps_section": emp["nps"]["section_1961"],
        "nps_old_regime_percent": format_percent(emp["nps"]["old_regime_percent"]),
        "nps_new_regime_percent": format_percent(emp["nps"]["new_regime_percent"]),
        "pf_exempt_percent": format_percent(emp["provident_fund"]["exempt_percent"]),
        "labour_code_basic_da_percent": format_percent(LABOUR_CODE_BASIC_DA_FLOOR),

        # motor car
        "motor_car_small_engine_litres": MOTOR_CAR_SMALL_ENGINE_LITRES,
        "motor_car_chauffeur_per_month": format_inr(car["chauffeur_per_month"]),

        # house property
        "house_property_standard_deduction":
            format_percent(hp["standard_deduction_percent"]),
        "self_occupied_interest_cap":
            format_inr(hp["self_occupied_interest_cap"]["cap"]),
        "max_self_occupied_properties": hp["max_self_occupied_properties"],

        # capital gains
        "stcg_111a_rate": format_percent(cg["stcg_111a"]["rate"]),
        "stcg_111a_section": cg["stcg_111a"]["section_1961"],
        "ltcg_112a_rate": format_percent(cg["ltcg_112a"]["rate"]),
        "ltcg_112a_section": cg["ltcg_112a"]["section_1961"],
        "ltcg_112a_exemption": format_inr(cg["ltcg_112a"]["annual_exemption"]),
        "ltcg_other_rate": format_percent(cg["ltcg_other"]["rate"]),
        "capital_loss_carry_forward_years":
            cg["loss_set_off"]["carry_forward_years"],

        # presumptive
        "presumptive_44ad_section": p44ad["section_1961"],
        "presumptive_44ada_section": p44ada["section_1961"],
        "presumptive_44ad_turnover_limit": format_inr(p44ad["turnover_limit"]),
        "presumptive_44ad_turnover_limit_standard":
            format_inr(p44ad["turnover_limit_standard"]),
        "presumptive_44ad_cash_percent":
            format_percent(p44ad["deemed_profit_percent_cash"]),
        "presumptive_44ad_digital_percent":
            format_percent(p44ad["deemed_profit_percent_digital"]),
        "presumptive_cash_threshold":
            format_percent(p44ad["cash_receipts_threshold"]),

        # filing
        "itr_portal_url": ITR_FILING["portal_url"],
        "itr_portal_label": ITR_FILING["portal_label"],
        "everify_days": ITR_FILING["everify_days"],
        "advance_tax_due_dates": _join(ITR_FILING["advance_tax_due_dates"]),
        "self_assessment_challan": ITR_FILING["self_assessment_challan"],
        "itr_form_summary": _itr_form_summary(),
    }

    # Deduction limits and section labels, so guidance can name any of them
    # without knowing which Act is in force for the year.
    for key, deduction in DEDUCTIONS.items():
        values[f"deduction_{key}_limit"] = format_inr(deduction.get("limit"))
        values[f"deduction_{key}_section"] = section_label(key, tax_year)

    return values


def get_field_guidance(tax_year: str = None) -> Dict[str, str]:
    """FIELD_GUIDANCE with every placeholder resolved for the given year."""
    values = guidance_values(tax_year)
    return {key: text.format(**values) for key, text in FIELD_GUIDANCE.items()}


def get_filing_guides(tax_year: str = None):
    """FILING_GUIDES with every placeholder resolved for the given year."""
    values = guidance_values(tax_year)

    def render_step(step):
        rendered = {
            "title": step["title"],
            "detail": step["detail"].format(**values),
        }
        link = step.get("link")
        if link:
            rendered["link"] = {
                "url": link["url"].format(**values),
                "label": link["label"].format(**values),
            }
        return rendered

    return [
        {
            "key": guide["key"],
            "title": guide["title"],
            "subtitle": guide["subtitle"],
            "steps": [render_step(s) for s in guide["steps"]],
        }
        for guide in FILING_GUIDES
    ]
