"""
Reference data for the Startup GST Calculator.

Split from `gst_config.py` so the rate/rule engine stays readable: this module
holds the lookup tables and the human-facing copy — state codes, PAN entity
types, a curated HSN/SAC catalogue, per-field help text and the filing guide.

`config/tax_config.py` keeps FIELD_GUIDANCE and FILING_GUIDES in the same file
as its rates; that file is already 1,100 lines, so the two concerns are
separated here rather than repeating that.

--------------------------------------------------------------------------
SOURCES (verified 2026-09)
--------------------------------------------------------------------------
  * GSTIN structure and Luhn mod 36 check digit .. cleartax.in/s/know-your-gstin
                                                   en.wikipedia.org/wiki/Luhn_mod_N_algorithm
  * State codes ................................. GST Council state code list
  * PAN 4th-character entity types .............. Income Tax Department
  * SAC codes for services ...................... CBIC service accounting codes
  * HSN lookup behaviour ........................ cleartax.in/s/gst-hsn-lookup
"""

from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# GSTIN state codes (first two digits).
# ---------------------------------------------------------------------------
STATE_CODES: Dict[str, str] = {
    "01": "Jammu & Kashmir", "02": "Himachal Pradesh", "03": "Punjab",
    "04": "Chandigarh", "05": "Uttarakhand", "06": "Haryana", "07": "Delhi",
    "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
    "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur",
    "15": "Mizoram", "16": "Tripura", "17": "Meghalaya", "18": "Assam",
    "19": "West Bengal", "20": "Jharkhand", "21": "Odisha",
    "22": "Chhattisgarh", "23": "Madhya Pradesh", "24": "Gujarat",
    "25": "Daman & Diu (merged into 26)",
    "26": "Dadra & Nagar Haveli and Daman & Diu",
    "27": "Maharashtra", "28": "Andhra Pradesh (pre-bifurcation)",
    "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala",
    "33": "Tamil Nadu", "34": "Puducherry", "35": "Andaman & Nicobar Islands",
    "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh",
    "97": "Other Territory", "99": "Centre Jurisdiction",
}

#: States with the lower registration threshold (Rs.10 lakh services /
#: Rs.20 lakh goods) under S.22 CGST Act.
SPECIAL_CATEGORY_STATE_CODES = {
    "12",  # Arunachal Pradesh
    "14",  # Manipur
    "17",  # Meghalaya
    "15",  # Mizoram
    "13",  # Nagaland
    "11",  # Sikkim
    "16",  # Tripura
    "05",  # Uttarakhand
    "34",  # Puducherry
    "36",  # Telangana
}

# ---------------------------------------------------------------------------
# PAN 4th character — the entity type embedded inside every GSTIN.
# ---------------------------------------------------------------------------
PAN_ENTITY_TYPES: Dict[str, str] = {
    "A": "Association of Persons (AOP)",
    "B": "Body of Individuals (BOI)",
    "C": "Company",
    "F": "Firm or LLP",
    "G": "Government",
    "H": "Hindu Undivided Family",
    "J": "Artificial Juridical Person",
    "L": "Local Authority",
    "P": "Individual",
    "T": "Trust",
}

#: 14th character. 'Z' is the default for an ordinary taxpayer; anything else
#: signals a special registration class. Reported as informational rather than
#: as a hard rule, because the non-Z classes are not uniformly documented.
DEFAULT_REGISTRATION_CHAR = "Z"

# ---------------------------------------------------------------------------
# HSN / SAC catalogue.
#
# Deliberately SMALL and startup-focused. This is a convenience lookup, not the
# notified schedule — the full list runs to thousands of entries and picking
# the right one is a legal judgement about the product. Every entry is marked
# with the rate that ordinarily applies, and the UI states that classification
# remains the founder's call.
# ---------------------------------------------------------------------------
HSN_SAC_CATALOGUE: List[Dict[str, Any]] = [
    # --- Services (SAC, chapter 99) ---
    {"code": "997331", "kind": "SAC", "rate": 18.0,
     "label": "Licensing services for the right to use computer software",
     "note": "The usual code for SaaS and software subscriptions."},
    {"code": "998313", "kind": "SAC", "rate": 18.0,
     "label": "Information technology consulting and support services",
     "note": "IT consulting, implementation and support."},
    {"code": "998314", "kind": "SAC", "rate": 18.0,
     "label": "Information technology design and development services",
     "note": "Custom software development and design work."},
    {"code": "998311", "kind": "SAC", "rate": 18.0,
     "label": "Management consulting and management services",
     "note": "General business and management consulting."},
    {"code": "998312", "kind": "SAC", "rate": 18.0,
     "label": "Business consulting services",
     "note": "Strategy, operations and business advisory."},
    {"code": "998365", "kind": "SAC", "rate": 18.0,
     "label": "Advertising and related services",
     "note": "Agency work, campaign management, media buying."},
    {"code": "998221", "kind": "SAC", "rate": 18.0,
     "label": "Accounting and bookkeeping services",
     "note": "Accounting, bookkeeping and auditing."},
    {"code": "998211", "kind": "SAC", "rate": 18.0,
     "label": "Legal advisory and representation services",
     "note": "Legal services from a firm. Advocate services to a business are reverse charge."},
    {"code": "997212", "kind": "SAC", "rate": 18.0,
     "label": "Rental or leasing of non-residential property",
     "note": "Commercial office rent."},
    {"code": "998519", "kind": "SAC", "rate": 18.0,
     "label": "Other employment and labour supply services",
     "note": "Staffing and contract manpower."},
    {"code": "996812", "kind": "SAC", "rate": 18.0,
     "label": "Courier services",
     "note": "Courier and express delivery."},
    {"code": "996511", "kind": "SAC", "rate": 5.0,
     "label": "Road transport of goods",
     "note": "Goods transport agency services are commonly reverse charge for the recipient."},
    {"code": "996331", "kind": "SAC", "rate": 5.0,
     "label": "Restaurant and catering services",
     "note": "Restaurant service without input tax credit."},
    {"code": "997212", "kind": "SAC", "rate": 0.0,
     "label": "Renting of residential dwelling for residence",
     "note": "Exempt when let to an unregistered person for residential use."},

    # --- Goods (HSN) ---
    {"code": "8471", "kind": "HSN", "rate": 18.0,
     "label": "Computers, laptops and automatic data-processing machines",
     "note": "Hardware purchases; input tax credit is ordinarily available."},
    {"code": "8517", "kind": "HSN", "rate": 18.0,
     "label": "Telephones, smartphones and communication apparatus",
     "note": ""},
    {"code": "4820", "kind": "HSN", "rate": 18.0,
     "label": "Registers, notebooks and office stationery",
     "note": ""},
    {"code": "9403", "kind": "HSN", "rate": 18.0,
     "label": "Office furniture",
     "note": ""},
    {"code": "2106", "kind": "HSN", "rate": 5.0,
     "label": "Food preparations not elsewhere specified",
     "note": "Rate varies sharply by product — verify before use."},
    {"code": "3004", "kind": "HSN", "rate": 5.0,
     "label": "Medicaments",
     "note": "Several life-saving drugs are nil-rated."},
    {"code": "2402", "kind": "HSN", "rate": 40.0,
     "label": "Cigarettes and tobacco products",
     "note": "Sin goods, plus compensation cess."},
]

HSN_SAC_DISCLAIMER = (
    "This is a short convenience list of codes startups commonly use, not the notified schedule. "
    "Classification determines the rate and is a legal judgement about your specific product or "
    "service — confirm the code with your chartered accountant before relying on it."
)

# ---------------------------------------------------------------------------
# Per-field help.
#
# Rendered as the same inline "?" tooltip the Tax Calculator uses
# (`renderFieldHelp` in twin-app/js/tax.js). Keys match the DOM ids in the GST
# view, so adding a field means adding an entry here and nothing else.
# ---------------------------------------------------------------------------
FIELD_GUIDANCE: Dict[str, str] = {
    "gstMode": (
        "Add GST treats the amount you type as the pre-tax value and adds tax on top. "
        "Remove GST treats it as already containing tax and extracts the taxable value out of it — "
        "use this when you are working back from an amount that hit your bank."
    ),
    "gstSupply": (
        "Decides how the same total tax is split. Same state means CGST plus SGST in equal halves; "
        "different states means the whole amount as IGST. Exports and SEZ supplies are zero-rated, "
        "and imported services shift the liability to you under reverse charge."
    ),
    "gstStructure": (
        "GST 2.0 took effect on 22 September 2025 and withdrew the 12% and 28% slabs. "
        "Choose the pre-reform structure only to recompute an invoice raised before that date."
    ),
    "gstLines": (
        "One row per line of the invoice. Quantity multiplies the amount; discount is deducted "
        "before tax is computed, which is how a trade discount shown on the face of an invoice works."
    ),
    "lineDescription": (
        "What you are supplying, as it should read on the invoice. It is for your reference and the saved "
        "working set only — it does not change the tax."
    ),
    "lineHsn": (
        "The HSN code (goods) or SAC code (services) for this line. Invoices need 4 digits up to Rs.5 crore "
        "turnover and 6 digits above that; exports need 8. Use the HSN / SAC finder below to look one up, "
        "but the rate is still yours to confirm."
    ),
    "lineQty": (
        "Number of units. The amount is multiplied by this before any discount. Leave it at 1 for a single "
        "service or a lump-sum line."
    ),
    "lineAmount": (
        "Price per unit. With Add GST it is the value before tax; with Remove GST it is the tax-inclusive "
        "price, and the taxable value is worked back out of it."
    ),
    "lineDiscount": (
        "Discount on this line, in rupees, deducted before tax is worked out — the way a discount shown on "
        "the face of the invoice works. A discount given later through a credit note does not belong here."
    ),
    "lineRate": (
        "The rate for this line's HSN or SAC code. This calculator will not guess it — classification "
        "depends on what you actually supply and getting it wrong is a legal exposure, not a rounding error."
    ),
    "lineCess": (
        "Compensation cess, charged on top of GST for a small set of sin and luxury goods. "
        "Leave it at zero unless you know your product attracts it."
    ),
    "lineRcm": (
        "Tick when this supply falls under reverse charge — for example goods transport agency, advocate "
        "or sponsorship services. On your own invoice the line is raised at value only and your customer "
        "pays the tax to the government. For services you import, choose \"Import of services\" as the "
        "supply type instead; then you pay the tax."
    ),
    "gstItc": (
        "Total input tax credit available for the period: the GST you already paid your own suppliers "
        "on business purchases. It is netted off your output tax to give the amount actually payable."
    ),
    "gstComposition": (
        "The composition scheme charges a flat percentage of turnover instead of regular GST, but you "
        "lose input credit and cannot issue a tax invoice. For a B2B company that usually costs more "
        "than the tax saved, because your customers lose their credit too."
    ),
    "gstTurnover": (
        "Aggregate annual turnover on your PAN, across all states. Drives the composition limit, the "
        "registration threshold, and whether e-invoicing and QRMP apply."
    ),
    "gstBusinessType": (
        "Goods and services have different registration thresholds — Rs.40 lakh for goods, "
        "Rs.20 lakh for services, halved in special category states."
    ),
    "gstSpecialState": (
        "Special category states have lower registration thresholds. They include the north-eastern "
        "states, Himachal Pradesh, Uttarakhand, Puducherry and Telangana."
    ),
    "gstGstinInput": (
        "Enter any 15-character GSTIN to decode it. The check digit is verified with the Luhn mod 36 "
        "algorithm, so a typo or an invented number is caught — though a valid check digit only proves "
        "the number is well-formed, not that it is registered and active."
    ),
    "gstEinvoice": (
        "E-invoicing is mandatory once aggregate turnover crosses Rs.5 crore in ANY financial year "
        "from 2017-18 onwards. The obligation is sticky: once you cross, it continues even if turnover "
        "later falls back below the threshold."
    ),
}

# ---------------------------------------------------------------------------
# Filing guide.
#
# Same shape as `tax_config.FILING_GUIDES` so the frontend can render it with
# the identical stepper component.
# ---------------------------------------------------------------------------
FILING_GUIDES: List[Dict[str, Any]] = [
    {
        "id": "monthly_gst",
        "title": "Filing your monthly GST returns",
        "intro": (
            "The regular monthly cycle for a normal taxpayer. If you are on QRMP you file GSTR-1 and "
            "GSTR-3B quarterly but still pay tax monthly through form PMT-06."
        ),
        "steps": [
            {
                "title": "Reconcile your outward supplies",
                "body": "Total every invoice raised in the month, grouped by rate. The rate-wise "
                        "summary this calculator produces is the same block GSTR-1 asks for.",
            },
            {
                "title": "Check GSTR-2B for your input credit",
                "body": "GSTR-2B is the auto-drafted statement of credit available to you. Credit not "
                        "appearing there generally cannot be claimed, so chase suppliers who have not "
                        "filed rather than claiming it anyway.",
            },
            {
                "title": "File GSTR-1 by the 11th",
                "body": "The statement of outward supplies for the previous month. This is what "
                        "populates your customers' GSTR-2B, so filing late blocks their credit.",
            },
            {
                "title": "Pay and file GSTR-3B by the 20th",
                "body": "The summary return. Net tax payable is output tax less eligible input credit, "
                        "plus any reverse-charge tax — which must be paid in cash and cannot be "
                        "discharged with credit.",
            },
            {
                "title": "Reconcile before the annual return",
                "body": "Differences between GSTR-1, GSTR-3B and your books are the single biggest "
                        "source of GST notices. Fix them during the year, not at GSTR-9 time.",
            },
        ],
    },
    {
        "id": "exports",
        "title": "Exporting without paying tax",
        "intro": (
            "Exports and supplies to an SEZ are zero-rated. You have two routes, and the choice is "
            "mostly about cash flow."
        ),
        "steps": [
            {
                "title": "Route 1 — file a Letter of Undertaking (LUT)",
                "body": "File form RFD-11 at the start of the financial year. You then export without "
                        "charging IGST at all. No refund to chase, so no working capital is tied up. "
                        "This is what most software exporters do.",
            },
            {
                "title": "Route 2 — export on payment of IGST",
                "body": "Charge IGST, pay it, then claim it back as a refund. Your money sits with the "
                        "government until the refund is processed. Useful if you have accumulated "
                        "credit you want to liquidate.",
            },
            {
                "title": "Keep your input credit either way",
                "body": "Zero-rated is not the same as exempt. Under either route you keep the input "
                        "tax credit on your purchases and can claim a refund of unutilised credit.",
            },
            {
                "title": "Quote the full HSN on export documents",
                "body": "All eight digits of the HSN code are required on shipping bills and export "
                        "invoices, regardless of your turnover.",
            },
        ],
    },
]
