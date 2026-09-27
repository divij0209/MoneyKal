"""
Deterministic GST calculation engine for the Startup journey.

Plain arithmetic over the rates in `config/gst_config.py`. No LLM is involved,
in keeping with the rest of the Startup engine — a tax figure produced by a
language model is not a tax figure.

WHAT IT COMPUTES
----------------
  * Forward ("add GST") and reverse ("remove GST") on any number of lines.
  * The CGST/SGST versus IGST split, from the supply type.
  * Compensation cess, correctly placed inside the divisor when reversing.
  * Rate-wise summary — the block at the foot of a real tax invoice.
  * Reverse-charge lines, kept out of output tax and shown as a separate
    payable, because the supplier collects nothing on them.
  * Net payable after input tax credit, including credit carried forward.
  * A composition-scheme comparison, with the restrictions that usually decide
    it for a B2B company.
  * A registration-threshold check.

WHAT IT DELIBERATELY DOES NOT DO
--------------------------------
Classify goods or services. Picking the rate for an HSN/SAC code is a legal
judgement about the item, and a wrong guess presented confidently is worse
than an explicit input. The rate is always supplied by the caller.
"""

from datetime import date, datetime
from typing import Any, Dict, List, Optional

from backend.core.config import gst_config as cfg
from backend.core.config import gst_reference as ref
from backend.schemas.gst_models import (
    ApplicabilityResult,
    CompositionComparison,
    GSTCalculateRequest,
    GSTCalculateResponse,
    GSTLineInput,
    GSTLineResult,
    GSTNetPosition,
    GSTRateSlabSummary,
    GSTINCheck,
    GSTTotals,
    RegistrationCheck,
    SupplyTypeDetail,
)

CURRENCY = "₹"


def _r(value: float, places: int = cfg.COMPONENT_DECIMALS) -> float:
    """Round half-up rather than banker's rounding.

    Python's built-in round() sends 2.5 to 2, which is not what a tax
    computation is expected to do and produces off-by-a-rupee disputes.
    """
    if value is None:
        return 0.0
    factor = 10 ** places
    shifted = value * factor
    # A tiny epsilon absorbs binary-float representation error so values like
    # 2.675 (stored as 2.67499...) still round up as a person would expect.
    return int(shifted + (0.5 if shifted >= 0 else -0.5) + (1e-9 if shifted >= 0 else -1e-9)) / factor


def parse_invoice_date(raw: Optional[str]) -> Optional[date]:
    """YYYY-MM-DD, or None. The router rejects a malformed value before here."""
    if not raw:
        return None
    try:
        return datetime.strptime(str(raw).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Per-line computation
# ---------------------------------------------------------------------------

def rcm_payer(supply: Dict[str, Any]) -> str:
    """Who owes reverse-charge tax for this supply type.

    Only an inward supply the startup receives (import of services) makes the
    startup the payer. A line flagged reverse charge on the startup's own
    invoice is the customer's liability — the supplier invoices value only.
    """
    return "you" if supply.get("force_rcm") else "recipient"


def _compute_line(line: GSTLineInput, mode: str, supply: Dict[str, Any]) -> GSTLineResult:
    qty = line.quantity if line.quantity and line.quantity > 0 else 1.0
    rate = max(line.rate or 0.0, 0.0)
    cess_rate = max(line.cess_rate or 0.0, 0.0)
    gross = (line.amount or 0.0) * qty
    discount = min(max(line.discount or 0.0, 0.0), abs(gross))
    net = gross - discount

    if mode == "inclusive":
        # Reverse: the entered amount already contains tax AND cess, so both
        # rates belong in the divisor. Leaving cess out here is the classic
        # error that makes an extracted base too high.
        divisor = 100.0 + rate + cess_rate
        taxable = net * 100.0 / divisor if divisor else net
    else:
        taxable = net

    # A supply type that is not taxable (export under LUT, SEZ under LUT, nil,
    # exempt, non-GST) carries no tax at all, whatever rate was entered. The
    # rate is still echoed back so the founder can see what was overridden.
    if not supply.get("taxable", True):
        return GSTLineResult(
            description=line.description, hsn_sac=line.hsn_sac, quantity=qty,
            rate=rate, cess_rate=cess_rate,
            gross=_r(gross), discount=_r(discount), taxable_value=_r(taxable),
            cgst=0.0, sgst=0.0, igst=0.0, cess=0.0, total_tax=0.0, total=_r(taxable),
            reverse_charge=False,
            note=f"{supply['label']} - no tax is charged on this line.",
        )

    tax = taxable * rate / 100.0
    cess = taxable * cess_rate / 100.0

    # Import of services is reverse charge by definition; the caller need not
    # tick the box for every line.
    is_rcm = bool(line.reverse_charge) or bool(supply.get("force_rcm"))

    cgst = sgst = igst = 0.0
    note = None
    if is_rcm:
        # The line is raised at value only. The tax is still computed so whoever
        # owes it knows the figure, but it is reported separately and never
        # lands in output tax.
        note = cfg.RCM_PAYER_NOTES[rcm_payer(supply)]["line"]
    elif "igst" in supply["heads"]:
        igst = tax
    else:
        cgst = tax * supply["split"]
        sgst = tax * supply["split"]

    total_tax = cgst + sgst + igst + (0.0 if is_rcm else cess)
    total = taxable + total_tax

    return GSTLineResult(
        description=line.description,
        hsn_sac=line.hsn_sac,
        quantity=qty,
        rate=rate,
        cess_rate=cess_rate,
        gross=_r(gross),
        discount=_r(discount),
        taxable_value=_r(taxable),
        cgst=_r(cgst),
        sgst=_r(sgst),
        igst=_r(igst),
        cess=_r(0.0 if is_rcm else cess),
        total_tax=_r(total_tax),
        total=_r(total),
        reverse_charge=is_rcm,
        note=note,
    )


def _rate_summary(lines: List[GSTLineResult]) -> List[GSTRateSlabSummary]:
    buckets: Dict[float, Dict[str, float]] = {}
    for ln in lines:
        if ln.reverse_charge:
            continue
        b = buckets.setdefault(ln.rate, {"taxable_value": 0.0, "cgst": 0.0, "sgst": 0.0,
                                         "igst": 0.0, "cess": 0.0, "total_tax": 0.0})
        b["taxable_value"] += ln.taxable_value
        b["cgst"] += ln.cgst
        b["sgst"] += ln.sgst
        b["igst"] += ln.igst
        b["cess"] += ln.cess
        b["total_tax"] += ln.total_tax
    return [
        GSTRateSlabSummary(
            rate=rate,
            taxable_value=_r(v["taxable_value"]), cgst=_r(v["cgst"]), sgst=_r(v["sgst"]),
            igst=_r(v["igst"]), cess=_r(v["cess"]), total_tax=_r(v["total_tax"]),
        )
        for rate, v in sorted(buckets.items())
    ]


def _totals(lines: List[GSTLineResult], payer: str) -> GSTTotals:
    normal = [l for l in lines if not l.reverse_charge]
    rcm = [l for l in lines if l.reverse_charge]

    gross = sum(l.gross for l in lines)
    discount = sum(l.discount for l in lines)
    # The invoice's taxable value covers EVERY line. A reverse-charge line is
    # still invoiced — at value, with no tax collected — so its value belongs
    # in the invoice total even though its tax does not.
    taxable = sum(l.taxable_value for l in lines)
    cgst = sum(l.cgst for l in normal)
    sgst = sum(l.sgst for l in normal)
    igst = sum(l.igst for l in normal)
    cess = sum(l.cess for l in normal)
    total_tax = cgst + sgst + igst + cess
    total = taxable + total_tax

    # S.170 rounding, applied once at invoice level, half-up. Python's round()
    # is banker's rounding and would send 324.50 to 324.
    rounded = _r(total, 0) if cfg.ROUND_INVOICE_TO_RUPEE else total

    # RCM tax is recomputed here because _compute_line zeroes the heads on
    # those lines — whoever owes it still needs a number.
    rcm_taxable = sum(l.taxable_value for l in rcm)
    rcm_tax = sum(l.taxable_value * (l.rate + l.cess_rate) / 100.0 for l in rcm)

    return GSTTotals(
        gross=_r(gross), discount=_r(discount), taxable_value=_r(taxable),
        cgst=_r(cgst), sgst=_r(sgst), igst=_r(igst), cess=_r(cess),
        total_tax=_r(total_tax), total=_r(total),
        rounded_total=_r(rounded, 0), rounding_adjustment=_r(rounded - total),
        reverse_charge_taxable=_r(rcm_taxable), reverse_charge_tax=_r(rcm_tax),
        reverse_charge_payable_by=payer,
        reverse_charge_label=cfg.RCM_PAYER_NOTES[payer]["totals"],
    )


def _net_position(totals: GSTTotals, itc: float) -> GSTNetPosition:
    output_tax = totals.total_tax
    itc = max(itc or 0.0, 0.0)
    # Only reverse charge the startup itself owes lands in its payable. RCM on
    # the startup's own outward invoice is the customer's to pay.
    payer = totals.reverse_charge_payable_by
    rcm_payable = totals.reverse_charge_tax if payer == "you" else 0.0

    # RCM is paid in cash and cannot be set off against ITC in the same breath,
    # so it is added to the payable rather than netted into it.
    net = output_tax - itc
    carried = 0.0
    if net < 0:
        carried = -net
        net = 0.0
    net += rcm_payable

    if carried > 0:
        note = (f"Input tax credit exceeds output tax, so nothing is payable on outward supplies and "
                f"{CURRENCY}{carried:,.2f} carries forward to the next period.")
    elif totals.reverse_charge_tax > 0:
        note = cfg.RCM_PAYER_NOTES[payer]["net"]
    else:
        note = "Output tax less input tax credit for the period."

    return GSTNetPosition(
        output_tax=_r(output_tax), input_tax_credit=_r(itc),
        reverse_charge_payable=_r(rcm_payable), net_payable=_r(net),
        credit_carried_forward=_r(carried), note=note,
    )


# ---------------------------------------------------------------------------
# Composition scheme and registration
# ---------------------------------------------------------------------------

def _composition(category_key: str, turnover: float, invoice_taxable: float,
                 invoice_regular_net: float) -> Optional[CompositionComparison]:
    """Compare the two schemes over the SAME base.

    Composition tax is a percentage of annual turnover. The regular position on
    a single invoice is not comparable to that — a year against one invoice —
    so the invoice's regular net tax is projected onto the turnover base,
    preserving both its rate mix and its input-credit ratio. When no separate
    turnover is supplied the two already share a base and no scaling happens.
    """
    entry = next((c for c in cfg.COMPOSITION_CATEGORIES if c["key"] == category_key), None)
    if not entry:
        return None

    eligible = turnover <= entry["turnover_limit"]
    comp_tax = turnover * entry["rate"] / 100.0

    if invoice_taxable > 0 and abs(turnover - invoice_taxable) > 0.01:
        scale = turnover / invoice_taxable
        regular_tax = invoice_regular_net * scale
        basis = (f"Regular tax is projected onto turnover of {CURRENCY}{turnover:,.0f} using this "
                 f"invoice's rate mix and input-credit ratio, so both schemes are compared over the "
                 f"same base.")
    else:
        regular_tax = invoice_regular_net
        basis = "Both schemes are compared over the same taxable value."

    diff = comp_tax - regular_tax

    if not eligible:
        note = (f"Turnover of {CURRENCY}{turnover:,.0f} is above the {CURRENCY}{entry['turnover_limit']:,.0f} "
                f"limit for this category, so the composition scheme is not available.")
    elif diff < 0:
        note = (f"Composition would cost {CURRENCY}{abs(diff):,.0f} less in tax on these figures — but read "
                "the restrictions first. Losing the ability to pass on input credit usually costs a B2B "
                "company more than the tax saved.")
    else:
        note = (f"Composition would cost {CURRENCY}{diff:,.0f} more in tax on these figures, because you "
                "would pay on gross turnover with no input credit.")

    return CompositionComparison(
        eligible=eligible, category=entry["key"], label=entry["label"], rate=entry["rate"],
        split=entry["split"], turnover_limit=entry["turnover_limit"], turnover_used=_r(turnover),
        composition_tax=_r(comp_tax), regular_tax=_r(regular_tax), difference=_r(diff),
        cheaper=("composition" if diff < 0 else "regular"),
        restrictions=cfg.COMPOSITION_RESTRICTIONS, note=note, basis=basis,
    )


def _registration(business_type: str, turnover: float, special: bool) -> RegistrationCheck:
    band = cfg.REGISTRATION_THRESHOLDS.get(business_type, cfg.REGISTRATION_THRESHOLDS["services"])
    threshold = band["special_category"] if special else band["normal"]
    required = turnover > threshold
    msg = (
        f"Turnover of {CURRENCY}{turnover:,.0f} is above the {CURRENCY}{threshold:,.0f} threshold for "
        f"{band['label'].lower()}. Registration is likely mandatory — confirm with your CA."
        if required else
        f"Turnover of {CURRENCY}{turnover:,.0f} is below the {CURRENCY}{threshold:,.0f} registration "
        f"threshold for {band['label'].lower()}."
    )
    return RegistrationCheck(business_type=business_type, turnover=_r(turnover),
                             threshold=threshold, required=required, message=msg)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _warnings(req: GSTCalculateRequest, lines: List[GSTLineResult], structure_key: str,
              date_structure: Optional[str] = None) -> List[str]:
    out: List[str] = []
    allowed = cfg.valid_rates(structure_key)
    structure = cfg.get_rate_structure(structure_key)

    if date_structure and date_structure != structure_key:
        out.append(
            f"The invoice date {req.invoice_date} falls under "
            f"{cfg.get_rate_structure(date_structure)['label']}, but {structure['label']} was selected. "
            "The selected structure has been used — check that is what you meant."
        )

    off_slab = sorted({l.rate for l in lines if l.rate not in allowed})
    if off_slab:
        pretty = ", ".join(f"{r:g}%" for r in off_slab)
        out.append(structure.get("off_slab_warning", "{rates} is not a slab in this structure.").format(rates=pretty))

    if any(l.cess_rate > 0 for l in lines) and req.mode == "inclusive":
        out.append("Cess is included in the reverse calculation divisor, so the extracted taxable value "
                   "accounts for both GST and cess.")

    if req.supply_type == "inter_state" and any(l.cgst or l.sgst for l in lines):
        out.append("Inter-state supply should carry IGST only.")

    supply_for_rcm = cfg.SUPPLY_TYPES.get(req.supply_type, {})
    if req.input_tax_credit and any(l.reverse_charge for l in lines) and rcm_payer(supply_for_rcm) == "you":
        out.append("Reverse-charge tax must be paid in cash before it can be claimed as credit, so it is "
                   "shown separately from the input credit netting.")

    if not lines:
        out.append("Add at least one line to calculate.")

    supply = cfg.SUPPLY_TYPES.get(req.supply_type, {})
    if not supply.get("taxable", True) and any((l.rate or 0) > 0 for l in lines):
        out.append(
            f"{supply.get('label', 'This supply type')} carries no tax, so the rates entered are "
            "ignored. The taxable value is still reported because it must be declared in your return."
        )
    if supply.get("force_rcm"):
        out.append(
            "Import of services is reverse charge by definition — every line is treated as reverse "
            "charge whether or not the box is ticked."
        )
    if supply.get("zero_rated") and supply.get("taxable"):
        out.append(
            "Zero-rated with payment of IGST: the tax charged here is refundable. The LUT route "
            "avoids tying up the cash in the first place."
        )

    return out


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def calculate(req: GSTCalculateRequest) -> GSTCalculateResponse:
    mode = req.mode if req.mode in cfg.CALC_MODES else cfg.DEFAULT_CALC_MODE
    supply_key = req.supply_type if req.supply_type in cfg.SUPPLY_TYPES else cfg.DEFAULT_SUPPLY_TYPE
    supply = cfg.SUPPLY_TYPES[supply_key]

    # Structure precedence: an explicit choice wins; otherwise the invoice date
    # decides; otherwise the current default. A date that contradicts an
    # explicit choice is surfaced as a warning rather than overriding it.
    invoice_on = parse_invoice_date(req.invoice_date)
    date_structure = cfg.structure_for_date(invoice_on) if invoice_on else None
    if req.rate_structure in cfg.RATE_STRUCTURES:
        structure_key, structure_basis = req.rate_structure, "explicit"
    elif date_structure:
        structure_key, structure_basis = date_structure, "invoice_date"
    else:
        structure_key, structure_basis = cfg.DEFAULT_RATE_STRUCTURE, "default"
    structure = cfg.get_rate_structure(structure_key)

    lines = [_compute_line(l, mode, supply) for l in (req.lines or [])]
    rate_summary = _rate_summary(lines)
    totals = _totals(lines, rcm_payer(supply))
    net = _net_position(totals, req.input_tax_credit)

    # Turnover for the scheme and threshold checks: an explicit annual figure
    # when given, otherwise the taxable value on this invoice.
    turnover = req.annual_turnover if req.annual_turnover is not None else totals.taxable_value

    composition = None
    if req.composition_category:
        composition = _composition(req.composition_category, turnover,
                                   totals.taxable_value, net.net_payable)

    registration = _registration(
        req.business_type if req.business_type in cfg.REGISTRATION_THRESHOLDS else "services",
        turnover,
        bool(req.special_category_state),
    )

    supply_detail = SupplyTypeDetail(
        key=supply_key,
        label=supply["label"],
        group=supply.get("group", "Domestic"),
        description=supply.get("description", ""),
        taxable=bool(supply.get("taxable", True)),
        zero_rated=bool(supply.get("zero_rated", False)),
        credit_allowed=bool(supply.get("credit_allowed", True)),
        note=supply.get("note", "") or "",
    )

    applicability = ApplicabilityResult(**check_applicability(req.annual_turnover))
    gstin_check = GSTINCheck(**validate_gstin(req.gstin)) if req.gstin else None

    return GSTCalculateResponse(
        mode=mode,
        mode_label=cfg.CALC_MODES[mode]["label"],
        supply_type=supply_key,
        supply_type_label=supply["label"],
        rate_structure=structure_key,
        rate_structure_label=structure["label"],
        rate_structure_basis=structure_basis,
        invoice_date=invoice_on.isoformat() if invoice_on else None,
        currency=CURRENCY,
        lines=lines,
        rate_summary=rate_summary,
        totals=totals,
        net_position=net,
        composition=composition,
        registration=registration,
        supply_detail=supply_detail,
        applicability=applicability,
        gstin_check=gstin_check,
        formula=cfg.CALC_MODES[mode]["formula"],
        rounding_note=cfg.ROUNDING_NOTE,
        warnings=_warnings(req, lines, structure_key, date_structure),
        disclaimer=cfg.DISCLAIMER,
    )

# ---------------------------------------------------------------------------
# GSTIN validation
#
# The 15th character is a Luhn mod 36 check digit over the first 14. Verified
# against published test vectors: 27AAPFU0939F1ZV and 29AAGCB7383J1Z4 are
# valid, and 07AAACI1195H1ZO checks out.
#
# EDGE CASE: several implementations in the wild compute the check digit as
# `36 - (sum % 36)` without a final `% 36`. When the sum is an exact multiple
# of 36 that yields 36, which is not a valid code point, and they emit "[" or
# reject a good number. 27AASCS2460H1Z0 is exactly that case and IS valid. The
# final `% 36` below is what makes it come out right.
# ---------------------------------------------------------------------------

GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_check_digit(first14: str) -> Optional[str]:
    """Luhn mod 36 check digit for the first 14 characters of a GSTIN."""
    if len(first14) != 14:
        return None
    factor, total, mod = 2, 0, len(GSTIN_CHARS)
    for ch in reversed(first14):
        idx = GSTIN_CHARS.find(ch)
        if idx < 0:
            return None
        addend = factor * idx
        factor = 1 if factor == 2 else 2
        addend = (addend // mod) + (addend % mod)
        total += addend
    return GSTIN_CHARS[(mod - (total % mod)) % mod]


def validate_gstin(raw: Optional[str]) -> Dict[str, Any]:
    """Decode and check a GSTIN.

    A passing check digit proves the number is well-formed, NOT that it is
    registered or active - only the GST portal can tell you that, and this
    module makes no network call. The response says so explicitly rather than
    letting a green tick imply more than it means.
    """
    value = (raw or "").strip().upper().replace(" ", "")
    out: Dict[str, Any] = {
        "input": value or None, "valid": False, "errors": [], "warnings": [],
        "state_code": None, "state": None, "pan": None, "entity_type": None,
        "registration_number": None, "default_char": None, "check_digit": None,
        "expected_check_digit": None, "special_category_state": False,
        "note": ("A valid check digit confirms the number is well-formed. It does not confirm the "
                 "registration exists or is active - verify that on the GST portal."),
    }
    if not value:
        out["errors"].append("Enter a GSTIN to check.")
        return out
    if len(value) != 15:
        out["errors"].append(f"A GSTIN is exactly 15 characters. This one has {len(value)}.")
        return out
    if any(c not in GSTIN_CHARS for c in value):
        out["errors"].append("A GSTIN contains only digits and capital letters.")
        return out

    state_code, pan, reg_no, default_char, check = value[:2], value[2:12], value[12], value[13], value[14]
    out.update({
        "state_code": state_code, "pan": pan, "registration_number": reg_no,
        "default_char": default_char, "check_digit": check,
    })

    state = ref.STATE_CODES.get(state_code)
    if state:
        out["state"] = state
        out["special_category_state"] = state_code in ref.SPECIAL_CATEGORY_STATE_CODES
    else:
        out["errors"].append(f"{state_code} is not a valid GST state code.")

    # PAN inside a GSTIN is AAAAA9999A.
    pan_ok = (
        len(pan) == 10
        and pan[:5].isalpha()
        and pan[5:9].isdigit()
        and pan[9].isalpha()
    )
    if pan_ok:
        out["entity_type"] = ref.PAN_ENTITY_TYPES.get(pan[3], f"Unknown entity type ({pan[3]})")
        if pan[3] not in ref.PAN_ENTITY_TYPES:
            out["warnings"].append(f"'{pan[3]}' is not a standard PAN entity-type character.")
    else:
        out["errors"].append("Characters 3-12 must be a valid PAN in the form AAAAA9999A.")

    if default_char != ref.DEFAULT_REGISTRATION_CHAR:
        out["warnings"].append(
            f"The 14th character is normally '{ref.DEFAULT_REGISTRATION_CHAR}' for a regular taxpayer. "
            f"'{default_char}' indicates a special registration type."
        )

    expected = gstin_check_digit(value[:14])
    out["expected_check_digit"] = expected
    if expected and expected != check:
        out["errors"].append(
            f"Check digit is wrong: expected '{expected}' but found '{check}'. "
            "This GSTIN contains a typo or is invented."
        )

    out["valid"] = not out["errors"]
    return out


# ---------------------------------------------------------------------------
# HSN / SAC lookup
# ---------------------------------------------------------------------------

def search_hsn(query: Optional[str], limit: int = 12) -> Dict[str, Any]:
    """Substring search over the curated catalogue, by code or description."""
    q = (query or "").strip().lower()
    if not q:
        results = ref.HSN_SAC_CATALOGUE[:limit]
    else:
        results = [
            e for e in ref.HSN_SAC_CATALOGUE
            if q in e["code"].lower() or q in e["label"].lower() or q in (e.get("note") or "").lower()
        ][:limit]
    return {
        "query": query or "",
        "count": len(results),
        "results": results,
        "disclaimer": ref.HSN_SAC_DISCLAIMER,
    }


# ---------------------------------------------------------------------------
# Scheme and compliance applicability
# ---------------------------------------------------------------------------

def check_applicability(turnover: Optional[float]) -> Dict[str, Any]:
    """Which schemes and obligations attach at this turnover."""
    if turnover is None:
        return {
            "turnover": None,
            "status": "insufficient_data",
            "rules": [],
            "eway_bill": {"threshold": cfg.EWAY_BILL_THRESHOLD, "note": cfg.EWAY_BILL_NOTE},
            "note": "Enter your aggregate annual turnover to see which schemes and obligations apply.",
        }

    rules = []
    for rule in cfg.APPLICABILITY_RULES:
        if rule["direction"] == "above":
            applies = turnover > rule["threshold"]
        else:
            applies = turnover <= rule["threshold"]
        rules.append({
            "id": rule["id"],
            "label": rule["label"],
            "applies": applies,
            "threshold": rule["threshold"],
            "sticky": rule.get("sticky", False),
            "message": rule["applies_note"] if applies else rule["exempt_note"],
            "detail": rule["detail"],
        })

    return {
        "turnover": _r(turnover),
        "status": "actual",
        "rules": rules,
        "eway_bill": {"threshold": cfg.EWAY_BILL_THRESHOLD, "note": cfg.EWAY_BILL_NOTE},
        "note": "Based on aggregate annual turnover on your PAN, across all states.",
    }
