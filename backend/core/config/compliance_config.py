"""
Statutory calendar and penalty configuration for the Startup Compliance
Command Center.

EVERY due date, rate, late fee and threshold lives in this file. Nothing in
`services/compliance_service.py` or the router hardcodes a statutory figure —
these change with each Finance Act and GST Council meeting, and the point of
this module is that updating them means editing this file and nothing else.
Same contract `config/tax_config.py` holds for income-tax rates.

--------------------------------------------------------------------------
SCOPE, AND AN HONEST LIMIT
--------------------------------------------------------------------------
This module powers three things:

  1. A DEADLINE CALENDAR. Fully deterministic — the due dates below are
     statutory and are computed exactly. The founder marks each filing as
     filed (with the date) or not applicable, so "overdue" means genuinely
     unfiled rather than merely past its due date.

  2. PENALTY EXPOSURE. Computed from the rates below. Late fees need only a
     date; interest needs the amount that was due, which is taken from what
     the founder enters for that period, else from the estimate in (3), else
     reported as not computable — never guessed.

  3. A LIABILITY ESTIMATE. Approximate, and labelled as such everywhere it is
     surfaced. `StartupTransaction` records only type / category / amount /
     date, so it carries no GST rate, no HSN/SAC code, no place of supply and
     no B2B-versus-B2C split. It applies a single assumed rate to categorised
     turnover and reports the result as an ESTIMATE, with the assumptions
     listed alongside. It is a planning aid, not a return, and must not be
     filed.

--------------------------------------------------------------------------
WHICH LAW
--------------------------------------------------------------------------
The Income-tax Act, 2025 replaced the Income-tax Act, 1961 from 1 April 2026.
Section references below cite the 2025 Act with the earlier 1961 section in
brackets, because most founders and CAs still search by the old number. The
register reflects the rules in force for FY2026-27; earlier years shown in the
year selector are for context and use the same rules.

--------------------------------------------------------------------------
SOURCES (verified 2026-09)
--------------------------------------------------------------------------
  * GSTR-1 / GSTR-3B / GSTR-9 due dates ....... cbic-gst.gov.in
  * GST late fee caps by turnover ............. Notifications 19/2021 and 20/2021 CT
                                                (cleartax.in/s/gst-return-late-fees)
  * GSTR-9 late fee by turnover ............... Notification 07/2023 CT
  * GST interest (S.50) ....................... CGST Act, 2017
  * TDS under S.392 / S.393, Forms 138 / 140 .. cleartax.in/s/tds-and-tcs-changes-from-april-2026
  * TDS thresholds (194J / 194-I / 194C) ...... Finance Act 2025; onefinops.com S.393 mapping
  * S.427 late filing fee (earlier S.234E) .... incometaxindia.gov.in
  * S.424 / S.425 interest (earlier 234B / C) . eztax.in/interest-under-section-234a-b-c
  * TDS return due dates ...................... cleartax.in/s/tds-payment-due-dates-and-penalties
  * EPF / ESI deposit dates ................... epfindia.gov.in, esic.gov.in
  * ROC AOC-4 / MGT-7 / DPT-3 ................. mca.gov.in
  * DIR-3 KYC triennial cycle ................. G.S.R. 943(E), 31 Dec 2025, effective 31 Mar 2026
"""

from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Financial year
# ---------------------------------------------------------------------------
FY_START_MONTH = 4  # India's financial year runs April to March.


# ---------------------------------------------------------------------------
# Recurring obligations.
#
# `cadence`:
#   monthly   — one occurrence per month of the FY, due on `day` of the month
#               `offset_months` later (default 1), with per-month overrides.
#   quarterly / annual — explicit occurrences in `due_on`. Each carries its
#               own `year_offset` from the FY start year, so a Q4 return due
#               in May of the following year can never be dated a year early,
#               and its own `period` label.
#
# `applies_if` gates an obligation on a capability flag the service derives
# from the founder's profile, so a company with no GSTIN is never shown GST
# returns and one below the headcount threshold is never shown PF/ESI.
#
# `liability_link` names where the amount due for a period can be ESTIMATED
# from recorded transactions ("gst", "tds", "tds_quarter"). Obligations without
# one (PF, ESI, advance tax, income tax) need the founder to enter the amount
# before interest can be computed.
# ---------------------------------------------------------------------------
OBLIGATIONS: List[Dict[str, Any]] = [
    # ----------------------------- GST -----------------------------
    {
        "id": "gstr1",
        "category": "GST",
        "label": "GSTR-1",
        "description": "Statement of outward supplies for the month. No tax is paid with this return.",
        "authority": "GST Network",
        "cadence": "monthly",
        "day": 11,
        "offset_months": 1,
        "applies_if": "has_gstin",
        "liability_link": "gst",
        "amount_label": "Outward supplies tax for the month (enter 0 for a nil return)",
        "penalty_id": "gstr1_late_fee",
    },
    {
        "id": "gstr3b",
        "category": "GST",
        "label": "GSTR-3B",
        "description": "Summary return and payment of net GST for the month.",
        "authority": "GST Network",
        "cadence": "monthly",
        "day": 20,
        "offset_months": 1,
        "applies_if": "has_gstin",
        "liability_link": "gst",
        "amount_label": "Net GST paid in cash for the month (enter 0 for a nil return)",
        "penalty_id": "gstr3b_late_fee",
    },
    {
        "id": "gstr9",
        "category": "GST",
        "label": "GSTR-9 (annual return)",
        "description": ("Annual GST return. The Council has exempted small taxpayers (turnover up to "
                        "Rs.2 crore) in several years — mark it not applicable if an exemption covers you."),
        "authority": "GST Network",
        "cadence": "annual",
        "due_on": [{"month": 12, "day": 31, "year_offset": 1, "period": "Annual"}],
        "applies_if": "has_gstin",
        "penalty_id": "gstr9_late_fee",
    },

    # ----------------------------- TDS -----------------------------
    {
        "id": "tds_payment",
        "category": "TDS",
        "label": "TDS deposit",
        "description": "Deposit of tax deducted at source during the month (S.392 / S.393; earlier S.192 and the 194 series).",
        "authority": "Income Tax Department",
        "cadence": "monthly",
        "day": 7,
        "offset_months": 1,
        # March TDS is due 30 April, not 7 April.
        "month_overrides": {3: {"day": 30, "offset_months": 1}},
        "applies_if": "has_tds",
        "liability_link": "tds",
        "amount_label": "TDS deducted in the month",
        "penalty_id": "tds_late_deposit",
    },
    {
        "id": "tds_return",
        "category": "TDS",
        "label": "TDS return (Form 140 / Form 138)",
        "description": ("Quarterly statement of tax deducted at source. Form 140 replaced Form 26Q "
                        "(non-salary) and Form 138 replaced Form 24Q (salary) from 1 April 2026."),
        "authority": "Income Tax Department",
        "cadence": "quarterly",
        "due_on": [
            {"month": 7, "day": 31, "year_offset": 0, "period": "Q1 (Apr-Jun)"},
            {"month": 10, "day": 31, "year_offset": 0, "period": "Q2 (Jul-Sep)"},
            {"month": 1, "day": 31, "year_offset": 1, "period": "Q3 (Oct-Dec)"},
            {"month": 5, "day": 31, "year_offset": 1, "period": "Q4 (Jan-Mar)"},
        ],
        "applies_if": "has_tds",
        "liability_link": "tds_quarter",
        "amount_label": "TDS reported in the statement for the quarter",
        "penalty_id": "tds_late_return",
    },

    # ------------------------- Payroll levies ----------------------
    {
        "id": "epf",
        "category": "Payroll",
        "label": "EPF contribution",
        "description": "Provident fund deposit for the month.",
        "authority": "EPFO",
        "cadence": "monthly",
        "day": 15,
        "offset_months": 1,
        "applies_if": "has_epf",
        "amount_label": "EPF contribution due for the month",
        "penalty_id": "epf_late",
    },
    {
        "id": "esi",
        "category": "Payroll",
        "label": "ESI contribution",
        "description": "Employees' State Insurance deposit for the month.",
        "authority": "ESIC",
        "cadence": "monthly",
        "day": 15,
        "offset_months": 1,
        "applies_if": "has_esi",
        "amount_label": "ESI contribution due for the month",
        "penalty_id": "esi_late",
    },

    # ------------------------- Income tax --------------------------
    {
        "id": "advance_tax",
        "category": "Income Tax",
        "label": "Advance tax instalment",
        "description": "Cumulative instalment of advance tax for the tax year.",
        "authority": "Income Tax Department",
        "cadence": "quarterly",
        "due_on": [
            {"month": 6, "day": 15, "year_offset": 0, "period": "15% by 15 Jun"},
            {"month": 9, "day": 15, "year_offset": 0, "period": "45% by 15 Sep"},
            {"month": 12, "day": 15, "year_offset": 0, "period": "75% by 15 Dec"},
            {"month": 3, "day": 15, "year_offset": 1, "period": "100% by 15 Mar"},
        ],
        "applies_if": "always",
        "amount_label": "Shortfall against this instalment",
        "penalty_id": "advance_tax_shortfall",
    },
    {
        "id": "itr",
        "category": "Income Tax",
        "label": "Income tax return (company)",
        "description": "Annual return for a company subject to audit.",
        "authority": "Income Tax Department",
        "cadence": "annual",
        "due_on": [{"month": 10, "day": 31, "year_offset": 1, "period": "Annual"}],
        "applies_if": "always",
        "amount_label": "Tax still unpaid when the return is filed",
        "penalty_id": "itr_late",
    },

    # ---------------------------- ROC ------------------------------
    {
        "id": "aoc4",
        "category": "ROC",
        "label": "AOC-4 (financial statements)",
        "description": "Filing of audited financial statements, within 30 days of the AGM.",
        "authority": "Ministry of Corporate Affairs",
        "cadence": "annual",
        "due_on": [{"month": 10, "day": 30, "year_offset": 1, "period": "Annual"}],
        "applies_if": "is_company",
        "penalty_id": "roc_late",
    },
    {
        "id": "mgt7",
        "category": "ROC",
        "label": "MGT-7 (annual return)",
        "description": "Annual return of the company, within 60 days of the AGM.",
        "authority": "Ministry of Corporate Affairs",
        "cadence": "annual",
        "due_on": [{"month": 11, "day": 29, "year_offset": 1, "period": "Annual"}],
        "applies_if": "is_company",
        "penalty_id": "roc_late",
    },
    {
        "id": "dpt3",
        "category": "ROC",
        "label": "DPT-3 (return of deposits)",
        "description": "Annual return of deposits and outstanding loans.",
        "authority": "Ministry of Corporate Affairs",
        "cadence": "annual",
        "due_on": [{"month": 6, "day": 30, "year_offset": 1, "period": "Annual"}],
        "applies_if": "is_company",
        "penalty_id": "roc_late",
    },
    {
        "id": "dir3kyc",
        "category": "ROC",
        "label": "DIR-3 KYC-Web (director KYC)",
        "description": ("Director KYC is filed once every three financial years, by 30 June. Mark it not "
                        "applicable in a year your directors are not due, and re-file within 30 days of "
                        "any change of mobile, email or address."),
        "authority": "Ministry of Corporate Affairs",
        "cadence": "annual",
        "due_on": [{"month": 6, "day": 30, "year_offset": 0, "period": "Triennial cycle"}],
        "applies_if": "is_company",
        "penalty_id": "dir3_late",
    },
]


# ---------------------------------------------------------------------------
# Penalties.
#
# Fee keys (all optional):
#   per_day / per_day_nil ......... late fee per day; the nil rate applies when
#                                   the amount for the period is exactly 0
#   max_amount / max_amount_nil ... a fixed cap; `max_amount: None` means the
#                                   statute sets NO cap
#   max_by_turnover ............... cap tiered by aggregate annual turnover
#   per_day_by_turnover ........... per-day fee AND a %-of-turnover cap, tiered
#   cap_at_amount ................. fee may not exceed the amount for the period
#   flat_amount ................... a one-off fee once late
# Interest keys:
#   monthly_interest_pct .......... per month or part of a month
#   annual_interest_pct ........... simple interest per day
# Interest always needs the amount due for the period.
#
# Tiers are ordered; `up_to: None` is the top tier. When turnover is unknown
# the top tier is used, which is the upper bound of exposure, and the basis
# says so.
# ---------------------------------------------------------------------------
_GST_RETURN_CAPS = [
    {"up_to": 15000000.0, "max": 2000.0},    # up to Rs.1.5 crore
    {"up_to": 50000000.0, "max": 5000.0},    # Rs.1.5 crore to Rs.5 crore
    {"up_to": None, "max": 10000.0},         # above Rs.5 crore
]

PENALTIES: Dict[str, Dict[str, Any]] = {
    "gstr1_late_fee": {
        "label": "GSTR-1 late fee",
        "per_day": 50.0,
        "per_day_nil": 20.0,
        "max_by_turnover": _GST_RETURN_CAPS,
        "max_amount_nil": 500.0,
        "note": ("Rs.50/day (Rs.20/day for a nil return) under S.47, capped by turnover at Rs.2,000 / "
                 "Rs.5,000 / Rs.10,000 (Rs.500 for a nil return). No interest: GSTR-1 carries no tax payment."),
    },
    "gstr3b_late_fee": {
        "label": "GSTR-3B late fee",
        "per_day": 50.0,
        "per_day_nil": 20.0,
        "max_by_turnover": _GST_RETURN_CAPS,
        "max_amount_nil": 500.0,
        "annual_interest_pct": 18.0,
        "note": ("Rs.50/day (Rs.20/day for a nil return) under S.47, capped by turnover at Rs.2,000 / "
                 "Rs.5,000 / Rs.10,000 (Rs.500 for a nil return), plus 18% p.a. interest under S.50 on "
                 "the net tax paid in cash."),
    },
    "gstr9_late_fee": {
        "label": "GSTR-9 late fee",
        "per_day_by_turnover": [
            {"up_to": 50000000.0, "per_day": 50.0, "max_turnover_pct": 0.04},    # up to Rs.5 crore
            {"up_to": 200000000.0, "per_day": 100.0, "max_turnover_pct": 0.04},  # Rs.5 to 20 crore
            {"up_to": None, "per_day": 200.0, "max_turnover_pct": 0.5},          # above Rs.20 crore
        ],
        "note": ("Rs.50/day up to Rs.5 crore turnover and Rs.100/day up to Rs.20 crore, each capped at "
                 "0.04% of turnover; Rs.200/day above that, capped at 0.5% of turnover."),
    },
    "tds_late_deposit": {
        "label": "Interest on late TDS deposit",
        "monthly_interest_pct": 1.5,
        "note": ("1.5% per month or part of a month (earlier S.201(1A)). The statute counts from the date "
                 "of deduction; this counts from the due date, so it is the minimum you owe."),
    },
    "tds_late_return": {
        "label": "TDS return late fee",
        "per_day": 200.0,
        "cap_at_amount": True,
        "note": "Rs.200/day under S.427 (earlier S.234E), capped at the TDS reported in the statement.",
    },
    "epf_late": {
        "label": "EPF late deposit",
        "annual_interest_pct": 12.0,
        "note": "Interest at 12% p.a. under S.7Q of the EPF Act, plus damages under S.14B that are not modelled.",
    },
    "esi_late": {
        "label": "ESI late deposit",
        "annual_interest_pct": 12.0,
        "note": "Simple interest at 12% p.a. for each day of default.",
    },
    "advance_tax_shortfall": {
        "label": "Advance tax shortfall",
        "monthly_interest_pct": 1.0,
        "note": "Interest at 1% per month or part of a month on the shortfall, under S.424 / S.425 (earlier S.234B / S.234C).",
    },
    "itr_late": {
        "label": "Return filed late",
        "flat_amount": 5000.0,
        "monthly_interest_pct": 1.0,
        "note": ("Late filing fee of Rs.5,000 (earlier S.234F), plus 1% per month on tax still unpaid "
                 "under S.423 (earlier S.234A)."),
    },
    "roc_late": {
        "label": "ROC additional fee",
        "per_day": 100.0,
        "max_amount": None,          # No statutory cap — this is the dangerous one.
        "note": "Rs.100/day per form with NO upper cap. This is the penalty that grows without limit.",
    },
    "dir3_late": {
        "label": "DIN reactivation fee",
        "flat_amount": 5000.0,
        "note": "Flat Rs.5,000 per director, and the DIN is deactivated until the KYC is filed.",
    },
}


# ---------------------------------------------------------------------------
# Filing records the founder keeps against individual occurrences.
# ---------------------------------------------------------------------------
FILING_STATUSES: Dict[str, str] = {
    "pending": "Not yet filed. Used to record the amount due so interest can be computed.",
    "filed": "Filed. A filing date after the due date is reported as filed late, with the fee incurred.",
    "not_applicable": "Does not apply to this company for this period.",
}


# ---------------------------------------------------------------------------
# Liability estimation.
#
# Category names below MUST match the categories written to
# StartupTransaction.category by the Hisaab ledger and the Gmail import.
# Older rows written by the Gmail import used short names; CATEGORY_ALIASES
# folds them onto the ledger's names before any lookup.
# ---------------------------------------------------------------------------

#: Legacy or alternative category spellings -> the ledger's canonical name.
CATEGORY_ALIASES: Dict[str, str] = {
    "Rent": "Rent / Housing",
    "Utilities": "Utilities & Bills",
    "Travel": "Travel & Transport",
}


def canonical_category(raw: Optional[str]) -> str:
    name = (raw or "").strip() or "Uncategorized"
    return CATEGORY_ALIASES.get(name, name)


#: Assumed GST rate applied to taxable turnover. 18% is the standard rate for
#: services, which is what most startups on this product supply.
ASSUMED_GST_RATE_PCT = 18.0

#: Bounds for the assumed-rate query parameter.
MIN_ASSUMED_GST_RATE_PCT = 0.0
MAX_ASSUMED_GST_RATE_PCT = 40.0

#: How to read a logged amount. Founders typically log what hit the bank, so
#: amounts are treated as GST-INCLUSIVE by default. The router exposes this as
#: a query parameter, because a founder logging invoice values wants the other
#: reading and the difference is material.
DEFAULT_AMOUNTS_ARE = "inclusive"

#: 'in' categories that represent a taxable supply. Funding, refunds, interest
#: and investment returns are NOT supplies and are deliberately excluded —
#: counting a funding round as turnover would badly overstate GST.
TAXABLE_INCOME_CATEGORIES = {
    "Revenue",
    "Freelance / Business",
}

#: 'in' categories excluded from turnover, with the reason shown to the founder.
NON_SUPPLY_INCOME_CATEGORIES = {
    "Funding": "Capital receipt, not a supply.",
    "Investment Return": "Not a supply of goods or services.",
    "Interest income": "Exempt supply.",
    "Refund": "Reversal, not a supply.",
    "Gift": "Not consideration for a supply.",
    "Salary": "Employment income, outside the scope of GST.",
    "Other income": "Not assumed to be a supply. If it is a sale, categorise it as Revenue.",
    "Uncategorized": "Not yet categorised. If these credits are sales, categorise them as Revenue so they count.",
}

#: 'out' categories on which input tax credit is ordinarily available.
ITC_ELIGIBLE_CATEGORIES = {
    "Software/Tools",
    "Marketing",
    "Professional fees",
    "Supplies",
    "Utilities & Bills",
}

#: 'out' categories that never carry ITC.
ITC_BLOCKED_CATEGORIES = {
    "Payroll": "Employment cost, no GST charged.",
    "Taxes": "Statutory payment, not an inward supply.",
    "Food & Dining": "Blocked credit under S.17(5).",
    "Entertainment": "Blocked credit under S.17(5).",
}

#: TDS inferred from spend category.
#:   threshold_basis "annual"  — deduct on the year's spend in the category once it exceeds the threshold
#:   threshold_basis "monthly" — deduct on each month whose spend exceeds the threshold
TDS_RULES: List[Dict[str, Any]] = [
    {
        "key": "professional_fees",
        "categories": ["Professional fees"],
        "section": "S.393 (earlier 194J)",
        "rate_pct": 10.0,
        "threshold": 50000.0,
        "threshold_basis": "annual",
        "description": "Fees for professional services. Technical services attract 2%; 10% is assumed.",
    },
    {
        "key": "contractors",
        "categories": ["Marketing"],
        "section": "S.393 (earlier 194C)",
        "rate_pct": 2.0,
        "threshold": 100000.0,
        "threshold_basis": "annual",
        "description": ("Payments to contractors, including agencies. 2% assumes a company or firm (1% for an "
                        "individual); a single payment above Rs.30,000 also attracts TDS."),
    },
    {
        "key": "rent",
        "categories": ["Rent / Housing"],
        "section": "S.393 (earlier 194-I)",
        "rate_pct": 10.0,
        "threshold": 50000.0,
        "threshold_basis": "monthly",
        "description": "Rent of land, building or furniture above Rs.50,000 in a month. Plant and machinery attract 2%.",
    },
]

#: Rate a payee without a PAN attracts, quoted in the TDS assumptions.
NO_PAN_TDS_RATE_PCT = 20.0

#: GST registration thresholds (CGST Act S.22).
GST_REGISTRATION_THRESHOLD_SERVICES = 2000000.0   # Rs.20 lakh
GST_REGISTRATION_THRESHOLD_GOODS = 4000000.0      # Rs.40 lakh

# ---------------------------------------------------------------------------
# Applicability thresholds — decide which obligations a given company sees.
# ---------------------------------------------------------------------------

#: Headcount at which EPF registration becomes mandatory.
EPF_HEADCOUNT_THRESHOLD = 20

#: Headcount at which ESI registration becomes mandatory (most states).
ESI_HEADCOUNT_THRESHOLD = 10

#: Spend categories whose presence implies a TDS deduction obligation. Derived
#: from TDS_RULES so the two can never drift apart.
TDS_TRIGGER_CATEGORIES = {c for rule in TDS_RULES for c in rule["categories"]}

#: Payroll category name in the startup transaction ledger, used to infer whether the
#: company runs payroll at all.
PAYROLL_CATEGORY = "Payroll"

#: Windows that drive the status of a calendar entry.
DUE_SOON_DAYS = 15

#: How many previous financial years the year selector offers.
YEARS_OF_HISTORY = 2

#: Blanket disclaimer attached to every liability payload.
LIABILITY_DISCLAIMER = (
    "These figures are estimates for cash-flow planning only. They are derived from "
    "categorised transactions using a single assumed GST rate, and do not account for "
    "place of supply, HSN/SAC classification, exempt or zero-rated supplies, reverse "
    "charge, or B2B versus B2C treatment. They are not a return and must not be filed. "
    "Section references follow the Income-tax Act, 2025, with the earlier 1961 section in "
    "brackets. Confirm every figure with your chartered accountant."
)
