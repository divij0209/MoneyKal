"""
Shared financial grounding + deterministic scenario math for the twin.

This is the "RAG" layer both Ask Twin and Simulation retrieve from: a single
`build_financial_context()` normalizes whatever shape the user's profile is
in (income/expenses/savings for an individual, revenue/burn/runway for a
startup, custom onboarded metrics...)
into one consistent structure. Simulation additionally runs deterministic
math on top of it — amounts, growth, affordability, timelines — so the LLM
is only ever asked to phrase a recommendation around numbers that were
already computed here, never to invent them.
"""
from backend.core.money import group_indian
import re
from dataclasses import dataclass, asdict
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# 1. Financial context extraction (the shared grounding step)
# ---------------------------------------------------------------------------

INCOME_KEYS = {"income", "revenue", "m_income", "salary"}
EXPENSE_KEYS = {"expenses", "burn", "m_expenses"}
SAVINGS_KEYS = {"savings", "treasury", "m_savings", "balance"}
LOAN_KEYS = {"loans", "m_loans", "debt"}


@dataclass
class FinancialContext:
    currency: str
    income: float
    expenses: float
    savings: float
    loans: float
    surplus: float
    buffer_months: Optional[float]
    goal_title: Optional[str]
    goal_target: Optional[float]
    goal_progress_pct: Optional[float]
    monthly_savings_rate: Optional[float]


def _find_metric(metrics: List[Dict[str, Any]], ids: set, label_keywords: List[str]) -> Optional[Dict[str, Any]]:
    for m in metrics or []:
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id") or "").lower()
        label = str(m.get("label") or "").lower()
        if mid in ids or any(k in label for k in label_keywords):
            return m
    return None


def build_financial_context(profile: Any) -> FinancialContext:
    """The single grounding step: turns a Profile row (whatever shape its
    metrics happen to be in) into normalized numbers every downstream
    consumer (Ask Twin, Simulation) can rely on."""
    metrics = profile.metrics or []

    income_m = _find_metric(metrics, INCOME_KEYS, ["income", "revenue", "salary"])
    expense_m = _find_metric(metrics, EXPENSE_KEYS, ["expense", "burn"])
    savings_m = _find_metric(metrics, SAVINGS_KEYS, ["saving", "treasury", "balance"])
    loan_m = _find_metric(metrics, LOAN_KEYS, ["loan", "debt"])

    def val(m):
        try:
            return float(m["value"]) if m and m.get("value") is not None else 0.0
        except (TypeError, ValueError):
            return 0.0

    income = val(income_m)
    expenses = val(expense_m)
    savings = val(savings_m)
    loans = val(loan_m)
    surplus = income - expenses
    buffer_months = (savings / expenses) if expenses > 0 else None

    monthly_savings_rate = None
    trend = (savings_m or {}).get("trend") if savings_m else None
    if trend and len(trend) >= 2:
        try:
            delta = float(trend[-1]) - float(trend[-2])
            if delta > 0:
                monthly_savings_rate = delta
        except (TypeError, ValueError):
            pass
    if monthly_savings_rate is None and surplus > 0:
        monthly_savings_rate = surplus

    goal = profile.goal or {}

    return FinancialContext(
        currency=profile.currency or "₹",
        income=income,
        expenses=expenses,
        savings=savings,
        loans=loans,
        surplus=surplus,
        buffer_months=buffer_months,
        goal_title=goal.get("title"),
        goal_target=goal.get("target"),
        goal_progress_pct=goal.get("progress"),
        monthly_savings_rate=monthly_savings_rate,
    )


def ctx_to_dict(ctx: FinancialContext) -> Dict[str, Any]:
    return asdict(ctx)


# ---------------------------------------------------------------------------
# 2. Natural-language scenario parsing (rule-based — numbers must come from
#    the text deterministically, never from an LLM guess)
# ---------------------------------------------------------------------------

_MONEY_UNITS = {"k": 1_000, "thousand": 1_000, "lakh": 100_000, "lac": 100_000, "l": 100_000, "crore": 10_000_000, "cr": 10_000_000}
_TIME_UNIT_PREFIXES = ("year", "yr", "month", "mo", "week", "wk")

_TOKEN_RE = re.compile(
    r'(?:₹|rs\.?|inr)?\s*([\d][\d,]*(?:\.\d+)?)\s*'
    r'(k|thousand|lakh|lac|l|crore|cr|years?|yrs?|months?|mo|weeks?|wk)?\b',
    re.IGNORECASE,
)


def extract_tokens(text: str) -> Tuple[List[float], Optional[float]]:
    """Pull monetary amounts and a duration (in months) out of free text."""
    amounts: List[float] = []
    months: Optional[float] = None
    for m in _TOKEN_RE.finditer(text):
        num_str, unit = m.group(1), (m.group(2) or "").lower()
        if not num_str:
            continue
        try:
            val = float(num_str.replace(",", ""))
        except ValueError:
            continue
        if unit in _MONEY_UNITS:
            amounts.append(val * _MONEY_UNITS[unit])
        elif unit.startswith(_TIME_UNIT_PREFIXES):
            if unit.startswith(("year", "yr")):
                months = val * 12
            elif unit.startswith(("week", "wk")):
                months = val / 4.345
            else:
                months = val
        elif val >= 100:
            # A bare number with no unit — only trust it as an amount if
            # it's large enough to plausibly be money, not a stray digit.
            amounts.append(val)
    return amounts, (round(months, 1) if months is not None else None)


_SCENARIO_MARKERS = re.compile(
    r"\b(what if|what happens if|what would happen if|suppose|imagine if|if i |"
    r"can i afford|how quickly can i|how soon can i|how long (would|will) it take)\b",
    re.IGNORECASE,
)
_INFORMATIONAL_MARKERS = re.compile(
    r"\b(what is my|what'?s my|whats my|how is my|how'?s my|how are my|"
    r"am i on track|what'?s the status of my|how much (do|have) i)\b",
    re.IGNORECASE,
)


def is_informational_question(text: str) -> bool:
    """True when the text explicitly asks about the user's own current state
    ("what is my net worth?"), as opposed to continuing a decision already
    under discussion. Exposed because the discovery layer needs exactly this
    distinction: a mid-conversation "so what should I do?" is a continuation,
    while "what did I spend last month?" is a change of subject."""
    return bool(_INFORMATIONAL_MARKERS.search(text.strip()))


def classify_intent(text: str) -> str:
    """Route between two fundamentally different jobs:

    - 'informational': a question about the user's CURRENT state ("what is
      my runway?") — answer directly from the same Ask Twin/RAG flow, no
      hypothetical to calculate.
    - 'scenario': a hypothetical change ("what if I invest ₹20k/month?") —
      run the full Understand -> Watch -> Simulate -> Recommend -> Teach ->
      Check pipeline with real calculations and a timeline.
    """
    t = text.strip()
    if _SCENARIO_MARKERS.search(t):
        return "scenario"
    if _INFORMATIONAL_MARKERS.search(t):
        return "informational"

    # Fallback for phrasing that doesn't hit either marker set: a concrete
    # hypothetical scenario type (with an amount/duration behind it) is a
    # scenario; anything else defaults to informational rather than forcing
    # a user into providing numbers for what was really just a question.
    scenario_type = classify_scenario(t)
    if scenario_type in ("invest_monthly", "emi_affordability", "increase_savings", "income_loss"):
        return "scenario"
    amounts, months = extract_tokens(t)
    if amounts or months:
        return "scenario"
    return "informational"


# Markers that a contribution repeats. Their presence is what separates a SIP
# from a one-off deployment of money already in hand, and the two produce very
# different projections from the same rupee figure.
_RECURRING_MARKERS = (
    "every month", "per month", "a month", "monthly", "each month", "/month",
    "p.m.", "sip", "every year", "per year", "annually", "each week", "weekly",
    "recurring", "systematic",
)


def is_recurring(text: str) -> bool:
    t = text.lower()
    return any(m in t for m in _RECURRING_MARKERS)


# ---------------------------------------------------------------------------
# Purchase and borrowing detection
#
# WHY THIS EXISTS: the classifier had no branch for the most common question a
# personal-finance product is ever asked — "should I buy X?" — so "buy a car
# worth 12 lakh on a 5 year loan at 9.5%" fell through to `generic`, which
# subtracts the full amount from surplus EVERY MONTH. A one-off ₹12,00,000 car
# was modelled as ₹12,00,000 a month and projected a net worth of −₹6.67 crore,
# while the stated 9.5% was parsed and then discarded before any calculation
# saw it. These branches make a one-time cost behave like a one-time cost and a
# financed cost behave like an amortised EMI.
# ---------------------------------------------------------------------------

def _word_re(words):
    """Word-boundary matcher. Substring tests are not safe here: a bare
    `"car" in text` also fires on "care" and "scarce"."""
    return re.compile(r"\b(?:" + "|".join(re.escape(w) for w in words) + r")s?\b", re.IGNORECASE)


_LOAN_RE = _word_re((
    "loan", "emi", "mortgage", "financed", "on finance", "instalment",
    "installment", "borrow", "borrowing", "down payment", "downpayment",
))

_PURCHASE_VERB_RE = _word_re((
    "buy", "buying", "bought", "purchase", "purchasing", "spend on",
    "spending on", "pay for", "paying for", "cost", "costing",
    "worth", "price of", "priced at", "afford a", "afford an", "afford the",
))

_BIG_TICKET_RE = _word_re((
    "car", "bike", "scooter", "vehicle", "house", "home", "flat", "apartment",
    "property", "land", "plot", "laptop", "phone", "iphone", "macbook", "tv",
    "furniture", "renovation", "watch", "jewellery", "jewelry",
    "vacation", "holiday", "trip", "wedding", "marriage",
    "mba", "masters", "degree", "course", "college", "tuition",
))

# The sentence already states a monthly instalment, so the amount in it is the
# EMI itself and must not be amortised a second time. Matched in both word
# orders ("EMI of 30,000" and "a 30,000 EMI") and checked before every purchase
# branch, so sentences that classified correctly before still do.
_EMI_AMOUNT_RE = re.compile(
    r"\bemi\b[^.\d]{0,20}(?:₹|rs\.?|inr)?\s*\d"
    r"|(?:₹|rs\.?|inr)?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakh|lac)?\s*"
    r"(?:per\s+month\s+|a\s+month\s+|monthly\s+)?emi\b"
    r"|\b(?:monthly\s+payment|loan\s+payment|instalment|installment)\b"
    r"[^.\d]{0,20}(?:₹|rs\.?|inr)?\s*\d",
    re.IGNORECASE,
)

_HAS_NUMBER_RE = re.compile(r"\d")

# Typical financing terms, used ONLY when the user gave a principal but no term
# or rate. Every result that leans on one says so in its assumptions.
_DEFAULT_TENURE_MONTHS = (
    (("house", "home", "flat", "apartment", "property", "land", "plot"), 240),
    (("mba", "masters", "degree", "course", "college", "tuition"), 84),
    (("car", "vehicle"), 60),
    (("bike", "scooter"), 36),
)
_FALLBACK_TENURE_MONTHS = 60

_DEFAULT_RATES = (
    (("house", "home", "flat", "apartment", "property", "land", "plot"), 0.085),
    (("mba", "masters", "degree", "course", "college", "tuition"), 0.105),
    (("car", "vehicle"), 0.095),
    (("bike", "scooter"), 0.115),
)
_FALLBACK_RATE = 0.11


def default_tenure_for(text: str) -> int:
    t = text.lower()
    for nouns, months in _DEFAULT_TENURE_MONTHS:
        if _word_re(nouns).search(t):
            return months
    return _FALLBACK_TENURE_MONTHS


def default_rate_for(text: str) -> float:
    t = text.lower()
    for nouns, rate in _DEFAULT_RATES:
        if _word_re(nouns).search(t):
            return rate
    return _FALLBACK_RATE


_RATE_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:%|per\s?cent|percent)", re.IGNORECASE)


def extract_rate(text: str):
    """Annual interest rate as a decimal ('9.5%' -> 0.095).

    The rate was previously parsed out of the sentence and then dropped before
    the calculation ever saw it, so a 9.5% loan and an interest-free one
    produced identical numbers."""
    m = _RATE_RE.search(text)
    if not m:
        return None
    try:
        pct = float(m.group(1))
    except ValueError:
        return None
    # A "percent" in a finance sentence is not always a lending rate ("30% of
    # my income"). Anything above 60% p.a. is not a credible consumer rate.
    if pct <= 0 or pct > 60:
        return None
    return pct / 100.0


def classify_purchase(text: str):
    """Distinguish the three ways money leaves in a buying decision.

    'emi_affordability' when the sentence states a monthly instalment,
    'loan_purchase' when it states a borrowed principal, 'one_time_purchase'
    when it is paid outright, None when it is not about buying anything."""
    t = text.lower()
    if _EMI_AMOUNT_RE.search(t):
        return "emi_affordability"
    has_loan = bool(_LOAN_RE.search(t))
    has_purchase = bool(_PURCHASE_VERB_RE.search(t) or _BIG_TICKET_RE.search(t))
    if has_loan and (has_purchase or _HAS_NUMBER_RE.search(t)):
        return "loan_purchase"
    if has_purchase:
        return "one_time_purchase"
    return None


def classify_scenario(text: str) -> str:
    t = text.lower()
    if any(k in t for k in ["no income", "lose my job", "lost my job", "without income", "stop earning", "unemployed", "income for"]):
        return "income_loss"
    if any(k in t for k in ["invest", "sip", "mutual fund", "index fund", "stock market"]):
        # A recurring marker keeps the original SIP behaviour. Without one the
        # money is already in hand ("I have 10,000, where should I invest?"),
        # which is a lump sum — projecting it as a monthly commitment would
        # overstate the outcome by the number of months in the horizon.
        return "invest_monthly" if is_recurring(t) else "invest_lumpsum"
    # Buying and borrowing are tested ahead of the original emi/afford keyword
    # line below so a stated principal is amortised rather than read as a
    # monthly payment. That line is left intact underneath, so any sentence
    # this new branch does not claim classifies exactly as it did before.
    purchase = classify_purchase(t)
    if purchase:
        return purchase
    if any(k in t for k in ["emi", "afford", "loan payment", "mortgage"]):
        return "emi_affordability"
    if any(k in t for k in ["increase my savings", "increase savings", "save extra", "save more", "boost my savings", "increase my monthly savings"]):
        return "increase_savings"
    if any(k in t for k in ["reach my goal", "savings goal", "my goal", "how quickly", "how soon", "how long"]):
        return "goal_timeline"
    return "generic"


def format_months(months: float) -> str:
    months = round(months)
    if months <= 0:
        return "0 months"
    if months % 12 == 0 and months >= 12:
        yrs = months // 12
        return f"{yrs} year" + ("s" if yrs != 1 else "")
    return f"{months} month" + ("s" if months != 1 else "")


def parse_scenario(text: str) -> Tuple[str, Dict[str, Any]]:
    scenario_type = classify_scenario(text)
    amounts, months = extract_tokens(text)
    params: Dict[str, Any] = {
        "amount": amounts[0] if amounts else None,
        "duration_months": months,
        "all_amounts_detected": amounts,
        # Recorded once here so the generic calculator can tell a genuine
        # monthly commitment from a one-off cost without re-reading the text.
        "is_recurring": is_recurring(text),
    }
    if scenario_type in ("invest_monthly", "invest_lumpsum") and params["duration_months"] is None:
        params["duration_months"] = 36
        params["duration_assumed"] = True
    if scenario_type == "income_loss" and params["duration_months"] is None:
        params["duration_months"] = 6
        params["duration_assumed"] = True
    if scenario_type in ("loan_purchase", "one_time_purchase") and amounts:
        # The price is the largest figure in the sentence. "A 12 lakh car on a
        # 5 year loan at 9.5%" puts price, tenure and rate in one string, and
        # extract_tokens has already routed the tenure to duration_months.
        params["amount"] = max(amounts)
    if scenario_type == "loan_purchase":
        rate = extract_rate(text)
        params["annual_rate"] = rate if rate is not None else default_rate_for(text)
        params["rate_assumed"] = rate is None
        if params["duration_months"] is None:
            params["duration_months"] = default_tenure_for(text)
            params["duration_assumed"] = True
    if scenario_type == "one_time_purchase":
        # Kept so that a price larger than the user's savings can be re-modelled
        # as the financed purchase it would have to be, on terms that suit the
        # thing being bought rather than a single flat default.
        params["financed_rate"] = default_rate_for(text)
        params["financed_tenure"] = default_tenure_for(text)
        if params["duration_months"] is None:
            params["duration_months"] = 36
            params["duration_assumed"] = True
    return scenario_type, params


def describe_understanding(scenario_type: str, params: Dict[str, Any], currency: str) -> str:
    label = scenario_type.replace("_", " ")
    parts = []
    if params.get("amount") is not None:
        parts.append(f"amount ≈ {currency}{group_indian(params['amount'])}")
    if params.get("duration_months") is not None:
        suffix = " (assumed)" if params.get("duration_assumed") else ""
        parts.append(f"duration ≈ {format_months(params['duration_months'])}{suffix}")
    detail = ("Detected " + ", ".join(parts) + ".") if parts else \
        "No specific amount or duration detected in the text, falling back to your current profile trends for a qualitative read."
    return f"Classified as a ‘{label}’ scenario. {detail}"


# ---------------------------------------------------------------------------
# 3. Deterministic calculators — one per scenario type
# ---------------------------------------------------------------------------

ASSUMED_ANNUAL_RETURN = 0.10
MILESTONE_CANDIDATES = [3, 6, 12, 24, 36]


def pick_milestones(total_months: float) -> List[int]:
    total_months = max(1, round(total_months))
    milestones = sorted(set([m for m in MILESTONE_CANDIDATES if m <= total_months] + [total_months]))
    return milestones


def sip_future_value(monthly_amount: float, months: int, annual_rate: float = ASSUMED_ANNUAL_RETURN) -> float:
    r = annual_rate / 12
    if monthly_amount <= 0 or months <= 0:
        return 0.0
    if r == 0:
        return monthly_amount * months
    return monthly_amount * (((1 + r) ** months - 1) / r) * (1 + r)


def calc_invest_monthly(ctx: FinancialContext, amount: float, months: float):
    amount = amount or 0
    months_i = round(months or 36)
    new_surplus = ctx.surplus - amount

    timeline = []
    running_savings = ctx.savings
    prev = 0
    for m in pick_milestones(months_i):
        running_savings += new_surplus * (m - prev)
        prev = m
        buffer = (running_savings / ctx.expenses) if ctx.expenses > 0 else None
        fv = sip_future_value(amount, m)
        invested = amount * m
        timeline.append({
            "label": format_months(m), "months": m,
            "invested_total": round(invested, 2),
            "projected_value": round(fv, 2),
            "estimated_gain": round(fv - invested, 2),
            "emergency_buffer_months": round(buffer, 1) if buffer is not None else None,
        })

    goal_progress_after_pct = None
    if ctx.goal_target:
        saved_so_far = ctx.goal_target * ((ctx.goal_progress_pct or 0) / 100)
        saved_after = min(saved_so_far + max(new_surplus, 0) * months_i, ctx.goal_target)
        goal_progress_after_pct = round((saved_after / ctx.goal_target) * 100, 1)

    impact = {
        "monthly_surplus_before": round(ctx.surplus, 2),
        "monthly_surplus_after": round(new_surplus, 2),
        "savings_impact": f"Liquid savings are untouched, {ctx.currency}{group_indian(amount)}/month is redirected into a new investment instead.",
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "emergency_buffer_after_months": timeline[-1]["emergency_buffer_months"] if timeline else None,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "goal_progress_after_pct": goal_progress_after_pct,
        "investment_contribution": round(amount, 2),
    }
    assumptions = [
        f"Assumes an average annual return of {ASSUMED_ANNUAL_RETURN*100:.0f}% (typical for a diversified equity/index fund), compounded monthly.",
        "Assumes the monthly contribution stays constant for the full period, and doesn't factor in taxes or fund fees.",
    ]
    risks = []
    if new_surplus < 0:
        risks.append(f"This commitment is larger than your current monthly surplus of {ctx.currency}{group_indian(ctx.surplus)}, you'd be investing more than you currently have left over each month.")
    elif ctx.buffer_months is not None and ctx.buffer_months < 3:
        risks.append(f"Your emergency buffer is already thin ({ctx.buffer_months:.1f} months). Consider building that up before committing new money to investments.")
    return impact, timeline, assumptions, risks


def calc_invest_lumpsum(ctx: FinancialContext, amount: float, months: float, annual_return: Optional[float] = None):
    """A one-off deployment of money already in hand.

    The counterpart to calc_invest_monthly, and the shape the discovery layer
    produces most often: "I have X, where should I put it?" is a lump sum, not
    a SIP. Monthly surplus is untouched (nothing recurring is committed); what
    changes is the emergency buffer, because the money moves out of liquid
    savings and into something that may be down when it is needed.
    """
    amount = amount or 0
    months_i = round(months or 36)
    rate = ASSUMED_ANNUAL_RETURN if annual_return is None else annual_return

    # The lump sum is assumed to come out of existing liquid savings, which is
    # the conservative read — if it is genuinely spare cash the user will say so,
    # and the buffer figure is reported before/after either way.
    savings_after = max(ctx.savings - amount, 0)
    buffer_after = (savings_after / ctx.expenses) if ctx.expenses > 0 else None

    timeline = []
    for m in pick_milestones(months_i):
        fv = amount * ((1 + rate / 12) ** m)
        # Savings keep growing from the ordinary monthly surplus alongside it.
        running_savings = savings_after + max(ctx.surplus, 0) * m
        timeline.append({
            "label": format_months(m), "months": m,
            "invested_total": round(amount, 2),
            "projected_value": round(fv, 2),
            "estimated_gain": round(fv - amount, 2),
            "projected_savings": round(running_savings, 2),
            "emergency_buffer_months": round(running_savings / ctx.expenses, 1) if ctx.expenses > 0 else None,
        })

    impact = {
        "monthly_surplus_before": round(ctx.surplus, 2),
        "monthly_surplus_after": round(ctx.surplus, 2),
        "lumpsum_invested": round(amount, 2),
        "savings_impact": (
            f"{ctx.currency}{group_indian(amount)} moves out of liquid savings into an investment; "
            f"your monthly cash flow is unchanged."
        ),
        "liquid_savings_before": round(ctx.savings, 2),
        "liquid_savings_after": round(savings_after, 2),
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "emergency_buffer_after_months": round(buffer_after, 1) if buffer_after is not None else None,
        "projected_value_at_horizon": timeline[-1]["projected_value"] if timeline else None,
        "estimated_gain_at_horizon": timeline[-1]["estimated_gain"] if timeline else None,
        "assumed_annual_return_pct": round(rate * 100, 1),
        "goal_progress_before_pct": ctx.goal_progress_pct,
    }
    assumptions = [
        f"Assumes an average annual return of {rate*100:.0f}%, compounded monthly, with the money left invested for the full period.",
        "Assumes the lump sum comes out of existing savings rather than from new income, and ignores taxes and exit loads.",
    ]
    risks = []
    if buffer_after is not None and buffer_after < 3:
        risks.append(
            f"Committing this leaves an emergency buffer of about {buffer_after:.1f} months, "
            f"below the 3-month floor, which risks a forced sale at a bad time."
        )
    if ctx.savings and amount > ctx.savings:
        risks.append(
            f"{ctx.currency}{group_indian(amount)} is more than your total savings of {ctx.currency}{group_indian(ctx.savings)}."
        )
    if months_i <= 24:
        risks.append(
            "Over a horizon this short, market returns are genuinely uncertain, the projected value "
            "is an average outcome, not a floor."
        )
    return impact, timeline, assumptions, risks


def calc_emi_affordability(ctx: FinancialContext, emi_amount: float):
    emi_amount = emi_amount or 0
    new_surplus = ctx.surplus - emi_amount
    foir = (emi_amount / ctx.income) if ctx.income > 0 else None

    timeline = []
    running_savings = ctx.savings
    prev = 0
    for m in pick_milestones(36):
        running_savings += new_surplus * (m - prev)
        prev = m
        buffer = (running_savings / ctx.expenses) if ctx.expenses > 0 else None
        timeline.append({
            "label": format_months(m), "months": m,
            "projected_savings": round(running_savings, 2),
            "emergency_buffer_months": round(buffer, 1) if buffer is not None else None,
        })

    goal_progress_after_pct = None
    if ctx.goal_target:
        saved_so_far = ctx.goal_target * ((ctx.goal_progress_pct or 0) / 100)
        saved_after = min(saved_so_far + max(new_surplus, 0) * 36, ctx.goal_target)
        goal_progress_after_pct = round((saved_after / ctx.goal_target) * 100, 1)

    if new_surplus < 0:
        verdict = "not recommended"
    elif foir is not None and foir > 0.4:
        verdict = "tight"
    else:
        verdict = "affordable"

    impact = {
        "monthly_surplus_before": round(ctx.surplus, 2),
        "monthly_surplus_after": round(new_surplus, 2),
        "savings_impact": f"Monthly savings capacity changes by {ctx.currency}{group_indian(emi_amount)} once this EMI starts.",
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "emergency_buffer_after_months": timeline[-1]["emergency_buffer_months"] if timeline else None,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "goal_progress_after_pct": goal_progress_after_pct,
        "foir_pct": round(foir * 100, 1) if foir is not None else None,
        "affordability_verdict": verdict,
    }
    assumptions = [
        "Uses the standard lending guideline that fixed obligations should stay under ~40% of gross monthly income (FOIR).",
        "Assumes income and expenses stay constant over the projection window.",
    ]
    risks = []
    if new_surplus < 0:
        risks.append(f"This EMI is larger than your current monthly surplus of {ctx.currency}{group_indian(ctx.surplus)}, you'd run a monthly deficit.")
    if foir is not None and foir > 0.4:
        risks.append(f"This EMI alone is {foir*100:.0f}% of your income, above the commonly recommended 40% fixed-obligation ceiling.")
    return impact, timeline, assumptions, risks


def calc_increase_savings(ctx: FinancialContext, amount: float):
    amount = amount or 0
    rate_before = ctx.monthly_savings_rate or max(ctx.surplus, 0)
    rate_after = rate_before + amount

    goal_remaining = None
    if ctx.goal_target and ctx.goal_progress_pct is not None:
        goal_remaining = ctx.goal_target * (1 - ctx.goal_progress_pct / 100)

    timeline = []
    savings_before = ctx.savings
    savings_after = ctx.savings
    prev = 0
    for m in pick_milestones(36):
        span = m - prev
        savings_before += rate_before * span
        savings_after += rate_after * span
        prev = m
        entry = {
            "label": format_months(m), "months": m,
            "savings_before": round(savings_before, 2),
            "savings_after": round(savings_after, 2),
            "extra_saved": round(savings_after - savings_before, 2),
        }
        timeline.append(entry)

    months_to_goal_before = (goal_remaining / rate_before) if goal_remaining and rate_before > 0 else None
    months_to_goal_after = (goal_remaining / rate_after) if goal_remaining and rate_after > 0 else None

    impact = {
        "monthly_surplus_before": round(ctx.surplus, 2),
        "monthly_surplus_after": round(ctx.surplus - amount, 2),
        "savings_impact": f"Monthly savings rate rises from {ctx.currency}{group_indian(rate_before)} to {ctx.currency}{group_indian(rate_after)}.",
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "emergency_buffer_after_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "goal_months_remaining_before": round(months_to_goal_before, 1) if months_to_goal_before else None,
        "goal_months_remaining_after": round(months_to_goal_after, 1) if months_to_goal_after else None,
        "investment_contribution": round(amount, 2),
    }
    assumptions = [
        f"Assumes the extra {ctx.currency}{group_indian(amount)}/month comes from reducing discretionary spending rather than new income.",
        "Goal timeline assumes your current savings trend continues at a constant monthly rate.",
    ]
    risks = []
    if amount > ctx.surplus:
        risks.append(f"This commitment is larger than your current monthly surplus of {ctx.currency}{group_indian(ctx.surplus)}, you'd be committing more extra savings than you currently have left over each month.")
    if ctx.expenses and amount > ctx.expenses * 0.5:
        risks.append("This is a large cut relative to your current monthly expenses. Double check it's realistic before committing.")
    return impact, timeline, assumptions, risks


def calc_goal_timeline(ctx: FinancialContext):
    if not ctx.goal_target:
        impact = {
            "goal_title": ctx.goal_title,
            "monthly_contribution_rate": round(ctx.monthly_savings_rate, 2) if ctx.monthly_savings_rate else None,
            "note": "No savings goal with a target amount was found on your profile.",
        }
        return impact, [], ["No savings goal is set on your profile, so a precise timeline can't be computed."], \
            ["Add a goal with a target amount to your profile to get a precise timeline."]

    saved_so_far = ctx.goal_target * ((ctx.goal_progress_pct or 0) / 100)
    remaining = max(ctx.goal_target - saved_so_far, 0)
    rate = ctx.monthly_savings_rate or 0
    months_to_goal = (remaining / rate) if rate > 0 else None
    horizon = min(months_to_goal, 60) if months_to_goal else 36

    timeline = []
    for m in pick_milestones(horizon):
        saved = min(saved_so_far + rate * m, ctx.goal_target)
        pct = (saved / ctx.goal_target) * 100
        timeline.append({
            "label": format_months(m), "months": m,
            "goal_progress_pct": round(pct, 1),
            "amount_saved": round(saved, 2),
        })

    impact = {
        "goal_title": ctx.goal_title,
        "goal_target": ctx.goal_target,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "monthly_contribution_rate": round(rate, 2),
        "months_to_goal": round(months_to_goal, 1) if months_to_goal else None,
    }
    assumptions = ["Assumes your savings continue growing at the recently observed monthly rate."]
    risks = []
    if rate <= 0:
        risks.append("Your current surplus/savings rate is zero or negative. The goal won't progress without a change in income, expenses, or contributions.")
    return impact, timeline, assumptions, risks


def calc_income_loss(ctx: FinancialContext, months: float):
    months_i = round(months or 6)
    timeline = []
    for m in pick_milestones(months_i):
        remaining = ctx.savings - ctx.expenses * m
        buffer = (max(remaining, 0) / ctx.expenses) if ctx.expenses > 0 else None
        timeline.append({
            "label": format_months(m), "months": m,
            "remaining_savings": round(max(remaining, 0), 2),
            "shortfall": round(max(-remaining, 0), 2),
            "emergency_buffer_months": round(buffer, 1) if buffer is not None else None,
        })

    coverage = ctx.buffer_months
    impact = {
        "monthly_surplus_before": round(ctx.surplus, 2),
        "monthly_surplus_after": round(-ctx.expenses, 2),
        "savings_impact": f"Savings deplete by {ctx.currency}{group_indian(ctx.expenses)}/month with no income coming in.",
        "emergency_buffer_before_months": round(coverage, 1) if coverage is not None else None,
        "emergency_buffer_after_months": timeline[-1]["emergency_buffer_months"] if timeline else None,
        "coverage_months": round(coverage, 1) if coverage is not None else None,
        "requested_months": months_i,
        "goal_progress_before_pct": ctx.goal_progress_pct,
    }
    assumptions = [
        "Assumes monthly expenses stay constant with zero income during the period.",
        "Assumes no other income sources, insurance payouts, severance, or borrowing kick in.",
    ]
    risks = []
    if coverage is not None and months_i > coverage:
        shortfall_total = ctx.expenses * (months_i - coverage)
        risks.append(f"Your emergency fund only covers about {coverage:.1f} months, you'd fall short by roughly {ctx.currency}{group_indian(shortfall_total)} over the full {months_i}-month period.")
    elif coverage is None:
        risks.append("No expense figure was found on your profile, so coverage couldn't be estimated.")
    return impact, timeline, assumptions, risks


def emi_for(principal: float, annual_rate: float, months: int) -> float:
    """Standard reducing-balance EMI. This is the calculation the simulator was
    missing entirely: a stated principal used to be subtracted from surplus at
    full value every month instead of being amortised."""
    if principal <= 0 or months <= 0:
        return 0.0
    r = (annual_rate or 0) / 12.0
    if r <= 0:
        return principal / months
    factor = (1 + r) ** months
    return principal * r * factor / (factor - 1)


def loan_outstanding(principal: float, annual_rate: float, months: int, elapsed: int) -> float:
    """Balance still owed after `elapsed` instalments."""
    if principal <= 0 or months <= 0:
        return 0.0
    elapsed = max(0, min(int(elapsed), int(months)))
    r = (annual_rate or 0) / 12.0
    if r <= 0:
        return max(principal * (1 - elapsed / months), 0.0)
    f_n = (1 + r) ** months
    f_k = (1 + r) ** elapsed
    return max(principal * (f_n - f_k) / (f_n - 1), 0.0)


def calc_loan_purchase(ctx: FinancialContext, principal: float, months: Optional[float],
                       annual_rate: Optional[float] = None, rate_assumed: bool = False,
                       duration_assumed: bool = False):
    """A purchase funded by borrowing: the monthly cost is the EMI, not the price."""
    principal = principal or 0
    if principal <= 0:
        return calc_generic(ctx, None, months)

    months_i = max(1, round(months or _FALLBACK_TENURE_MONTHS))
    rate = _FALLBACK_RATE if annual_rate is None else annual_rate
    emi = emi_for(principal, rate, months_i)
    total_paid = emi * months_i
    total_interest = max(total_paid - principal, 0.0)
    new_surplus = ctx.surplus - emi
    foir = (emi / ctx.income) if ctx.income > 0 else None

    timeline = []
    running_savings = ctx.savings
    prev = 0
    for m in pick_milestones(months_i):
        running_savings += new_surplus * (m - prev)
        prev = m
        buffer = (running_savings / ctx.expenses) if ctx.expenses > 0 else None
        timeline.append({
            "label": format_months(m), "months": m,
            "projected_savings": round(running_savings, 2),
            "loan_outstanding": round(loan_outstanding(principal, rate, months_i, m), 2),
            "emergency_buffer_months": round(buffer, 1) if buffer is not None else None,
        })

    if new_surplus < 0:
        verdict = "not recommended"
    elif foir is not None and foir > 0.4:
        verdict = "tight"
    elif ctx.buffer_months is not None and ctx.buffer_months < 3:
        verdict = "tight"
    else:
        verdict = "affordable"

    impact = {
        "purchase_price": round(principal, 2),
        "monthly_emi": round(emi, 2),
        "loan_tenure_months": months_i,
        "annual_interest_rate_pct": round(rate * 100, 2),
        "total_interest": round(total_interest, 2),
        "total_repayment": round(total_paid, 2),
        "monthly_surplus_before": round(ctx.surplus, 2),
        "monthly_surplus_after": round(new_surplus, 2),
        "savings_impact": (
            f"An EMI of {ctx.currency}{group_indian(emi)}/month for {format_months(months_i)}. "
            f"Over the full term you repay {ctx.currency}{group_indian(total_paid)}, of which "
            f"{ctx.currency}{group_indian(total_interest)} is interest."
        ),
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "emergency_buffer_after_months": timeline[-1]["emergency_buffer_months"] if timeline else None,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "foir_pct": round(foir * 100, 1) if foir is not None else None,
        "affordability_verdict": verdict,
    }

    assumptions = [
        f"Amortised {ctx.currency}{group_indian(principal)} over {format_months(months_i)} at "
        f"{rate * 100:.2f}% a year on a reducing balance.",
        "Assumes the full price is financed with no down payment; a down payment lowers the EMI proportionally.",
        "Assumes income and expenses stay constant over the term, and excludes insurance, registration and running costs.",
    ]
    if rate_assumed:
        assumptions.append(
            f"No interest rate was given, so an indicative {rate * 100:.2f}% a year was used. "
            "Change the rate in your question to model your actual offer."
        )
    if duration_assumed:
        assumptions.append(f"No tenure was given, so {format_months(months_i)} was assumed.")

    risks = []
    if new_surplus < 0:
        risks.append(
            f"This EMI of {ctx.currency}{group_indian(emi)} is larger than your monthly surplus of "
            f"{ctx.currency}{group_indian(ctx.surplus)}. You would run a monthly deficit of "
            f"{ctx.currency}{group_indian(abs(new_surplus))} and draw down savings to service it."
        )
    if foir is not None and foir > 0.4:
        risks.append(
            f"This EMI alone is {foir * 100:.0f}% of your gross income, above the ~40% "
            "fixed-obligation ceiling most lenders apply."
        )
    if total_interest > principal * 0.35:
        risks.append(
            f"Interest adds {ctx.currency}{group_indian(total_interest)} — about "
            f"{total_interest / principal * 100:.0f}% on top of the price. A shorter tenure cuts this materially."
        )
    if ctx.buffer_months is not None and ctx.buffer_months < 6:
        risks.append(
            f"Your emergency buffer is about {ctx.buffer_months:.1f} months. Taking on a fixed "
            "monthly obligation before reaching six months of cover raises the cost of any income shock."
        )
    return impact, timeline, assumptions, risks


def calc_one_time_purchase(ctx: FinancialContext, amount: Optional[float], months: Optional[float],
                           financed_rate: Optional[float] = None,
                           financed_tenure: Optional[int] = None):
    """A purchase paid for outright: savings take the hit once, not every month.

    When the price is larger than everything the user has saved, paying outright
    is not a thing that can happen, and projecting savings deep into the negative
    to say so is how the old engine produced −₹9.43 crore for an ₹80 lakh house.
    In that case the purchase is re-modelled the only way it could actually be
    made — financed — and labelled as such."""
    if not amount:
        return calc_generic(ctx, None, months)

    if amount > ctx.savings:
        tenure = financed_tenure or _FALLBACK_TENURE_MONTHS
        rate = _FALLBACK_RATE if financed_rate is None else financed_rate
        impact, timeline, assumptions, risks = calc_loan_purchase(
            ctx, amount, tenure, rate, rate_assumed=True, duration_assumed=True
        )
        impact["exceeds_savings"] = True
        impact["savings_before"] = round(ctx.savings, 2)
        impact["shortfall_if_paid_outright"] = round(amount - ctx.savings, 2)
        assumptions.insert(0, (
            f"{ctx.currency}{group_indian(amount)} is more than your total savings of "
            f"{ctx.currency}{group_indian(ctx.savings)}, so this is modelled as a financed purchase "
            "rather than a cash one."
        ))
        return impact, timeline, assumptions, risks

    months_i = max(1, round(months or 36))
    savings_after = ctx.savings - amount
    buffer_after = (max(savings_after, 0) / ctx.expenses) if ctx.expenses > 0 else None

    timeline = []
    running_savings = savings_after
    prev = 0
    for m in pick_milestones(months_i):
        running_savings += ctx.surplus * (m - prev)
        prev = m
        buffer = (running_savings / ctx.expenses) if ctx.expenses > 0 else None
        timeline.append({
            "label": format_months(m), "months": m,
            "projected_savings": round(running_savings, 2),
            "emergency_buffer_months": round(buffer, 1) if buffer is not None else None,
        })

    months_to_rebuild = None
    if ctx.surplus > 0:
        months_to_rebuild = amount / ctx.surplus

    # savings_after is non-negative here by construction: the over-savings case
    # returned above as a financed purchase.
    affordable_now = savings_after >= 0
    if buffer_after is not None and buffer_after < 3:
        verdict = "tight"
    else:
        verdict = "affordable"

    impact = {
        "purchase_price": round(amount, 2),
        "one_time_cost": True,
        "savings_before": round(ctx.savings, 2),
        "savings_after": round(savings_after, 2),
        "monthly_surplus_before": round(ctx.surplus, 2),
        # A cash purchase does not change what you clear each month; saying so
        # explicitly is what stops this being read as a recurring commitment.
        "monthly_surplus_after": round(ctx.surplus, 2),
        "savings_impact": (
            f"A one-time cost of {ctx.currency}{group_indian(amount)}. Your monthly surplus is unchanged at "
            f"{ctx.currency}{group_indian(ctx.surplus)}; the money comes out of savings once."
        ),
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "emergency_buffer_after_months": round(buffer_after, 1) if buffer_after is not None else None,
        "months_to_rebuild_savings": round(months_to_rebuild, 1) if months_to_rebuild else None,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "affordability_verdict": verdict,
    }

    assumptions = [
        "Treated this as a one-time cost paid from savings, not a recurring monthly commitment.",
        "Assumes income and expenses continue at their current level afterwards.",
    ]
    risks = []

    if buffer_after is not None and buffer_after < 3:
        risks.append(
            f"Paying this from savings leaves about {buffer_after:.1f} months of expenses in reserve, "
            "below the three-month minimum most planners treat as the floor."
        )

    if months_to_rebuild and months_to_rebuild > 12:
        risks.append(
            f"At your current surplus it would take about {format_months(months_to_rebuild)} to rebuild "
            "the savings this uses."
        )
    return impact, timeline, assumptions, risks


def calc_generic(ctx: FinancialContext, amount: Optional[float], months: Optional[float],
                 recurring: Optional[bool] = None):
    months_i = round(months) if months else 12
    timeline = []
    if amount:
        # An amount several times larger than what the user actually clears in a
        # month is far more likely to be a one-off cost than a new monthly
        # commitment. Reading every unclassified amount as recurring is what
        # turned a ₹12,00,000 car into ₹12,00,000 a month. An explicit recurring
        # marker in the text ("per month", "SIP") still wins outright.
        surplus_ref = max(ctx.surplus, 0.0)
        treat_recurring = bool(recurring) or (surplus_ref > 0 and amount <= 3 * surplus_ref)
        if not treat_recurring:
            return calc_one_time_purchase(ctx, amount, months_i)
        new_surplus = ctx.surplus - amount
        running_savings = ctx.savings
        prev = 0
        for m in pick_milestones(months_i):
            running_savings += new_surplus * (m - prev)
            prev = m
            timeline.append({
                "label": format_months(m), "months": m,
                "projected_savings": round(running_savings, 2),
            })
        impact = {
            "monthly_surplus_before": round(ctx.surplus, 2),
            "monthly_surplus_after": round(new_surplus, 2),
            "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
            "goal_progress_before_pct": ctx.goal_progress_pct,
        }
        assumptions = [f"Treated {ctx.currency}{group_indian(amount)} as a recurring monthly amount since the scenario didn't map to a specific known pattern."]
    else:
        impact = {
            "monthly_surplus_before": round(ctx.surplus, 2),
            "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
            "goal_progress_before_pct": ctx.goal_progress_pct,
            "note": "No specific amount or duration was detected in this scenario.",
        }
        assumptions = ["No numeric amount was detected in the scenario text, so this shows your current baseline only."]
    risks = []
    if not amount:
        risks.append("Try including a number and time frame (e.g. ‘₹20,000/month for 2 years’) for a precise, calculated answer instead of a qualitative one.")
    return impact, timeline, assumptions, risks


def run_calculator(scenario_type: str, ctx: FinancialContext, params: Dict[str, Any]):
    amount = params.get("amount")
    months = params.get("duration_months")
    if scenario_type == "invest_monthly":
        return calc_invest_monthly(ctx, amount or 0, months or 36)
    if scenario_type == "invest_lumpsum":
        return calc_invest_lumpsum(ctx, amount or 0, months or 36, params.get("annual_return"))
    if scenario_type == "emi_affordability":
        return calc_emi_affordability(ctx, amount or 0)
    if scenario_type == "increase_savings":
        return calc_increase_savings(ctx, amount or 0)
    if scenario_type == "goal_timeline":
        return calc_goal_timeline(ctx)
    if scenario_type == "income_loss":
        return calc_income_loss(ctx, months or 6)
    if scenario_type == "loan_purchase":
        return calc_loan_purchase(
            ctx, amount or 0, months or _FALLBACK_TENURE_MONTHS,
            params.get("annual_rate"),
            bool(params.get("rate_assumed")),
            bool(params.get("duration_assumed")),
        )
    if scenario_type == "one_time_purchase":
        return calc_one_time_purchase(
            ctx, amount, months or 36,
            params.get("financed_rate"), params.get("financed_tenure"),
        )
    return calc_generic(ctx, amount, months, params.get("is_recurring"))


def validate_result(ctx: FinancialContext, scenario_type: str, params: Dict[str, Any]) -> List[str]:
    """The Check stage: deterministic sanity checks on the inputs that fed
    the calculation, surfaced as risk notes."""
    notes = []
    if ctx.income == 0:
        notes.append("No income figure was found on your profile. Results involving surplus may be unreliable.")
    if ctx.expenses == 0:
        notes.append("No expense figure was found on your profile, buffer/runway figures may be unreliable.")
    if scenario_type in ("invest_monthly", "invest_lumpsum", "emi_affordability", "increase_savings") and params.get("amount") is None:
        notes.append("No amount was detected in the scenario text. The numbers shown fall back to defaults rather than your specific figure.")
    return notes


# The Check stage used to inspect only the INPUTS, which is why every absurd
# projection was still stamped "Validated calculation inputs. No red flags
# found." A result can be arithmetically correct and financially impossible at
# the same time; printing one costs more credibility than printing nothing.
IMPLAUSIBLE_DEFICIT_MONTHS = 12


def assess_plausibility(ctx: FinancialContext, scenario_type: str,
                        impact: Dict[str, Any], timeline: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Decide whether a computed result is fit to show the user.

    Returns {'plausible': bool, 'problems': [str]}. `income_loss` is exempt from
    the deficit floor because running savings down is the entire point of that
    scenario — the user asked what happens when the income stops."""
    problems: List[str] = []
    monthly_ref = max(ctx.income, ctx.expenses, 1.0)

    after = impact.get("monthly_surplus_after")
    if (isinstance(after, (int, float)) and ctx.income > 0
            and after < -ctx.income and scenario_type != "income_loss"):
        problems.append(
            "the monthly outflow it implies is larger than your entire monthly income"
        )

    if scenario_type != "income_loss":
        worst = None
        for row in timeline or []:
            for key in ("projected_savings", "remaining_savings", "projected_value"):
                v = row.get(key)
                if isinstance(v, (int, float)):
                    worst = v if worst is None else min(worst, v)
        if worst is not None and worst < -IMPLAUSIBLE_DEFICIT_MONTHS * monthly_ref:
            problems.append(
                f"the projection runs more than {IMPLAUSIBLE_DEFICIT_MONTHS} months of income "
                "into deficit, which normally means the scenario was read differently than you meant it"
            )

    return {"plausible": not problems, "problems": problems}


def not_modelled_result(ctx: FinancialContext, problems: List[str]):
    """What to show instead of an implausible projection.

    Deliberately still returns the user's real baseline — refusing to model a
    scenario is not a reason to blank the screen."""
    reason = problems[0] if problems else "the numbers it produced were not credible"
    impact = {
        "not_modelled": True,
        "monthly_surplus_before": round(ctx.surplus, 2),
        "emergency_buffer_before_months": round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None,
        "goal_progress_before_pct": ctx.goal_progress_pct,
        "note": (
            "This scenario could not be modelled reliably, so no projection is shown: "
            f"{reason}."
        ),
    }
    assumptions = [
        "No projection was produced for this scenario. The figures above are your current position only.",
    ]
    risks = [
        "Rephrasing with an explicit amount, time frame and whether it is one-time or monthly "
        "(for example ‘a one-time ₹12,00,000 car on a 5 year loan at 9.5%’) will produce a calculated answer.",
    ]
    return impact, [], assumptions, risks


# ---------------------------------------------------------------------------
# 5. Chat -> Simulation bridge
#
# When the chatbot's discovery layer has already established what the decision
# is, Simulation should not go back to guessing it out of a sentence. These
# helpers let a structured DecisionContext drive the same deterministic
# calculators the typed-scenario path uses — same math, better inputs.
# ---------------------------------------------------------------------------

# Return assumptions per risk posture. Stated once, here, so the alternatives
# the user compares are anchored to the same numbers the recommendation was.
# These are long-run averages for broad asset classes, not forecasts.
RISK_TIER_RETURNS = {
    "capital_preservation": (0.065, "Capital-preservation focused",
                             "Debt funds, FDs and short-duration instruments. Value is stable; growth is modest."),
    "balanced": (0.10, "Balanced growth",
                 "A mix of equity and debt. Meaningful growth with drawdowns you can usually wait out."),
    "higher_growth": (0.14, "Higher growth / higher risk",
                      "Equity-heavy. The widest range of outcomes in both directions."),
}


# The vocabulary the discovery layer produces for these two preferences. Both
# are matched leniently because they come from a conversation, not a dropdown:
# a user who says they have "low" tolerance for losing capital is asking for the
# same modelling as one who says "none".
# Whole answers that mean "I am not willing to lose capital". These come from a
# conversation rather than a dropdown, so a plain set lookup is not enough: the
# same intent arrives as "no", as "none", and as "cannot afford loss".
_LOW_LOSS_WORDS = {"no", "none", "nil", "zero", "low", "minimal", "very low", "not much", "very little"}
_LOW_LOSS_PHRASES = (
    "cannot afford", "can't afford", "cant afford", "cannot lose", "can't lose", "cant lose",
    "no loss", "zero loss", "not willing", "preserve", "protect the capital", "safe",
)
_LOW_GROWTH_APPETITE = {"low", "conservative", "capital_preservation", "preservation", "capital preservation"}
_HIGH_GROWTH_APPETITE = {"high", "aggressive", "very high", "maximum", "max"}


def _prefers_capital_preservation(loss_pref: str, growth_pref: str) -> bool:
    """Whether the user has told us, in whatever words, to keep the money safe.

    Getting this wrong is not cosmetic: it decides which return is modelled and
    which of the alternative paths is marked as matching what they asked for. A
    user who said "no" to losing capital being shown a balanced-equity option as
    "matches what you said" would be the system misquoting them."""
    if growth_pref in _LOW_GROWTH_APPETITE:
        return True
    if loss_pref in _LOW_LOSS_WORDS:
        return True
    return any(phrase in loss_pref for phrase in _LOW_LOSS_PHRASES)


def params_from_decision_context(ctx: FinancialContext, context: Dict[str, Any]) -> Tuple[str, Dict[str, Any]]:
    """Turn a discovered DecisionContext into (scenario_type, params).

    Deliberately forgiving about which fields are present: the discovery layer
    only ever sends what the conversation actually established, so a missing
    horizon here means "the user never said", not "an error". Missing values
    fall back to the same defaults parse_scenario() uses, and are marked as
    assumed so the Check stage can surface them."""
    sim_type = (context.get("simulation_type") or "").strip() or None
    decision_type = (context.get("decision_type") or "").strip()

    if not sim_type:
        sim_type = {
            "investment": "invest_monthly" if context.get("recurring") else "invest_lumpsum",
            "loan": "emi_affordability",
            "purchase": "emi_affordability",
            "savings": "increase_savings",
            "goal_planning": "goal_timeline",
            "retirement": "invest_monthly",
            "debt_payoff": "increase_savings",
            "income_change": "income_loss",
        }.get(decision_type, "generic")

    # An investment context that says it recurs overrides a stale sim type.
    if sim_type == "invest_lumpsum" and context.get("recurring"):
        sim_type = "invest_monthly"

    amount = context.get("amount")
    horizon_years = context.get("time_horizon_years")
    duration_months = float(horizon_years) * 12 if horizon_years else None

    params: Dict[str, Any] = {
        "amount": float(amount) if amount not in (None, "") else None,
        "duration_months": duration_months,
        "all_amounts_detected": [float(amount)] if amount not in (None, "") else [],
        "from_decision_context": True,
    }

    if duration_months is None and sim_type in ("invest_monthly", "invest_lumpsum"):
        params["duration_months"] = 36
        params["duration_assumed"] = True
    if duration_months is None and sim_type == "income_loss":
        params["duration_months"] = 6
        params["duration_assumed"] = True

    # A stated intolerance for capital loss changes the return that should be
    # modelled, not just the wording around it.
    constraints = context.get("risk_constraints") or {}
    loss_pref = (constraints.get("capital_loss_preference") or "").lower()
    growth_pref = (constraints.get("growth_preference") or "").lower()
    if _prefers_capital_preservation(loss_pref, growth_pref):
        params["annual_return"] = RISK_TIER_RETURNS["capital_preservation"][0]
    elif growth_pref in _HIGH_GROWTH_APPETITE:
        params["annual_return"] = RISK_TIER_RETURNS["higher_growth"][0]

    return sim_type, params


def describe_context_understanding(scenario_type: str, context: Dict[str, Any], currency: str) -> str:
    """The Understand stage's summary when the facts came from a conversation
    rather than from a sentence. Says what was carried over, so the user can
    see that nothing was re-guessed."""
    bits = []
    if context.get("amount"):
        bits.append(f"amount {currency}{group_indian(float(context['amount']))}")
    if context.get("objective"):
        bits.append(f"objective '{str(context['objective']).replace('_', ' ')}'")
    if context.get("time_horizon_years"):
        bits.append(f"horizon {context['time_horizon_years']:g} year(s)")
    constraints = context.get("risk_constraints") or {}
    if constraints.get("capital_loss_preference"):
        bits.append(f"capital-loss tolerance '{constraints['capital_loss_preference']}'")
    if constraints.get("growth_preference"):
        bits.append(f"growth preference '{constraints['growth_preference']}'")
    detail = ", ".join(bits) if bits else "no specific figures were established"
    return (
        f"Carried over from your conversation with the Twin, {detail}. "
        f"Modelled as a '{scenario_type.replace('_', ' ')}' scenario; nothing was re-asked or re-guessed."
    )


def build_alternative_paths(
    scenario_type: str,
    ctx: FinancialContext,
    params: Dict[str, Any],
    context: Optional[Dict[str, Any]] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Model realistic alternatives to the path the conversation landed on.

    Simulation's job is to show consequences, not to ratify the chatbot's
    recommendation — so an investment decision comes back as three genuinely
    different postures the user can compare, each computed with the same
    deterministic math and its own return assumption. `is_aligned` marks the
    one matching what the user said they wanted; it is not a recommendation,
    and the other two are returned at equal weight.

    Returns None for scenario types where risk posture isn't the axis that
    matters — an EMI's affordability doesn't change with your fund choice."""
    if scenario_type not in ("invest_lumpsum", "invest_monthly"):
        return None

    amount = params.get("amount") or 0
    if amount <= 0:
        return None
    months = round(params.get("duration_months") or 36)
    context = context or {}
    constraints = context.get("risk_constraints") or {}
    loss_pref = (constraints.get("capital_loss_preference") or "").lower()
    growth_pref = (constraints.get("growth_preference") or "").lower()

    aligned_key = "balanced"
    if _prefers_capital_preservation(loss_pref, growth_pref):
        aligned_key = "capital_preservation"
    elif growth_pref in _HIGH_GROWTH_APPETITE:
        aligned_key = "higher_growth"

    # A plausible trough, not a worst case — labelled as such on every row so
    # the comparison is not read as all upside.
    troughs = {
        "invest_lumpsum": {"capital_preservation": 0.03, "balanced": 0.18, "higher_growth": 0.33},
        "invest_monthly": {"capital_preservation": 0.02, "balanced": 0.14, "higher_growth": 0.26},
    }[scenario_type]

    paths: List[Dict[str, Any]] = []
    for key, (rate, label, description) in RISK_TIER_RETURNS.items():
        if scenario_type == "invest_lumpsum":
            invested = amount
            projected = amount * ((1 + rate / 12) ** months)
        else:
            invested = amount * months
            projected = sip_future_value(amount, months, rate)
        drawdown = troughs[key]

        caveats = []
        if months <= 24 and key == "higher_growth":
            caveats.append("Over 2 years or less, equity has a real chance of being down when you need the money.")
        if ctx.buffer_months is not None and ctx.buffer_months < 3 and key != "capital_preservation":
            caveats.append(
                f"Your reserve is {ctx.buffer_months:.1f} months. This posture assumes you won't have to sell early."
            )

        paths.append({
            "key": key,
            "label": label,
            "description": description,
            "assumed_annual_return_pct": round(rate * 100, 1),
            "invested_total": round(invested, 2),
            "projected_value": round(projected, 2),
            "estimated_gain": round(projected - invested, 2),
            "horizon_months": months,
            "plausible_trough_value": round(projected * (1 - drawdown), 2),
            "plausible_trough_note": (
                f"Roughly {drawdown * 100:.0f}% below the projected value in a bad stretch. "
                "Not a worst case, and not a floor."
            ),
            "is_aligned": key == aligned_key,
            "caveats": caveats,
        })

    return paths
