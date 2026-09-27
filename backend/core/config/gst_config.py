"""
GST rate configuration for the Startup GST Calculator.

EVERY statutory figure lives in this file. Nothing in the service or router
layer hardcodes a rate, threshold or limit — GST rates change at Council
meetings, and the point of this module is that updating them means editing
this file and nothing else. Same contract `config/tax_config.py` holds for
income-tax rates and `config/compliance_config.py` for filing deadlines.

--------------------------------------------------------------------------
WHICH RATE STRUCTURE APPLIES
--------------------------------------------------------------------------
The 56th GST Council meeting introduced "GST 2.0", effective 22 September
2025. It collapsed the old four-slab structure into three:

    Before 22 Sep 2025 ....  0%, 5%, 12%, 18%, 28%  (+ compensation cess)
    From   22 Sep 2025 ....  0%, 5%, 18%, 40%

Most goods previously at 12% moved to 5% or 18%; most at 28% moved to 18%.
The new 40% slab carries sin and luxury goods (pan masala, tobacco, sugared
beverages, high-performance vehicles). Niche rates for precious metals (3%)
and diamonds (0.25%) were left untouched.

Both structures are configured below so a founder can compute a corrected
invoice for a pre-reform period. `DEFAULT_RATE_STRUCTURE` selects the current
one.

--------------------------------------------------------------------------
SOURCES (verified 2026-09)
--------------------------------------------------------------------------
  * GST 2.0 slabs and effective date ....... cleartax.in/s/gst-rates
                                             cashfree.com/blog/new-gst-rates
  * CGST / SGST / IGST split rules ......... CGST Act 2017, IGST Act 2017
  * Reverse calculation formula ............ cleartax.in/s/reverse-gst-calculator
  * Composition scheme rates and limits .... CGST Act S.10, busy.in, bajajfinserv.in
  * Rounding of tax ........................ CGST Act S.170
  * Registration thresholds ................ CGST Act S.22

--------------------------------------------------------------------------
A NOTE ON WHAT THIS CALCULATOR DOES NOT DO
--------------------------------------------------------------------------
It computes tax on values the founder supplies. It does not classify goods:
picking the right rate for an HSN/SAC code is a legal judgement that depends
on the product, and guessing it would be worse than asking. The rate is always
an explicit input, never inferred.
"""

from datetime import date, datetime
from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Rate structures
# ---------------------------------------------------------------------------
DEFAULT_RATE_STRUCTURE = "gst_2_0"

RATE_STRUCTURES: Dict[str, Dict[str, Any]] = {
    "gst_2_0": {
        "label": "GST 2.0 (from 22 Sep 2025)",
        "effective_from": "2025-09-22",
        "note": "Current structure. The 12% and 28% slabs were withdrawn and their items redistributed.",
        "off_slab_warning": ("{rates} is not a slab in GST 2.0. The arithmetic is still correct, but check the "
                             "rate — 12% and 28% were withdrawn on 22 September 2025. If this invoice predates "
                             "that, set the invoice date or choose the pre-reform structure."),
        "slabs": [
            {"rate": 0.0, "label": "0% — Nil rated",
             "examples": "Unbranded food grains, fresh produce, most life-saving drugs, educational material, individual life and health insurance."},
            {"rate": 0.25, "label": "0.25% — Diamonds",
             "examples": "Rough and semi-processed diamonds."},
            {"rate": 3.0, "label": "3% — Precious metals",
             "examples": "Gold, silver, platinum, jewellery."},
            {"rate": 5.0, "label": "5% — Essentials",
             "examples": "Packaged food, agricultural inputs, healthcare equipment, small restaurants, economy transport."},
            {"rate": 18.0, "label": "18% — Standard",
             "examples": "Most goods and services. Software, SaaS, consulting, professional fees, electronics, appliances."},
            {"rate": 40.0, "label": "40% — Sin and luxury",
             "examples": "Pan masala, tobacco, sugared beverages, high-performance vehicles, betting and gambling."},
        ],
    },
    "pre_gst_2_0": {
        "label": "Pre-reform (before 22 Sep 2025)",
        "effective_from": "2017-07-01",
        "note": "Historic structure. Use only to recompute an invoice raised before 22 September 2025.",
        "off_slab_warning": ("{rates} is not a slab in the pre-reform structure. The arithmetic is still "
                             "correct, but check the rate — the 40% slab only exists from 22 September 2025."),
        "slabs": [
            {"rate": 0.0, "label": "0% — Nil rated", "examples": "Essential goods."},
            {"rate": 0.25, "label": "0.25% — Diamonds", "examples": "Rough diamonds."},
            {"rate": 3.0, "label": "3% — Precious metals", "examples": "Gold, silver, jewellery."},
            {"rate": 5.0, "label": "5%", "examples": "Essentials, transport."},
            {"rate": 12.0, "label": "12% (withdrawn)", "examples": "Processed food, business-class air travel."},
            {"rate": 18.0, "label": "18% — Standard", "examples": "Most goods and services."},
            {"rate": 28.0, "label": "28% (withdrawn)", "examples": "Luxury goods, cars, tobacco."},
        ],
    },
}

#: The rate most startups on this product actually charge — services default.
DEFAULT_RATE = 18.0


def get_rate_structure(key: Optional[str] = None) -> Dict[str, Any]:
    return RATE_STRUCTURES.get(key or DEFAULT_RATE_STRUCTURE, RATE_STRUCTURES[DEFAULT_RATE_STRUCTURE])


def valid_rates(structure_key: Optional[str] = None) -> List[float]:
    return [s["rate"] for s in get_rate_structure(structure_key)["slabs"]]


def structure_for_date(on: date) -> str:
    """The rate structure in force on a date: the latest one whose
    `effective_from` is on or before it. Driven entirely by the dates above, so
    a future Council change is a new entry here and nothing else."""
    in_force = [
        (datetime.strptime(v["effective_from"], "%Y-%m-%d").date(), k)
        for k, v in RATE_STRUCTURES.items()
        if datetime.strptime(v["effective_from"], "%Y-%m-%d").date() <= on
    ]
    if not in_force:
        return min(RATE_STRUCTURES, key=lambda k: RATE_STRUCTURES[k]["effective_from"])
    return max(in_force)[1]


# ---------------------------------------------------------------------------
# Request limits. Enforced by the router; kept here so the UI and the API
# agree on them.
# ---------------------------------------------------------------------------
MAX_LINES = 200
MAX_RATE_PCT = 100.0
MAX_CESS_RATE_PCT = 300.0


# ---------------------------------------------------------------------------
# Supply type — decides how the tax splits between the Centre and the State.
#
# The total tax is identical either way; only the heads differ. Getting this
# wrong on a real invoice is one of the most common GST errors, which is why
# the calculator makes it an explicit choice rather than a default.
# ---------------------------------------------------------------------------
SUPPLY_TYPES: Dict[str, Dict[str, Any]] = {
    "intra_state": {
        "label": "Intra-state (same state)",
        "group": "Domestic",
        "description": "Supplier and place of supply are in the same state. Tax splits equally into CGST and SGST/UTGST.",
        "heads": ["cgst", "sgst"],
        "split": 0.5,
        "taxable": True,
        "zero_rated": False,
        "credit_allowed": True,
        "note": "",
    },
    "inter_state": {
        "label": "Inter-state (different states)",
        "group": "Domestic",
        "description": "Supplier and place of supply are in different states. The whole tax is IGST.",
        "heads": ["igst"],
        "split": 1.0,
        "taxable": True,
        "zero_rated": False,
        "credit_allowed": True,
        "note": "",
    },
    "export_lut": {
        "label": "Export under LUT (no tax)",
        "group": "Zero-rated",
        "description": "Export of goods or services under a Letter of Undertaking. Zero-rated, so no tax is charged.",
        "heads": [],
        "split": 0.0,
        "taxable": False,
        "zero_rated": True,
        "credit_allowed": True,
        "note": "File RFD-11 before exporting. You keep input tax credit and can claim a refund of "
                "unutilised credit - zero-rated is not the same as exempt.",
    },
    "export_igst": {
        "label": "Export with payment of IGST (refundable)",
        "group": "Zero-rated",
        "description": "Export on payment of IGST, reclaimed later as a refund. Zero-rated but tax is charged up front.",
        "heads": ["igst"],
        "split": 1.0,
        "taxable": True,
        "zero_rated": True,
        "credit_allowed": True,
        "note": "The IGST charged here is refundable. Your working capital is tied up until the "
                "refund is processed - the LUT route avoids that.",
    },
    "sez_lut": {
        "label": "Supply to SEZ under LUT (no tax)",
        "group": "Zero-rated",
        "description": "Supply to a Special Economic Zone unit or developer under LUT. Treated as zero-rated.",
        "heads": [],
        "split": 0.0,
        "taxable": False,
        "zero_rated": True,
        "credit_allowed": True,
        "note": "Treated on the same footing as an export.",
    },
    "sez_igst": {
        "label": "Supply to SEZ with payment of IGST",
        "group": "Zero-rated",
        "description": "Supply to an SEZ on payment of IGST, reclaimed as a refund.",
        "heads": ["igst"],
        "split": 1.0,
        "taxable": True,
        "zero_rated": True,
        "credit_allowed": True,
        "note": "Refundable, like the export-with-payment route.",
    },
    "nil_rated": {
        "label": "Nil rated",
        "group": "No tax",
        "description": "Goods or services taxed at 0% under the schedule.",
        "heads": [],
        "split": 0.0,
        "taxable": False,
        "zero_rated": False,
        "credit_allowed": False,
        "note": "No tax is charged and no input credit is available on inputs used for these supplies.",
    },
    "exempt": {
        "label": "Exempt supply",
        "group": "No tax",
        "description": "Supplies exempted by notification, such as most healthcare and education.",
        "heads": [],
        "split": 0.0,
        "taxable": False,
        "zero_rated": False,
        "credit_allowed": False,
        "note": "Input tax credit attributable to exempt supplies must be reversed under Rules 42 and 43. "
                "That is the practical difference between exempt and zero-rated.",
    },
    "non_gst": {
        "label": "Non-GST supply",
        "group": "No tax",
        "description": "Outside the scope of GST altogether - petrol, diesel, alcohol for human consumption.",
        "heads": [],
        "split": 0.0,
        "taxable": False,
        "zero_rated": False,
        "credit_allowed": False,
        "note": "",
    },
    "import_services": {
        "label": "Import of services (reverse charge)",
        "group": "Reverse charge",
        "description": "Services received from a supplier outside India. You pay the IGST yourself under reverse charge.",
        "heads": ["igst"],
        "split": 1.0,
        "taxable": True,
        "zero_rated": False,
        "credit_allowed": True,
        "force_rcm": True,
        "note": "Covers most foreign SaaS. Pay the tax in cash, then claim it back as input credit - "
                "cash-flow negative in the month it falls due, neutral over time.",
    },
}

DEFAULT_SUPPLY_TYPE = "intra_state"

HEAD_LABELS = {
    "cgst": "CGST (Central)",
    "sgst": "SGST / UTGST (State)",
    "igst": "IGST (Integrated)",
    "cess": "Compensation Cess",
}


# ---------------------------------------------------------------------------
# Calculation direction.
#
# "exclusive" — the amount entered is the taxable value; tax is added on top.
# "inclusive" — the amount entered already contains tax; the taxable value is
#               extracted out of it. This is the "reverse GST" every online
#               calculator offers, and the formula is:
#
#                   Taxable Value = Amount x 100 / (100 + rate + cess rate)
#
#               Cess must sit inside the divisor, or the extracted base is
#               wrong for any item that carries cess.
# ---------------------------------------------------------------------------
CALC_MODES: Dict[str, Dict[str, str]] = {
    "exclusive": {
        "label": "Add GST",
        "description": "The amount you enter is the pre-tax value. GST is added on top.",
        "formula": "GST = Taxable Value x Rate / 100; Total = Taxable Value + GST",
    },
    "inclusive": {
        "label": "Remove GST (reverse)",
        "description": "The amount you enter already includes GST. The taxable value is extracted out of it.",
        "formula": "Taxable Value = Amount x 100 / (100 + Rate + Cess Rate); GST = Amount - Taxable Value - Cess",
    },
}

DEFAULT_CALC_MODE = "exclusive"


# ---------------------------------------------------------------------------
# Composition scheme (CGST Act S.10).
#
# A flat percentage of turnover instead of regular GST. No input tax credit,
# no tax invoice, and a registered buyer cannot claim credit on the purchase —
# which is usually the deciding factor for a B2B startup.
# ---------------------------------------------------------------------------
COMPOSITION_CATEGORIES: List[Dict[str, Any]] = [
    {
        "key": "manufacturer_trader",
        "label": "Manufacturer or trader",
        "rate": 1.0,
        "split": "0.5% CGST + 0.5% SGST",
        "turnover_limit": 15000000.0,
        "note": "Rs.1.5 crore turnover limit in most states; Rs.75 lakh in special category states.",
    },
    {
        "key": "restaurant",
        "label": "Restaurant (not serving alcohol)",
        "rate": 5.0,
        "split": "2.5% CGST + 2.5% SGST",
        "turnover_limit": 15000000.0,
        "note": "Rs.1.5 crore turnover limit.",
    },
    {
        "key": "service_provider",
        "label": "Service provider (S.10(2A))",
        "rate": 6.0,
        "split": "3% CGST + 3% SGST",
        "turnover_limit": 5000000.0,
        "note": "Rs.50 lakh turnover limit. This is the one most service startups would fall under.",
    },
]

COMPOSITION_RESTRICTIONS: List[str] = [
    "You cannot claim input tax credit on any purchase.",
    "You cannot issue a tax invoice, so your registered buyers cannot claim credit either.",
    "You cannot make inter-state outward supplies.",
    "You cannot supply through an e-commerce operator that collects tax at source.",
    "You must file CMP-08 quarterly and GSTR-4 annually.",
    "The tax is paid out of your own pocket — it cannot be collected from the customer.",
]


# ---------------------------------------------------------------------------
# Registration thresholds (CGST Act S.22).
# ---------------------------------------------------------------------------
REGISTRATION_THRESHOLDS: Dict[str, Dict[str, Any]] = {
    "services": {
        "label": "Services",
        "normal": 2000000.0,
        "special_category": 1000000.0,
        "note": "Rs.20 lakh in most states, Rs.10 lakh in special category states.",
    },
    "goods": {
        "label": "Goods",
        "normal": 4000000.0,
        "special_category": 2000000.0,
        "note": "Rs.40 lakh in most states, Rs.20 lakh in special category states.",
    },
}


# ---------------------------------------------------------------------------
# Reverse charge mechanism (S.9(3) / S.9(4) CGST, S.5 IGST).
#
# The recipient pays the tax instead of the supplier. The calculator models it
# because a startup buying from an unregistered vendor, importing services, or
# paying a goods-transport agency owes this and frequently misses it.
# ---------------------------------------------------------------------------
RCM_COMMON_CASES: List[str] = [
    "Services imported from a supplier outside India, including most foreign SaaS.",
    "Goods transport agency (GTA) services.",
    "Legal services from an advocate or a firm of advocates.",
    "Sponsorship services.",
    "Director's remuneration paid other than as salary.",
    "Renting of motor vehicles from a non-body-corporate supplier.",
]

#: Who owes reverse-charge tax depends on which side of the supply you are on.
#:   outward — a line on YOUR invoice flagged reverse charge: your customer pays
#:             the tax to the government; you invoice the value only.
#:   inward  — you RECEIVE the supply (import of services): you pay the tax in
#:             cash and claim it back as credit.
RCM_PAYER_NOTES: Dict[str, Dict[str, str]] = {
    "recipient": {
        "line": "Reverse charge — your customer pays this tax to the government, not you. The line is invoiced at value only.",
        "totals": "Reverse charge (payable by your customer)",
        "net": "Reverse-charge lines on this invoice are your customer's liability, so they are not in your net payable.",
    },
    "you": {
        "line": "You pay this tax yourself under reverse charge, then claim it back as credit.",
        "totals": "Reverse charge (payable by you)",
        "net": ("Net payable includes reverse-charge tax, which must be paid in cash and cannot be "
                "discharged using input tax credit. You can claim it back as credit afterwards."),
    },
}

RCM_NOTE = (
    "Under reverse charge the supplier does not collect the tax — you pay it directly to the "
    "government and then claim it back as input tax credit in the same or a later period, provided "
    "the supply is used for business. It is cash-flow neutral over time but not in the month it falls due."
)


# ---------------------------------------------------------------------------
# Rounding.
#
# S.170 of the CGST Act requires tax to be rounded to the nearest rupee. Line
# components are held at two decimals for arithmetic and the invoice total is
# rounded once at the end, which is how billing software behaves — rounding
# each line to the rupee first accumulates error across a long invoice.
# ---------------------------------------------------------------------------
COMPONENT_DECIMALS = 2
ROUND_INVOICE_TO_RUPEE = True
ROUNDING_NOTE = (
    "Tax is rounded to the nearest rupee at the invoice level, as required by Section 170 of the "
    "CGST Act. Individual line components are kept at two decimals so rounding is applied once "
    "rather than accumulating across lines."
)


# ---------------------------------------------------------------------------
# Scheme and compliance applicability, driven by aggregate annual turnover.
# ---------------------------------------------------------------------------
APPLICABILITY_RULES: List[Dict[str, Any]] = [
    {
        "id": "einvoice",
        "label": "E-invoicing",
        "threshold": 50000000.0,
        "direction": "above",
        "sticky": True,
        "applies_note": "Mandatory. E-invoices must be reported to the IRP for B2B, export, SEZ and "
                        "deemed-export supplies before they are issued.",
        "exempt_note": "Not mandatory at your turnover.",
        "detail": "The threshold has been Rs.5 crore since 1 August 2023, and it bites if you crossed "
                  "it in ANY financial year from 2017-18 onwards. The obligation is sticky - once you "
                  "cross it, it continues even if turnover later falls back below.",
    },
    {
        "id": "qrmp",
        "label": "QRMP scheme",
        "threshold": 50000000.0,
        "direction": "at_or_below",
        "sticky": False,
        "applies_note": "Eligible. You may file GSTR-1 and GSTR-3B quarterly while paying tax monthly "
                        "through form PMT-06.",
        "exempt_note": "Not eligible - turnover is above Rs.5 crore, so returns are monthly.",
        "detail": "Quarterly Return, Monthly Payment. Available to taxpayers with aggregate turnover up "
                  "to Rs.5 crore who are up to date on GSTR-3B. Not available to composition dealers, "
                  "non-resident or casual taxable persons, or input service distributors.",
    },
    {
        "id": "hsn_six_digit",
        "label": "Six-digit HSN on invoices",
        "threshold": 50000000.0,
        "direction": "above",
        "sticky": False,
        "applies_note": "Six-digit HSN or SAC codes are required on your tax invoices.",
        "exempt_note": "Four-digit HSN or SAC codes are sufficient for B2B invoices at your turnover.",
        "detail": "Exports always require the full eight digits on shipping bills and export invoices, "
                  "whatever your turnover.",
    },
]

#: E-way bill is consignment-value based rather than turnover based.
EWAY_BILL_THRESHOLD = 50000.0
EWAY_BILL_NOTE = (
    "An e-way bill is required for movement of goods worth more than Rs.50,000, inter-state or "
    "intra-state. States may set their own higher limits for movement within the state. It does not "
    "apply to a pure supply of services."
)

# ---------------------------------------------------------------------------
# Disclaimer attached to every response.
# ---------------------------------------------------------------------------
DISCLAIMER = (
    "This calculator computes GST on the values and rates you supply. It does not classify goods or "
    "services — choosing the correct rate for an HSN or SAC code is a legal judgement that depends on "
    "the item, and this tool will not guess it for you. Figures are for working and planning purposes, "
    "are not a return, and must not be filed. Confirm the rate and treatment with your chartered "
    "accountant."
)
