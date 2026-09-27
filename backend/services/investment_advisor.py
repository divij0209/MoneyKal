"""
Deterministic investment advice — every number in a recommendation is computed here.

The rule this module exists to enforce: the LLM never invents a rupee, a
percentage, an allocation or an assumption. It phrases what this file computes,
and nothing else. That is the same contract `financial_simulator` already holds
for Simulation; this is its counterpart for the conversational recommendation
that Ask Twin gives once the investment profile is complete.

Four things happen here, in order:

  1. `reconcile_risk`      — tolerance (how much loss the user can stomach) and
                             capacity (how much their finances can absorb) are
                             separate readings. The lower of the two governs.
  2. `check_return_feasibility` — a desired return implies a required amount of
                             risk, and that risk implies a required horizon.
                             Where those don't line up, say so plainly.
  3. `compute_investable_amount` — what can responsibly go in, after the
                             emergency gap and monthly commitments.
  4. `build_recommendation` — allocation, expected range, downside, liquidity
                             implications and the reasons behind each.

Every table in this file is stated, sourced from long-run behaviour of broad
Indian asset classes, and labelled as an assumption wherever it surfaces. None
of it is a forecast, and none of it is generated.
"""
from backend.core.money import group_indian
from dataclasses import dataclass, asdict, field
from typing import Any, Dict, List, Optional, Tuple

from backend.services.financial_simulator import FinancialContext, RISK_TIER_RETURNS
from backend.services.risk_profile import RiskDNA


# --- Risk bands -------------------------------------------------------------
# One ordered vocabulary shared by tolerance, capacity and the resulting
# strategy, so "low" means the same thing in all three places and the two can
# actually be compared rather than just described.
RISK_BANDS = ("low", "moderate", "high")

# How a stated tolerance in the user's own words maps onto that vocabulary.
# Matched longest-phrase-first so "not very comfortable" doesn't read as
# "comfortable".
_TOLERANCE_PHRASES: List[Tuple[str, str]] = [
    ("cannot afford", "low"), ("can't afford", "low"), ("cant afford", "low"),
    ("cannot lose", "low"), ("can't lose", "low"), ("no loss", "low"),
    ("zero loss", "low"), ("not comfortable", "low"), ("very little", "low"),
    ("very low", "low"), ("uneasy", "low"), ("conservative", "low"),
    ("preserve", "low"), ("safe", "low"), ("minimal", "low"), ("nervous", "low"),
    ("some risk", "moderate"), ("moderate", "moderate"), ("balanced", "moderate"),
    ("medium", "moderate"), ("a bit", "moderate"), ("somewhat", "moderate"),
    ("for better returns", "moderate"),
    ("aggressive", "high"), ("very high", "high"), ("high risk", "high"),
    ("a lot", "high"), ("comfortable", "high"),
    ("i'd hold", "high"), ("id hold", "high"), ("i would hold", "high"),
]
# Deliberately NOT in the list above: "long-term" and a bare "hold". Both appear
# constantly in goal statements — "long-term wealth building" is an objective,
# not a declaration of risk appetite — and reading one as the other silently
# pushes someone into an equity-heavy allocation they never agreed to.
_TOLERANCE_EXACT = {
    "no": "low", "none": "low", "nil": "low", "zero": "low", "low": "low",
    "moderate": "moderate", "medium": "moderate", "some": "moderate",
    "high": "high", "aggressive": "high", "yes": "high",
}


def classify_tolerance(text: Any) -> Optional[str]:
    """Read a stated risk tolerance out of the user's own words.

    Returns None when nothing recognisable was said — which is a meaningful
    answer here, because an unstated tolerance must stay unstated rather than
    being assumed to be "moderate"."""
    if text is None:
        return None
    t = str(text).strip().lower()
    if not t:
        return None
    if t in _TOLERANCE_EXACT:
        return _TOLERANCE_EXACT[t]
    for phrase, band in sorted(_TOLERANCE_PHRASES, key=lambda p: -len(p[0])):
        if phrase in t:
            return band
    return None


def _band_index(band: Optional[str]) -> Optional[int]:
    return RISK_BANDS.index(band) if band in RISK_BANDS else None


@dataclass
class RiskReconciliation:
    """Tolerance and capacity, held apart and then reconciled.

    Kept as two separate readings on purpose. Collapsing them loses the single
    most useful thing the twin can tell someone: whether the limit on their
    investing is their nerves or their bank balance, because those have very
    different fixes."""
    tolerance_band: Optional[str] = None
    tolerance_basis: str = "Not stated yet."
    capacity_band: Optional[str] = None
    capacity_score: Optional[int] = None
    capacity_basis: str = ""
    effective_band: str = "low"
    governed_by: str = "capacity"          # tolerance | capacity | both
    conflict: Optional[str] = None
    explanation: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def reconcile_risk(dna: RiskDNA, stated_tolerance: Any = None) -> RiskReconciliation:
    """Hold tolerance and capacity apart, then let the lower one govern.

    Capacity is arithmetic and is never overridden by a preference: wanting to
    take more risk does not create the reserve that would make it survivable.
    Tolerance is never overridden either — a user who says they cannot watch a
    drawdown should not be handed one because their balance sheet could take it.
    So the strategy follows the lower of the two, and the conflict is named."""
    r = RiskReconciliation()

    r.capacity_band = dna.capacity_band if dna.capacity_band in RISK_BANDS else None
    r.capacity_score = dna.capacity_score
    r.capacity_basis = "; ".join(dna.capacity_drivers[:3]) or "Computed from your stored figures."

    tolerance = classify_tolerance(stated_tolerance) or classify_tolerance(dna.stated_tolerance) \
        or classify_tolerance(dna.loss_comfort)
    r.tolerance_band = tolerance
    if tolerance:
        r.tolerance_basis = f"You described your comfort with fluctuation as {tolerance}."

    t_i, c_i = _band_index(tolerance), _band_index(r.capacity_band)

    if t_i is None and c_i is None:
        r.effective_band = "low"
        r.governed_by = "capacity"
        r.explanation = (
            "Neither your risk comfort nor a full picture of your finances is established yet, "
            "so the safest reading is used until it is."
        )
        return r

    if t_i is None:
        r.effective_band = RISK_BANDS[c_i]
        r.governed_by = "capacity"
        r.explanation = (
            f"Your finances can support {RISK_BANDS[c_i]} risk. How much fluctuation you're "
            "personally comfortable with hasn't been established, so that's still worth saying."
        )
        return r

    if c_i is None:
        r.effective_band = RISK_BANDS[t_i]
        r.governed_by = "tolerance"
        r.explanation = f"Going by the {tolerance} risk comfort you described."
        return r

    lower = min(t_i, c_i)
    r.effective_band = RISK_BANDS[lower]

    if t_i == c_i:
        r.governed_by = "both"
        r.explanation = (
            f"Your risk comfort and what your finances can absorb both point to {RISK_BANDS[lower]} "
            "risk, so there's no tension to resolve here."
        )
    elif t_i > c_i:
        r.governed_by = "capacity"
        r.conflict = "tolerance_exceeds_capacity"
        r.explanation = (
            f"You're comfortable with {RISK_BANDS[t_i]} risk, but your finances can currently absorb "
            f"{RISK_BANDS[c_i]}. That's a capacity limit, not a nerve one. It's the harder of the two "
            "to argue with, because a bad year would force a sale rather than just feel unpleasant. "
            "Strengthening the reserve is what lifts it."
        )
    else:
        r.governed_by = "tolerance"
        r.conflict = "capacity_exceeds_tolerance"
        r.explanation = (
            f"Your finances could support {RISK_BANDS[c_i]} risk, but you've said you're comfortable "
            f"with {RISK_BANDS[t_i]}. That's a legitimate choice and it's the one being followed, "
            "the cost is some long-run return, not safety."
        )
    return r


# --- Allocation model -------------------------------------------------------
# Stated allocations per (risk band, horizon). Equity needs time to be sensible,
# so the horizon caps the equity share regardless of appetite: this is the
# single most important guard in the file, and it is arithmetic rather than
# advice. Values are percentages of the invested amount.
#
# growth  = equity / equity-oriented funds
# stable  = debt funds, bonds, FDs
# liquid  = liquid/overnight funds, savings
ALLOCATION_TABLE: Dict[Tuple[str, str], Dict[str, int]] = {
    # Under 3 years: equity is not appropriate at any appetite — the horizon is
    # too short for a drawdown to reliably recover.
    ("low", "short"):        {"growth": 0,  "stable": 60, "liquid": 40},
    ("moderate", "short"):   {"growth": 10, "stable": 70, "liquid": 20},
    ("high", "short"):       {"growth": 20, "stable": 65, "liquid": 15},
    # 3-7 years.
    ("low", "medium"):       {"growth": 20, "stable": 65, "liquid": 15},
    ("moderate", "medium"):  {"growth": 45, "stable": 45, "liquid": 10},
    ("high", "medium"):      {"growth": 65, "stable": 30, "liquid": 5},
    # 7 years and beyond.
    ("low", "long"):         {"growth": 30, "stable": 60, "liquid": 10},
    ("moderate", "long"):    {"growth": 60, "stable": 35, "liquid": 5},
    ("high", "long"):        {"growth": 80, "stable": 18, "liquid": 2},
}

# Long-run annual return assumptions per sleeve, as (low, base, high). Stated
# once, used for every projection, and surfaced to the user as assumptions.
SLEEVE_RETURNS = {
    "growth": (0.04, 0.12, 0.16),
    "stable": (0.055, 0.070, 0.085),
    "liquid": (0.030, 0.045, 0.055),
}

# A plausible peak-to-trough fall per sleeve in a bad stretch. Not a worst case
# and not a floor — labelled as such everywhere it is shown.
SLEEVE_DRAWDOWN = {"growth": 0.35, "stable": 0.05, "liquid": 0.005}

SLEEVE_LABELS = {
    "growth": "Growth (equity / equity funds)",
    "stable": "Stability (debt funds, bonds, FDs)",
    "liquid": "Liquid (liquid funds, savings)",
}

# The minimum horizon each risk posture really needs, in years. Used by the
# return-feasibility check to explain a horizon conflict in concrete terms.
MIN_HORIZON_YEARS = {"low": 0.0, "moderate": 3.0, "high": 7.0}


def horizon_bucket(years: Optional[float]) -> str:
    """Short (<3y), medium (3-7y) or long (7y+).

    An unknown horizon is treated as short, which is the conservative reading:
    it caps equity rather than assuming time the user never said they had."""
    if years is None:
        return "short"
    if years < 3:
        return "short"
    if years < 7:
        return "medium"
    return "long"


def allocation_for(risk_band: str, horizon_years: Optional[float],
                   liquidity_need: Any = None) -> Dict[str, int]:
    """The allocation for a risk band and horizon, adjusted for stated liquidity.

    A user who says the money must stay accessible gets a larger liquid sleeve
    taken out of growth, because accessibility and equity exposure are the two
    things that genuinely trade off against each other."""
    bucket = horizon_bucket(horizon_years)
    band = risk_band if risk_band in RISK_BANDS else "low"
    alloc = dict(ALLOCATION_TABLE[(band, bucket)])

    need = str(liquidity_need or "").lower()
    if any(k in need for k in ("accessible", "immediate", "any time", "anytime", "within a year", "must stay")):
        shift = min(20, alloc["growth"])
        alloc["growth"] -= shift
        alloc["liquid"] += shift
    return alloc


def blended_return(alloc: Dict[str, int]) -> Tuple[float, float, float]:
    """(low, base, high) annual return for an allocation, weighted by sleeve."""
    lo = sum(SLEEVE_RETURNS[s][0] * pct for s, pct in alloc.items()) / 100
    base = sum(SLEEVE_RETURNS[s][1] * pct for s, pct in alloc.items()) / 100
    hi = sum(SLEEVE_RETURNS[s][2] * pct for s, pct in alloc.items()) / 100
    return lo, base, hi


def blended_drawdown(alloc: Dict[str, int]) -> float:
    return sum(SLEEVE_DRAWDOWN[s] * pct for s, pct in alloc.items()) / 100


# --- Return feasibility -----------------------------------------------------

@dataclass
class ReturnFeasibility:
    """Whether a desired return is reachable at the risk and horizon available."""
    desired_return_pct: Optional[float] = None
    achievable_base_pct: Optional[float] = None
    achievable_high_pct: Optional[float] = None
    required_band: Optional[str] = None
    required_horizon_years: Optional[float] = None
    verdict: str = "not_assessed"   # realistic | ambitious | unrealistic | not_assessed
    conflicts: List[str] = field(default_factory=list)
    explanation: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _band_for_target(target_pct: float, horizon_years: Optional[float]) -> Optional[str]:
    """The mildest risk posture whose base case reaches the target."""
    for band in RISK_BANDS:
        _lo, base, _hi = blended_return(allocation_for(band, horizon_years))
        if base * 100 >= target_pct:
            return band
    return None


def check_return_feasibility(
    desired_return_pct: Optional[float],
    horizon_years: Optional[float],
    effective_band: str,
    reconciliation: RiskReconciliation,
) -> ReturnFeasibility:
    """Compare what the user wants against what their risk and horizon allow.

    This is the check that stops a desired return being quietly treated as a
    promise. It answers three separate questions — what does this return
    require, can this user take that much risk, and do they have the time it
    needs — and reports each conflict on its own terms."""
    f = ReturnFeasibility(desired_return_pct=desired_return_pct)

    alloc = allocation_for(effective_band, horizon_years)
    lo, base, hi = blended_return(alloc)
    f.achievable_base_pct = round(base * 100, 1)
    f.achievable_high_pct = round(hi * 100, 1)

    if desired_return_pct is None:
        f.verdict = "not_assessed"
        f.explanation = (
            f"On the strategy your profile supports, a reasonable central expectation is about "
            f"{f.achievable_base_pct}% a year. An average over time, not a rate you're paid."
        )
        return f

    required = _band_for_target(desired_return_pct, horizon_years)
    f.required_band = required
    if required:
        f.required_horizon_years = MIN_HORIZON_YEARS[required]

    # 1. Is the target reachable at all, at any risk level this horizon allows?
    if required is None:
        f.verdict = "unrealistic"
        article = "An" if str(int(desired_return_pct)).startswith(("8", "11", "18")) else "A"
        f.conflicts.append(
            f"{article} {desired_return_pct:g}% annual return is above what any allocation appropriate "
            f"to a {horizon_years:g}-year horizon has historically delivered on average."
            if horizon_years else
            f"{article} {desired_return_pct:g}% annual return is above what a diversified portfolio has "
            f"historically delivered on average."
        )
    # 2. Reachable, but only by taking more risk than this user should.
    elif _band_index(required) > _band_index(effective_band):
        f.verdict = "ambitious"
        governed = ("your finances can currently absorb"
                    if reconciliation.governed_by == "capacity"
                    else "you said you're comfortable with")
        f.conflicts.append(
            f"Reaching {desired_return_pct:g}% would need a {required}-risk allocation, but "
            f"{governed} {effective_band} risk. Those two can't both be satisfied."
        )
    else:
        f.verdict = "realistic"

    # 3. Independently of appetite: does the horizon support the required risk?
    if required and horizon_years is not None and horizon_years < MIN_HORIZON_YEARS[required]:
        f.conflicts.append(
            f"A {required}-risk allocation needs roughly {MIN_HORIZON_YEARS[required]:g}+ years to be "
            f"sensible, and you've described a {horizon_years:g}-year horizon. Over a period that "
            f"short there's a real chance of being down when you need the money."
        )
        if f.verdict == "realistic":
            f.verdict = "ambitious"

    if f.verdict == "realistic":
        f.explanation = (
            f"{desired_return_pct:g}% is within reach of the strategy your profile supports, which has a "
            f"central expectation of about {f.achievable_base_pct}% a year. Good years and bad years "
            f"still vary widely around that."
        )
    elif f.verdict == "ambitious":
        f.explanation = (
            f"{desired_return_pct:g}% is above the roughly {f.achievable_base_pct}% central expectation of "
            f"the strategy that fits you. It isn't impossible in a good stretch, the upside case is "
            f"around {f.achievable_high_pct}%, but planning on it would be planning on luck."
        )
    else:
        f.explanation = (
            f"{desired_return_pct:g}% a year isn't a realistic planning assumption. The strategy that fits "
            f"your profile centres on about {f.achievable_base_pct}%, with an upside case near "
            f"{f.achievable_high_pct}%."
        )
    return f


# --- Investable amount ------------------------------------------------------

@dataclass
class InvestableAmount:
    """How much can responsibly go in, and what limited it."""
    requested: Optional[float] = None
    recommended: float = 0.0
    is_recurring: bool = False
    emergency_gap: float = 0.0
    monthly_surplus: float = 0.0
    liquid_available: float = 0.0
    constrained_by: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# The reserve a household should hold before money is locked into growth
# assets, in months of expenses. Deeper for variable income, because the gap
# between paycheques is the thing the reserve has to bridge.
EMERGENCY_TARGET_MONTHS = 3.0
EMERGENCY_TARGET_MONTHS_VARIABLE = 6.0


def compute_investable_amount(
    ctx: FinancialContext,
    dna: RiskDNA,
    requested: Optional[float],
    is_recurring: bool,
    user_insisted: bool = False,
) -> InvestableAmount:
    """What the user can reasonably invest, given everything else they owe.

    Returns a number and the reasons behind it rather than a yes/no, because
    "you can put in ₹4,000 of the ₹10,000 now" is almost always a more useful
    answer than either "go ahead" or "don't". When the user has explicitly
    insisted, the requested figure is honoured and the shortfall is reported as
    a consequence rather than as a refusal."""
    out = InvestableAmount(requested=requested, is_recurring=is_recurring)

    target_months = (EMERGENCY_TARGET_MONTHS_VARIABLE
                     if dna.income_stability == "variable" else EMERGENCY_TARGET_MONTHS)
    target_reserve = ctx.expenses * target_months if ctx.expenses else 0.0
    out.emergency_gap = round(max(target_reserve - (ctx.savings or 0.0), 0.0), 2)
    out.monthly_surplus = round(ctx.surplus, 2)
    out.liquid_available = round(max((ctx.savings or 0.0) - target_reserve, 0.0), 2)

    if is_recurring:
        # A monthly commitment is bounded by monthly surplus, and only part of
        # it — leaving the whole surplus committed means any surprise breaks
        # the plan in month one.
        ceiling = max(out.monthly_surplus * 0.7, 0.0)
        out.recommended = min(requested, ceiling) if requested else ceiling
        if requested and requested > ceiling:
            out.constrained_by.append("monthly_surplus")
            out.notes.append(
                f"A {ctx.currency}{group_indian(requested)}/month commitment against a "
                f"{ctx.currency}{group_indian(out.monthly_surplus)} surplus leaves almost no room for a bad "
                f"month. {ctx.currency}{group_indian(ceiling)}/month keeps roughly 30% of the surplus free."
            )
        if out.emergency_gap > 0:
            out.constrained_by.append("emergency_gap")
            out.notes.append(
                f"Your reserve is {ctx.currency}{group_indian(out.emergency_gap)} short of "
                f"{target_months:g} months of expenses. Directing part of the monthly amount there "
                f"first closes that gap in about "
                f"{max(1, round(out.emergency_gap / max(ceiling, 1))):g} months."
            )
    else:
        # A lump sum comes out of liquid savings, so the reserve is the binding
        # constraint rather than the surplus.
        ceiling = out.liquid_available
        out.recommended = min(requested, ceiling) if requested else ceiling
        if requested and requested > ceiling:
            out.constrained_by.append("emergency_gap" if out.emergency_gap > 0 else "liquid_savings")
            if out.emergency_gap > 0:
                out.notes.append(
                    f"Investing the full {ctx.currency}{group_indian(requested)} would leave your reserve "
                    f"{ctx.currency}{group_indian(out.emergency_gap)} short of {target_months:g} months of "
                    f"expenses, so a job gap or a medical bill would mean selling at whatever the "
                    f"market happens to be doing."
                )
            else:
                out.notes.append(
                    f"{ctx.currency}{group_indian(ceiling)} is what sits above a {target_months:g}-month reserve."
                )

    if dna.likely_high_interest_debt:
        out.constrained_by.append("high_interest_debt")
        out.notes.append(
            "There's evidence of card or EMI debt on your profile. Clearing that is a guaranteed "
            "return at the loan's rate, which is usually higher than this portfolio's expected return."
        )

    if user_insisted and requested:
        # The user has heard the constraint and chosen to proceed. Respect it:
        # the number becomes theirs, and the consequence is stated once.
        out.recommended = requested
        out.notes.append(
            "Going with your figure as you asked, the trade-off above is the cost of it, not a reason "
            "you can't."
        )

    out.recommended = round(max(out.recommended, 0.0), 2)
    return out


# --- The recommendation -----------------------------------------------------

@dataclass
class InvestmentRecommendation:
    """Everything a recommendation needs, all of it computed.

    Handed to the LLM as facts to phrase. Nothing in here is generated, so a
    reply can be checked against it line by line."""
    currency: str = "₹"
    investable: Dict[str, Any] = field(default_factory=dict)
    risk: Dict[str, Any] = field(default_factory=dict)
    feasibility: Dict[str, Any] = field(default_factory=dict)
    allocation: List[Dict[str, Any]] = field(default_factory=list)
    horizon_years: Optional[float] = None
    horizon_bucket: str = "short"
    expected_return: Dict[str, Any] = field(default_factory=dict)
    projection: Dict[str, Any] = field(default_factory=dict)
    downside: Dict[str, Any] = field(default_factory=dict)
    liquidity: Dict[str, Any] = field(default_factory=dict)
    rationale: List[str] = field(default_factory=list)
    priorities_first: List[Dict[str, Any]] = field(default_factory=list)
    assumptions: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _future_value(amount: float, annual_rate: float, years: float, recurring: bool) -> float:
    months = max(round(years * 12), 1)
    r = annual_rate / 12
    if recurring:
        if r == 0:
            return amount * months
        return amount * (((1 + r) ** months - 1) / r) * (1 + r)
    return amount * ((1 + r) ** months)


def build_recommendation(
    ctx: FinancialContext,
    dna: RiskDNA,
    slots: Dict[str, Any],
    user_insisted: bool = False,
) -> InvestmentRecommendation:
    """Assemble the full, deterministic investment recommendation.

    `slots` is whatever the conversation established. Missing entries degrade
    the output rather than breaking it: an absent horizon is treated as short,
    an absent desired return simply skips the feasibility comparison."""
    from backend.agents.discovery import parse_horizon_years  # local: avoids a cycle

    cur = ctx.currency or "₹"
    rec = InvestmentRecommendation(currency=cur)

    # --- inputs -------------------------------------------------------------
    horizon = parse_horizon_years(slots.get("time_horizon"))
    rec.horizon_years = horizon
    rec.horizon_bucket = horizon_bucket(horizon)

    mode = str(slots.get("contribution_mode") or "").lower()
    is_recurring = any(k in mode for k in ("sip", "month", "recur", "systematic", "every"))

    amount = slots.get("amount")
    try:
        amount = float(str(amount).replace(",", "").replace(cur, "").strip()) if amount not in (None, "") else None
    except (TypeError, ValueError):
        amount = None

    # --- 1. tolerance vs capacity ------------------------------------------
    reconciliation = reconcile_risk(dna, slots.get("risk_tolerance") or slots.get("capital_loss_comfort"))
    rec.risk = reconciliation.to_dict()

    # --- 2. desired return vs risk and horizon ------------------------------
    desired = _parse_percent(slots.get("desired_return"))
    feasibility = check_return_feasibility(desired, horizon, reconciliation.effective_band, reconciliation)
    rec.feasibility = feasibility.to_dict()

    # --- 3. how much can actually go in -------------------------------------
    investable = compute_investable_amount(ctx, dna, amount, is_recurring, user_insisted)
    rec.investable = investable.to_dict()

    # --- 4. allocation and what follows from it -----------------------------
    alloc = allocation_for(reconciliation.effective_band, horizon, slots.get("liquidity_need"))
    invest_amt = investable.recommended
    rec.allocation = [
        {
            "sleeve": sleeve,
            "label": SLEEVE_LABELS[sleeve],
            "pct": pct,
            "amount": round(invest_amt * pct / 100, 2),
            "amount_is_monthly": is_recurring,
        }
        for sleeve, pct in alloc.items() if pct > 0
    ]

    lo, base, hi = blended_return(alloc)
    rec.expected_return = {
        "low_pct": round(lo * 100, 1),
        "base_pct": round(base * 100, 1),
        "high_pct": round(hi * 100, 1),
        "note": "A range of long-run averages, not a rate of interest. Any single year can fall outside it.",
    }

    if invest_amt > 0 and horizon:
        rec.projection = {
            "horizon_years": horizon,
            "invested_total": round(invest_amt * (round(horizon * 12) if is_recurring else 1), 2),
            "low_value": round(_future_value(invest_amt, lo, horizon, is_recurring), 2),
            "base_value": round(_future_value(invest_amt, base, horizon, is_recurring), 2),
            "high_value": round(_future_value(invest_amt, hi, horizon, is_recurring), 2),
        }

    dd = blended_drawdown(alloc)
    rec.downside = {
        "plausible_drawdown_pct": round(dd * 100, 1),
        "on_current_amount": round(invest_amt * dd, 2),
        "note": (
            f"In a bad stretch this mix could plausibly fall about {dd * 100:.0f}% before recovering. "
            "That is a realistic trough, not a worst case and not a floor."
        ),
        # The caveat without the figure, for callers that have already stated it.
        "caveat": "That's a realistic trough rather than a worst case, and not a floor.",
    }

    rec.liquidity = {
        "liquid_pct": alloc["liquid"],
        "liquid_amount": round(invest_amt * alloc["liquid"] / 100, 2),
        "emergency_gap_after": investable.emergency_gap,
        "note": _liquidity_note(alloc, investable, cur, rec.horizon_bucket),
    }

    # --- 5. why this matches, in facts --------------------------------------
    rec.rationale = _rationale(ctx, dna, reconciliation, feasibility, investable, alloc, horizon, cur)
    rec.priorities_first = list(dna.blocking_priorities)
    rec.assumptions = [
        "Return ranges are long-run averages for broad asset classes, not forecasts or guarantees.",
        f"Emergency reserve target is {EMERGENCY_TARGET_MONTHS_VARIABLE if dna.income_stability == 'variable' else EMERGENCY_TARGET_MONTHS:g} months of your stated expenses.",
        "Figures ignore taxes, exit loads and fund fees, which reduce real returns.",
        "Assumes your stated income and expenses hold for the period.",
    ]
    return rec


def _parse_percent(value: Any) -> Optional[float]:
    """Read a desired return out of "12%", "12 percent", "around 12", 12."""
    if value is None or value == "":
        return None
    import re
    m = re.search(r"(\d+(?:\.\d+)?)", str(value))
    if not m:
        return None
    pct = float(m.group(1))
    # A figure like 0.12 is a fraction; anything above 100 isn't a return.
    if pct <= 1:
        pct *= 100
    return pct if 0 < pct <= 100 else None


def _liquidity_note(alloc, investable: InvestableAmount, cur: str, bucket: str) -> str:
    parts = [
        f"About {alloc['liquid']}% stays in liquid instruments you can reach within a day or two."
    ]
    if alloc["growth"] >= 40:
        parts.append(
            "The growth portion should be treated as untouchable for the full horizon, selling it "
            "early is what turns a dip into a loss."
        )
    if investable.emergency_gap > 0:
        parts.append(
            f"Your emergency reserve is still {cur}{investable.emergency_gap:,.0f} short, so this "
            "portfolio is not a substitute for it."
        )
    if bucket == "short":
        parts.append("Over a short horizon the whole point is that the money is there when you need it.")
    return " ".join(parts)


def _rationale(ctx, dna, reconciliation, feasibility, investable, alloc, horizon, cur) -> List[str]:
    """The specific, checkable reasons this strategy fits this person."""
    reasons = [reconciliation.explanation]

    if horizon is not None:
        bucket = horizon_bucket(horizon)
        if bucket == "short":
            reasons.append(
                f"A {horizon:g}-year horizon is the binding constraint: it caps growth exposure at "
                f"{alloc['growth']}% regardless of appetite, because equity needs time to recover from "
                "a bad year."
            )
        elif bucket == "long":
            reasons.append(
                f"A {horizon:g}-year horizon is long enough for the growth sleeve ({alloc['growth']}%) "
                "to ride out a downturn, which is what makes it appropriate here."
            )
        else:
            reasons.append(
                f"A {horizon:g}-year horizon supports a {alloc['growth']}% growth sleeve, enough to "
                "matter, not so much that a bad final year would derail it."
            )

    if dna.emergency_buffer_months is not None:
        reasons.append(
            f"Your reserve covers {dna.emergency_buffer_months:.1f} months of expenses, which is what "
            f"sets the {alloc['liquid']}% liquid sleeve and the "
            f"{cur}{investable.recommended:,.0f} figure."
        )

    if dna.dependents:
        reasons.append(
            f"{dna.dependents} dependent(s) make an income interruption costlier, which argues for the "
            "steadier side of the range."
        )
    if dna.income_stability == "variable":
        reasons.append(
            "Variable income means the reserve has to be deeper before money is locked away."
        )
    if feasibility.conflicts:
        reasons.extend(feasibility.conflicts)
    return [r for r in reasons if r]


# --- Readiness --------------------------------------------------------------
# The information without which a recommendation would be guesswork. Everything
# else improves the answer; these change it.
BLOCKING_SLOTS = ("purpose", "time_horizon", "amount", "contribution_mode", "risk_tolerance")


def missing_blocking_slots(slots: Dict[str, Any], known: Dict[str, Any]) -> List[str]:
    """Which of the must-haves are still unanswered.

    `known` is what the Financial Twin already holds, so anything on file is
    never counted as missing — the user is not asked for it again."""
    merged = {**known, **{k: v for k, v in slots.items() if v not in (None, "")}}
    missing = [s for s in BLOCKING_SLOTS if not merged.get(s)]
    # Either phrasing of the risk question satisfies the risk requirement —
    # they are two ways of asking the same thing.
    if "risk_tolerance" in missing and merged.get("capital_loss_comfort"):
        missing.remove("risk_tolerance")
    return missing


def render_recommendation_text(rec: InvestmentRecommendation) -> str:
    """The recommendation written out directly, with no LLM involved.

    Reached when the phrasing call fails or no key is configured. Because every
    figure was already computed, an outage costs the user some warmth of tone —
    not the advice itself, and not a single number of it.
    """
    cur = rec.currency
    inv = rec.investable
    per = "/month" if inv.get("is_recurring") else ""
    lines: List[str] = []

    amount = inv.get("recommended", 0)
    lines.append(f"**Invest {cur}{amount:,.0f}{per}**, here's how that breaks down.")

    requested = inv.get("requested")
    if requested and amount < requested:
        lines.append("")
        lines.append(
            f"That's below the {cur}{requested:,.0f}{per} you mentioned. "
            + " ".join(inv.get("notes", [])[:2])
        )

    lines.append("")
    for a in rec.allocation:
        lines.append(f"- **{a['pct']}% {a['label']}**: {cur}{a['amount']:,.0f}{per}")

    er = rec.expected_return
    if er:
        lines.append("")
        lines.append(
            f"Expected return sits in the **{er['low_pct']}% to {er['high_pct']}%** range, centring on "
            f"about **{er['base_pct']}%** a year. {er['note']}"
        )

    dn = rec.downside
    if dn:
        lines.append(
            f"The other side of that: a bad stretch could plausibly take this down about "
            f"**{dn['plausible_drawdown_pct']}%**, roughly {cur}{dn['on_current_amount']:,.0f} on "
            f"this amount. {dn.get('caveat', '')}"
        )

    proj = rec.projection
    if proj:
        lines.append("")
        lines.append(
            f"Over {proj['horizon_years']:g} years, {cur}{proj['invested_total']:,.0f} invested could "
            f"land anywhere between {cur}{proj['low_value']:,.0f} and {cur}{proj['high_value']:,.0f}, "
            f"with {cur}{proj['base_value']:,.0f} as the central case."
        )

    if rec.rationale:
        lines.append("")
        lines.append("**Why this fits you:** " + " ".join(rec.rationale[:3]))

    conflicts = (rec.feasibility or {}).get("conflicts") or []
    if conflicts:
        lines.append("")
        lines.append("**Worth being straight about:** " + " ".join(conflicts))

    if rec.liquidity.get("note"):
        lines.append("")
        lines.append(rec.liquidity["note"])

    return "\n".join(lines)
