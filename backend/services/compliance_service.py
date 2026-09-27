"""
Compliance Command Center for the Startup journey.

Answers the question every Indian founder loses sleep over: what do I owe,
to whom, by when, and what does it cost me if I miss it.

Three deterministic layers, in descending order of confidence:

  1. THE CALENDAR. Statutory due dates, computed exactly from
     `config/compliance_config.py`. No estimation is involved — a GSTR-3B is
     due on the 20th whatever the founder's data looks like. The founder's own
     filing records (`ComplianceFiling`) decide whether a past deadline was
     met, missed, or does not apply.

  2. PENALTY EXPOSURE. For anything unfiled past its date — and for anything
     filed late — the late fee and interest, from the same statutory rates.
     Late fees need only dates. Interest needs the amount that was due: the
     founder's figure for that period, else the estimate below (labelled as
     such), else it is reported as not computable. It is never guessed.

  3. LIABILITY ESTIMATES. Approximate, and labelled as such everywhere.
     `StartupTransaction` records only type / category / amount / date, so it
     carries no GST rate, no HSN/SAC, no place of supply and no B2B/B2C split.
     This module applies one assumed rate to categorised turnover and reports
     an ESTIMATE with its assumptions attached. It is a cash-flow planning
     aid, not a return, and it says so.

As everywhere else in the Startup engine, no number here comes from an LLM.
"""

import calendar as _calendar
from datetime import date, datetime
from typing import Any, Dict, Iterable, List, Optional, Tuple

from backend.core.config import compliance_config as cfg
from backend.models.domain import ComplianceFiling, StartupProfile, StartupTransaction

CURRENCY = "Rs."


# ---------------------------------------------------------------------------
# Financial year helpers
# ---------------------------------------------------------------------------

def current_fy_start_year(today: Optional[date] = None) -> int:
    """The calendar year in which the active Indian financial year began."""
    today = today or date.today()
    return today.year if today.month >= cfg.FY_START_MONTH else today.year - 1


def fy_label(start_year: int) -> str:
    return f"FY{start_year}-{str(start_year + 1)[-2:]}"


def parse_fy(raw: Optional[str], today: Optional[date] = None) -> int:
    """Accept 'FY2026-27', '2026-27' or '2026'; fall back to the current FY."""
    if not raw:
        return current_fy_start_year(today)
    txt = str(raw).strip().upper().replace("FY", "")
    head = txt.split("-")[0].strip()
    try:
        year = int(head)
    except ValueError:
        return current_fy_start_year(today)
    if year < 2000 or year > 2100:
        return current_fy_start_year(today)
    return year


def fy_months(start_year: int) -> List[Tuple[int, int]]:
    """The twelve (year, month) pairs of a financial year, April to March."""
    out = []
    for i in range(12):
        m = cfg.FY_START_MONTH + i
        year = start_year + (m - 1) // 12
        month = ((m - 1) % 12) + 1
        out.append((year, month))
    return out


def _clamp_day(year: int, month: int, day: int) -> date:
    """Guard against a configured day that does not exist in a short month."""
    last = _calendar.monthrange(year, month)[1]
    return date(year, month, min(day, last))


def _add_months(year: int, month: int, delta: int) -> Tuple[int, int]:
    idx = (year * 12 + (month - 1)) + delta
    return idx // 12, (idx % 12) + 1


def months_or_part(start: date, end: date) -> int:
    """Calendar months from `start` to `end`, a part of a month counting as a whole one.

    7 May -> 8 May is 1 month; 7 May -> 7 June is 1; 7 May -> 8 June is 2.
    This is how "per month or part of a month" interest is counted, rather than
    in 30-day blocks.
    """
    if end <= start:
        return 0
    months = (end.year - start.year) * 12 + (end.month - start.month)
    if end.day > start.day:
        months += 1
    return max(1, months)


# ---------------------------------------------------------------------------
# Applicability
# ---------------------------------------------------------------------------

def derive_applicability(sp: StartupProfile, transactions: List[StartupTransaction]) -> Dict[str, Any]:
    """Which obligations apply to this company, and why.

    Every flag carries its reason, so the UI can explain an omission rather
    than silently hiding a filing the founder may actually owe.
    """
    categories = {cfg.canonical_category(t.category) for t in transactions if t.type == "out"}
    headcount = sp.headcount or 0
    has_gstin = bool((sp.gst_number or "").strip())
    has_payroll = cfg.PAYROLL_CATEGORY in categories or headcount > 0
    has_tds = bool(categories & cfg.TDS_TRIGGER_CATEGORIES) or has_payroll

    return {
        "always": {"applies": True, "reason": "Applies to every registered business."},
        "has_gstin": {
            "applies": has_gstin,
            "reason": ("GSTIN recorded at onboarding." if has_gstin
                       else "No GSTIN on file. Add one in your startup profile to see GST filings."),
        },
        "has_tds": {
            "applies": has_tds,
            "reason": ("You have staff, or record spend in categories that ordinarily attract TDS."
                       if has_tds else "No staff and no TDS-attracting spend recorded yet."),
        },
        "has_epf": {
            "applies": headcount >= cfg.EPF_HEADCOUNT_THRESHOLD,
            "reason": (f"Headcount of {headcount} is at or above the EPF threshold of {cfg.EPF_HEADCOUNT_THRESHOLD}."
                       if headcount >= cfg.EPF_HEADCOUNT_THRESHOLD
                       else f"Headcount of {headcount} is below the EPF threshold of {cfg.EPF_HEADCOUNT_THRESHOLD}."),
        },
        "has_esi": {
            "applies": headcount >= cfg.ESI_HEADCOUNT_THRESHOLD,
            "reason": (f"Headcount of {headcount} is at or above the ESI threshold of {cfg.ESI_HEADCOUNT_THRESHOLD}."
                       if headcount >= cfg.ESI_HEADCOUNT_THRESHOLD
                       else f"Headcount of {headcount} is below the ESI threshold of {cfg.ESI_HEADCOUNT_THRESHOLD}."),
        },
        "is_company": {
            "applies": True,
            "reason": ("Assumed to be a private limited company. If you are an LLP or a proprietorship, "
                       "the ROC filings below differ."),
        },
    }


# ---------------------------------------------------------------------------
# Calendar construction
# ---------------------------------------------------------------------------

OBLIGATIONS_BY_ID: Dict[str, Dict[str, Any]] = {ob["id"]: ob for ob in cfg.OBLIGATIONS}


def _status_for(due: date, today: date, tracking_start: Optional[date] = None) -> str:
    """Date-only status of one occurrence, before any filing record is applied.

    `tracking_start` is the date this company began being tracked here. A
    deadline that fell before it is reported as "before_tracking", not
    "overdue": the twin has no idea whether it was filed, and telling a founder
    who onboarded last week that they have twelve overdue filings and a penalty
    bill would be both alarming and wrong. Those entries stay visible for
    context but are excluded from the overdue count and the penalty total.
    """
    if tracking_start and due < tracking_start:
        return "before_tracking"
    if due < today:
        return "overdue"
    if (due - today).days <= cfg.DUE_SOON_DAYS:
        return "due_soon"
    return "upcoming"


def resolve_tracking_start(sp: StartupProfile, fy_start: int) -> date:
    """When this company's obligations start being the twin's business.

    The later of the financial year's start and the date the startup profile
    was created — a company onboarded in September is not answerable here for
    an April deadline.
    """
    fy_begin = date(fy_start, cfg.FY_START_MONTH, 1)
    created = getattr(sp, "created_at", None)
    if isinstance(created, datetime):
        created = created.date()
    if not isinstance(created, date):
        return fy_begin
    return max(fy_begin, created)


def occurrences(ob: Dict[str, Any], fy_start: int) -> List[Tuple[date, str]]:
    """Every (due_date, period_label) an obligation generates in a financial year."""
    out: List[Tuple[date, str]] = []
    cadence = ob["cadence"]

    if cadence == "monthly":
        for year, month in fy_months(fy_start):
            override = (ob.get("month_overrides") or {}).get(month, {})
            day = override.get("day", ob["day"])
            offset = override.get("offset_months", ob.get("offset_months", 1))
            dy, dm = _add_months(year, month, offset)
            period = f"{_calendar.month_abbr[month]} {year}"
            out.append((_clamp_day(dy, dm, day), period))

    elif cadence in ("quarterly", "annual"):
        for occ in ob["due_on"]:
            # Each occurrence states its own year offset. Inferring the year
            # from the month is what once dated the Q4 TDS return (due 31 May of
            # the FOLLOWING year) a full year early.
            year = fy_start + occ.get("year_offset", 0)
            period = occ.get("period") or ""
            if cadence == "annual":
                period = fy_label(fy_start) if period in ("", "Annual") else f"{fy_label(fy_start)} · {period}"
            else:
                period = f"{period} {fy_label(fy_start)}".strip()
            out.append((_clamp_day(year, occ["month"], occ["day"]), period))

    return out


def is_valid_occurrence(obligation_id: str, due: date) -> bool:
    """True when `due` is a date this obligation actually falls due on.

    Guards the filing endpoint against records for dates the calendar would
    never show, which could otherwise never be seen or undone.
    """
    ob = OBLIGATIONS_BY_ID.get(obligation_id)
    if not ob:
        return False
    for fy in range(due.year - 2, due.year + 1):
        if any(d == due for d, _ in occurrences(ob, fy)):
            return True
    return False


def _tier(tiers: List[Dict[str, Any]], turnover: Optional[float]) -> Tuple[Dict[str, Any], bool]:
    """The tier a turnover falls in. Unknown turnover takes the top tier — the
    upper bound of exposure — and says so via the second value."""
    if turnover is None:
        return tiers[-1], True
    for t in tiers:
        if t["up_to"] is None or turnover <= t["up_to"]:
            return t, False
    return tiers[-1], False


def _dedupe(items: Iterable[str]) -> List[str]:
    seen, out = set(), []
    for i in items:
        if i and i not in seen:
            seen.add(i)
            out.append(i)
    return out


def penalty_exposure(ob: Dict[str, Any], due: date, as_of: date,
                     amount: Optional[float], amount_source: Optional[str],
                     turnover: Optional[float]) -> Optional[Dict[str, Any]]:
    """Late fee and interest on one occurrence, from the statutory rates in config.

    `as_of` is today for an unfiled deadline, or the filing date for one filed
    late. `amount` is the tax or contribution due for the period and
    `amount_source` says where it came from ("entered" or "estimated").
    Anything that cannot be computed without a missing figure is listed in
    `missing_inputs` rather than assumed.
    """
    if as_of <= due:
        return None
    rule = cfg.PENALTIES.get(ob.get("penalty_id") or "")
    if not rule:
        return None

    days_late = (as_of - due).days
    components: List[Dict[str, Any]] = []
    missing: List[str] = []
    total = 0.0
    uncapped = False
    amount_label = ob.get("amount_label") or "Amount due for the period"
    # A nil return is a founder-stated zero, never an estimate that happened to net to zero.
    is_nil = amount_source == "entered" and amount == 0 and "per_day_nil" in rule

    # ---- Late fee ----
    if rule.get("per_day_by_turnover"):
        tier, unknown = _tier(rule["per_day_by_turnover"], turnover)
        per_day = tier["per_day"]
        fee = per_day * days_late
        basis = f"Rs.{per_day:g}/day x {days_late} days"
        if unknown:
            basis += "; turnover unknown, so the highest daily rate is used and the turnover cap cannot be applied"
            missing.append("Annual turnover (sets the fee tier and its cap)")
        else:
            cap = turnover * tier["max_turnover_pct"] / 100.0
            if fee > cap:
                fee = cap
                basis += f", capped at {tier['max_turnover_pct']:g}% of turnover (Rs.{cap:,.0f})"
        components.append({"label": rule["label"], "amount": round(fee, 2), "basis": basis})
        total += fee
    elif rule.get("per_day"):
        per_day = rule["per_day_nil"] if is_nil else rule["per_day"]
        fee = per_day * days_late
        basis = f"Rs.{per_day:g}/day x {days_late} days" + (" (nil return rate)" if is_nil else "")
        cap: Optional[float] = None
        cap_desc = ""
        if is_nil and rule.get("max_amount_nil") is not None:
            cap, cap_desc = rule["max_amount_nil"], "nil-return cap"
        elif rule.get("max_by_turnover"):
            tier, unknown = _tier(rule["max_by_turnover"], turnover)
            cap = tier["max"]
            cap_desc = "cap for your turnover" if not unknown else "highest cap, as turnover is unknown"
            if unknown:
                missing.append("Annual turnover (sets the fee cap)")
        elif rule.get("cap_at_amount"):
            if amount is not None:
                cap, cap_desc = amount, "the amount in the statement"
            else:
                basis += "; capped at the amount in the statement, which is not known"
                missing.append(amount_label)
        elif "max_amount" in rule and rule["max_amount"] is None:
            uncapped = True
        else:
            cap = rule.get("max_amount")
        if cap is not None and fee > cap:
            fee = cap
            basis += f", capped at Rs.{cap:,.0f} ({cap_desc})" if cap_desc else f", capped at Rs.{cap:,.0f}"
        components.append({"label": rule["label"], "amount": round(fee, 2), "basis": basis})
        total += fee

    flat = rule.get("flat_amount")
    if flat:
        components.append({"label": rule["label"], "amount": round(flat, 2), "basis": f"Flat Rs.{flat:,.0f}"})
        total += flat

    # ---- Interest ----
    monthly_pct = rule.get("monthly_interest_pct")
    annual_pct = rule.get("annual_interest_pct")
    if monthly_pct or annual_pct:
        if amount is None:
            missing.append(amount_label)
        elif amount > 0:
            qualifier = "estimated " if amount_source == "estimated" else ""
            if monthly_pct:
                months = months_or_part(due, as_of)
                interest = amount * (monthly_pct / 100.0) * months
                basis = f"{monthly_pct:g}% per month x {months} month(s) on {qualifier}Rs.{amount:,.0f}"
            else:
                interest = amount * (annual_pct / 100.0) * (days_late / 365.0)
                basis = f"{annual_pct:g}% p.a. x {days_late} days on {qualifier}Rs.{amount:,.0f}"
            components.append({"label": "Interest", "amount": round(interest, 2), "basis": basis,
                               "estimated": amount_source == "estimated"})
            total += interest

    missing = _dedupe(missing)
    if not components and not missing:
        return None
    computable = bool(components)
    return {
        "days_late": days_late,
        "as_of": as_of.isoformat(),
        "total": round(total, 2) if computable else None,
        "components": components,
        "note": rule["note"],
        "uncapped": uncapped,
        "computable": computable,
        "complete": not missing,
        "missing_inputs": missing,
        "uses_estimate": amount_source == "estimated" and any(c.get("estimated") for c in components),
    }


def _estimated_amount(ob: Dict[str, Any], liabilities: Dict[str, Any]) -> Optional[float]:
    """The per-period amount estimable from recorded transactions, if any."""
    link = ob.get("liability_link")
    if link == "gst":
        return liabilities.get("gst", {}).get("monthly_average")
    if link == "tds":
        return liabilities.get("tds", {}).get("monthly_average")
    if link == "tds_quarter":
        monthly = liabilities.get("tds", {}).get("monthly_average")
        return monthly * 3 if monthly is not None else None
    return None


def _filing_to_dict(rec: ComplianceFiling) -> Dict[str, Any]:
    return {
        "status": rec.status,
        "filed_on": rec.filed_on.isoformat() if rec.filed_on else None,
        "amount": rec.amount,
        "note": rec.note,
        "updated_at": rec.updated_at.isoformat() if rec.updated_at else None,
    }


def build_calendar(
    sp: StartupProfile,
    transactions: List[StartupTransaction],
    fy_start: int,
    liabilities: Dict[str, Any],
    today: Optional[date] = None,
    filings: Optional[List[ComplianceFiling]] = None,
    turnover: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """The full statutory calendar for one financial year."""
    today = today or date.today()
    applicability = derive_applicability(sp, transactions)
    tracking_start = resolve_tracking_start(sp, fy_start)
    records = {(f.obligation_id, f.due_date): f for f in (filings or [])}
    turnover_value = (turnover or {}).get("value")

    entries: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []

    for ob in cfg.OBLIGATIONS:
        flag = applicability.get(ob["applies_if"], {"applies": False, "reason": "Not applicable."})
        if not flag["applies"]:
            skipped.append({
                "id": ob["id"], "label": ob["label"], "category": ob["category"],
                "reason": flag["reason"],
            })
            continue

        estimate = _estimated_amount(ob, liabilities)
        rule = cfg.PENALTIES.get(ob.get("penalty_id") or "", {})
        accrues_interest = bool(rule.get("monthly_interest_pct") or rule.get("annual_interest_pct")
                                or rule.get("cap_at_amount"))

        for due, period in occurrences(ob, fy_start):
            rec = records.get((ob["id"], due))
            if rec is not None and rec.amount is not None:
                amount, amount_source = rec.amount, "entered"
            elif estimate is not None:
                amount, amount_source = estimate, "estimated"
            else:
                amount, amount_source = None, None

            base_status = _status_for(due, today, tracking_start)
            status = base_status
            penalty = None
            if rec is not None and rec.status == "not_applicable":
                status = "not_applicable"
            elif rec is not None and rec.status == "filed":
                filed_on = rec.filed_on or due
                if filed_on <= due:
                    status = "filed"
                else:
                    # Filed, but late: the fee is no longer accruing, it is owed.
                    status = "filed_late"
                    penalty = penalty_exposure(ob, due, filed_on, amount, amount_source, turnover_value)
            elif base_status == "overdue":
                penalty = penalty_exposure(ob, due, today, amount, amount_source, turnover_value)

            entries.append({
                "id": f"{ob['id']}::{due.isoformat()}",
                "obligation_id": ob["id"],
                "label": ob["label"],
                "category": ob["category"],
                "description": ob["description"],
                "authority": ob["authority"],
                "period": period,
                "due_date": due.isoformat(),
                "days_until": (due - today).days,
                "status": status,
                "date_status": base_status,
                "filing": _filing_to_dict(rec) if rec is not None else None,
                "estimated_liability": round(estimate, 2) if estimate is not None else None,
                "amount": round(amount, 2) if amount is not None else None,
                "amount_source": amount_source,
                "amount_label": ob.get("amount_label"),
                "needs_amount": accrues_interest and amount is None,
                "penalty": penalty,
            })

    entries.sort(key=lambda e: e["due_date"])

    def having(*statuses: str) -> List[Dict[str, Any]]:
        return [e for e in entries if e["status"] in statuses]

    overdue = having("overdue")
    due_soon = having("due_soon")
    upcoming = having("upcoming")
    filed_late = having("filed_late")

    def penalty_sum(items: List[Dict[str, Any]]) -> float:
        return round(sum(((e["penalty"] or {}).get("total") or 0.0) for e in items), 2)

    by_category: Dict[str, int] = {}
    for e in entries:
        by_category[e["category"]] = by_category.get(e["category"], 0) + 1

    return {
        "fy": fy_label(fy_start),
        "fy_start_year": fy_start,
        "today": today.isoformat(),
        "tracking_start": tracking_start.isoformat(),
        "entries": entries,
        "next_up": (due_soon + upcoming)[:5],
        "overdue": overdue,
        "due_soon": due_soon,
        "before_tracking": having("before_tracking"),
        "counts": {
            "total": len(entries),
            "overdue": len(overdue),
            "due_soon": len(due_soon),
            "upcoming": len(upcoming),
            "before_tracking": len(having("before_tracking")),
            "filed": len(having("filed")),
            "filed_late": len(filed_late),
            "not_applicable": len(having("not_applicable")),
            "by_category": by_category,
        },
        # Accruing on deadlines still open.
        "penalty_exposure_total": penalty_sum(overdue),
        # Already fixed by filing late.
        "penalty_incurred_total": penalty_sum(filed_late),
        # Open items whose exposure is understated or unknown for want of a figure.
        "penalty_incomplete_count": sum(
            1 for e in overdue if e["penalty"] and not e["penalty"]["complete"]),
        "applicability": applicability,
        "not_applicable": skipped,
    }


# ---------------------------------------------------------------------------
# Liability estimation
# ---------------------------------------------------------------------------

def _in_fy(txn: StartupTransaction, fy_start: int) -> bool:
    start = date(fy_start, cfg.FY_START_MONTH, 1)
    end = date(fy_start + 1, cfg.FY_START_MONTH, 1)
    return txn.txn_date is not None and start <= txn.txn_date < end


def _months_of_data(txns: List[StartupTransaction]) -> int:
    return len({(t.txn_date.year, t.txn_date.month) for t in txns})


def estimate_gst(
    transactions: List[StartupTransaction],
    fy_start: int,
    amounts_are: str = cfg.DEFAULT_AMOUNTS_ARE,
    rate_pct: float = cfg.ASSUMED_GST_RATE_PCT,
) -> Dict[str, Any]:
    """Estimate output GST, input tax credit and net payable for a year.

    `amounts_are` decides how a logged figure is read. Founders typically log
    what hit the bank, so the default treats amounts as GST-inclusive; the
    difference against the exclusive reading is material, which is why it is a
    parameter rather than a buried constant.

    With no transactions in the year every figure is None, not zero: "nothing
    recorded" and "nothing owed" are different statements.
    """
    txns = [t for t in transactions if _in_fy(t, fy_start)]
    rate = rate_pct / 100.0

    def tax_component(amount: float) -> float:
        return amount * rate / (1 + rate) if amounts_are == "inclusive" else amount * rate

    assumptions = [
        f"A single rate of {rate_pct:g}% is applied to all taxable supplies.",
        f"Logged amounts are read as GST-{amounts_are}.",
        "Only Revenue and Freelance / Business income is treated as a taxable supply; "
        "funding, refunds, interest and investment returns are excluded.",
        "Input tax credit is assumed available on software, marketing, professional fees, "
        "supplies and utilities, and blocked elsewhere.",
        "Place of supply, HSN/SAC classification, exports, reverse charge and exempt supplies "
        "are not modelled.",
    ]

    if not txns:
        return {
            "status": "insufficient_data", "rate_pct": rate_pct, "amounts_are": amounts_are,
            "taxable_turnover": None, "output_gst": None, "itc_base": None, "input_credit": None,
            "net_payable": None, "monthly_average": None, "months_of_data": 0,
            "excluded_income": [], "blocked_credit": [], "assumptions": assumptions,
        }

    taxable_out = 0.0
    excluded_in: Dict[str, float] = {}
    itc_base = 0.0
    blocked: Dict[str, float] = {}
    for t in txns:
        cat = cfg.canonical_category(t.category)
        amt = t.amount or 0.0
        if t.type == "in":
            if cat in cfg.TAXABLE_INCOME_CATEGORIES:
                taxable_out += amt
            else:
                excluded_in[cat] = excluded_in.get(cat, 0.0) + amt
        elif t.type == "out":
            if cat in cfg.ITC_ELIGIBLE_CATEGORIES:
                itc_base += amt
            elif cat in cfg.ITC_BLOCKED_CATEGORIES:
                blocked[cat] = blocked.get(cat, 0.0) + amt

    output_gst = tax_component(taxable_out)
    input_credit = tax_component(itc_base)
    net = max(output_gst - input_credit, 0.0)
    months = max(1, _months_of_data(txns))

    return {
        "status": "estimated",
        "rate_pct": rate_pct,
        "amounts_are": amounts_are,
        "taxable_turnover": round(taxable_out, 2),
        "output_gst": round(output_gst, 2),
        "itc_base": round(itc_base, 2),
        "input_credit": round(input_credit, 2),
        "net_payable": round(net, 2),
        "monthly_average": round(net / months, 2),
        "months_of_data": months,
        "excluded_income": [
            {"category": k, "amount": round(v, 2),
             "reason": cfg.NON_SUPPLY_INCOME_CATEGORIES.get(k, "Not treated as a taxable supply.")}
            for k, v in sorted(excluded_in.items(), key=lambda kv: -kv[1])
        ],
        "blocked_credit": [
            {"category": k, "amount": round(v, 2),
             "reason": cfg.ITC_BLOCKED_CATEGORIES.get(k, "No input tax credit available.")}
            for k, v in sorted(blocked.items(), key=lambda kv: -kv[1])
        ],
        "assumptions": assumptions,
    }


def estimate_tds(transactions: List[StartupTransaction], fy_start: int) -> Dict[str, Any]:
    """Estimate TDS deductible on categorised spend.

    Salary TDS (S.392, earlier S.192) is deliberately NOT estimated: it depends
    on each employee's declared regime, investments and exemptions, none of
    which this product holds. It is reported as a gap instead of a wrong number.
    """
    txns = [t for t in transactions if _in_fy(t, fy_start) and t.type == "out"]
    payroll_spend = sum((t.amount or 0.0) for t in txns
                        if cfg.canonical_category(t.category) == cfg.PAYROLL_CATEGORY)

    not_estimated = [{
        "label": "Salary TDS (S.392, earlier S.192)",
        "payroll_spend": round(payroll_spend, 2) if txns else None,
        "reason": ("Depends on each employee's chosen tax regime, declared investments and "
                   "exemptions. None of that is collected, so no figure is shown rather than "
                   "a misleading one."),
        "missing_inputs": [
            "Per-employee annual salary",
            "Each employee's declared regime and investment proofs",
        ],
    }]
    assumptions = [
        "TDS is inferred from spend category, not from the payee's actual status.",
        f"Rates assume the payee has furnished a PAN; a missing PAN attracts {cfg.NO_PAN_TDS_RATE_PCT:g}%.",
        "Annual thresholds are applied to the year's spend in each category; monthly thresholds to each month.",
    ]

    lines: List[Dict[str, Any]] = []
    total = 0.0
    for rule in cfg.TDS_RULES:
        cats = set(rule["categories"])
        rule_txns = [t for t in txns if cfg.canonical_category(t.category) in cats]
        spend = sum((t.amount or 0.0) for t in rule_txns)
        threshold = rule["threshold"]

        if rule["threshold_basis"] == "monthly":
            by_month: Dict[Tuple[int, int], float] = {}
            for t in rule_txns:
                key = (t.txn_date.year, t.txn_date.month)
                by_month[key] = by_month.get(key, 0.0) + (t.amount or 0.0)
            over = [v for v in by_month.values() if v > threshold]
            deductible = sum(over)
            crossed = bool(over)
            note = (f"{len(over)} month(s) above Rs.{threshold:,.0f}, so TDS is deductible on those months."
                    if crossed else f"No month above the Rs.{threshold:,.0f} monthly threshold.")
        else:
            crossed = spend > threshold
            deductible = spend if crossed else 0.0
            note = ("Above the annual threshold, so TDS is deductible."
                    if crossed else f"Below the Rs.{threshold:,.0f} annual threshold - no deduction required yet.")

        tds = deductible * rule["rate_pct"] / 100.0
        total += tds
        lines.append({
            "category": " / ".join(rule["categories"]),
            "section": rule["section"],
            "rate_pct": rule["rate_pct"],
            "threshold": threshold,
            "threshold_basis": rule["threshold_basis"],
            "spend": round(spend, 2),
            "threshold_crossed": crossed,
            "tds": round(tds, 2),
            "description": rule["description"],
            "note": note,
        })

    if not txns:
        return {
            "status": "insufficient_data", "total": None, "monthly_average": None, "months_of_data": 0,
            "lines": lines, "not_estimated": not_estimated, "assumptions": assumptions,
        }

    months = max(1, _months_of_data(txns))
    return {
        "status": "estimated",
        "total": round(total, 2),
        "monthly_average": round(total / months, 2),
        "months_of_data": months,
        "lines": lines,
        "not_estimated": not_estimated,
        "assumptions": assumptions,
    }


def aggregate_turnover(sp: StartupProfile, gst_estimate: Dict[str, Any]) -> Dict[str, Any]:
    """The best available annual turnover, and where it came from.

    Used to pick the late-fee tier and to check the registration threshold.
    The founder's stated monthly revenue is preferred; recorded sales are the
    fallback. With neither, the value is None and every consumer says so.
    """
    if getattr(sp, "is_pre_revenue", False):
        return {"value": 0.0, "source": "profile", "basis": "Your startup profile marks the company as pre-revenue."}
    if sp.monthly_revenue is not None:
        return {"value": round(sp.monthly_revenue * 12, 2), "source": "profile",
                "basis": "Annualised from the monthly revenue in your startup profile."}
    if gst_estimate.get("status") == "estimated":
        return {"value": gst_estimate.get("taxable_turnover"), "source": "recorded",
                "basis": "Taxable turnover in your recorded transactions this financial year."}
    return {"value": None, "source": None,
            "basis": "No turnover on file. Add your monthly revenue to your startup profile."}


def gst_registration_check(gst_estimate: Dict[str, Any], sp: StartupProfile,
                           turnover: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Whether an unregistered company has crossed the registration threshold."""
    has_gstin = bool((sp.gst_number or "").strip())
    threshold = cfg.GST_REGISTRATION_THRESHOLD_SERVICES
    turnover = turnover or aggregate_turnover(sp, gst_estimate)

    # Every basis we hold is checked, so neither a partial ledger nor a stale
    # profile figure can hide a crossed threshold.
    bases: List[Tuple[float, str]] = []
    if turnover.get("value") is not None:
        bases.append((turnover["value"], turnover["basis"]))
    if gst_estimate.get("status") == "estimated" and turnover.get("source") != "recorded":
        bases.append((gst_estimate["taxable_turnover"],
                      "Taxable turnover in your recorded transactions this financial year."))

    if has_gstin:
        return {"required": False, "registered": True, "message": "GSTIN on file.",
                "turnover": turnover.get("value"), "threshold": threshold, "basis": turnover.get("basis")}

    if not bases:
        return {
            "required": None, "registered": False, "turnover": None, "threshold": threshold,
            "basis": turnover.get("basis"),
            "message": ("No turnover is on file, so the Rs.{:,.0f} registration threshold cannot be checked. "
                        "Add your monthly revenue to your startup profile.").format(threshold),
        }

    value, basis = max(bases, key=lambda b: b[0])
    crossed = value > threshold
    return {
        "required": crossed,
        "registered": False,
        "turnover": round(value, 2),
        "threshold": threshold,
        "basis": basis,
        "message": (
            f"Turnover of Rs.{value:,.0f} is above the Rs.{threshold:,.0f} services threshold. "
            f"GST registration is likely mandatory - confirm with your CA. ({basis})"
            if crossed else
            f"Turnover of Rs.{value:,.0f} is below the Rs.{threshold:,.0f} services registration threshold. ({basis})"
        ),
    }


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def build_compliance(
    sp: StartupProfile,
    transactions: List[StartupTransaction],
    fy_start: int,
    amounts_are: str = cfg.DEFAULT_AMOUNTS_ARE,
    gst_rate_pct: float = cfg.ASSUMED_GST_RATE_PCT,
    today: Optional[date] = None,
    filings: Optional[List[ComplianceFiling]] = None,
) -> Dict[str, Any]:
    """Calendar, liability estimates and penalty exposure in one payload."""
    today = today or date.today()
    gst = estimate_gst(transactions, fy_start, amounts_are, gst_rate_pct)
    tds = estimate_tds(transactions, fy_start)
    liabilities = {"gst": gst, "tds": tds}
    turnover = aggregate_turnover(sp, gst)
    cal = build_calendar(sp, transactions, fy_start, liabilities, today, filings, turnover)
    this_fy = current_fy_start_year(today)

    return {
        "currency": CURRENCY,
        "company_name": sp.company_name,
        "gstin": (sp.gst_number or "").strip() or None,
        "fy": cal["fy"],
        "fy_start_year": fy_start,
        "available_years": [fy_label(y) for y in range(this_fy, this_fy - cfg.YEARS_OF_HISTORY - 1, -1)],
        "calendar": cal,
        "liabilities": {"gst": gst, "tds": tds},
        "turnover": turnover,
        "registration": gst_registration_check(gst, sp, turnover),
        "filing_statuses": cfg.FILING_STATUSES,
        "disclaimer": cfg.LIABILITY_DISCLAIMER,
    }
