"""
Financial Risk DNA — the deterministic half of the twin's risk understanding.

Everything in this module is computed from figures the user actually gave us
(Profile.metrics / raw_inputs, the Hisaab ledger, upcoming payments). It never
guesses, and it never collapses a person into a single
conservative/moderate/aggressive word, because that word is the least useful
thing about them: two people with identical "moderate" labels can have wildly
different capacity to absorb a loss.

The split that matters here:

  - Risk CAPACITY is arithmetic. How many months of expenses are covered, how
    much debt sits against income, how many people depend on this income, how
    much is already invested. We can compute all of it, so we do.
  - Risk TOLERANCE is a preference. Nothing in a bank statement reveals whether
    someone can sleep through a 20% drawdown. So this module deliberately
    reports it as *unknown* until the user says so in conversation, and the
    discovery layer (backend/agents/discovery.py) treats that as one of the
    gaps worth a question.

`blocking_priorities` is the other half of the point. When someone with no
emergency buffer and an active EMI asks which stock to buy, the honest answer
is not a stock. Those priorities are computed here, deterministically, so the
challenge the chatbot issues is grounded in the user's own numbers rather than
in an LLM's mood.
"""
from backend.core.money import group_indian
from dataclasses import dataclass, asdict, field
from typing import Any, Dict, List, Optional

from backend.services.financial_simulator import FinancialContext


# Bands are stated once here so the prompt, the API payload and any future UI
# all describe the same thresholds with the same words.
RESERVE_BANDS = [
    (0.5, "none", "Effectively no emergency reserve"),
    (3.0, "thin", "Less than 3 months of expenses covered"),
    (6.0, "adequate", "3-6 months of expenses covered"),
    (float("inf"), "strong", "More than 6 months of expenses covered"),
]

DEBT_BANDS = [
    (0.01, "none", "No outstanding debt recorded"),
    (0.35, "light", "Debt under ~35% of annual income"),
    (1.0, "moderate", "Debt between ~35% and one year of income"),
    (float("inf"), "heavy", "Debt exceeds a full year of income"),
]

# Occupation keywords that imply variable/lumpy income. Deliberately small and
# conservative — anything unmatched stays "unknown" rather than being guessed,
# because a wrong stability read changes every recommendation downstream.
_VARIABLE_INCOME_HINTS = (
    "freelance", "self employed", "self-employed", "founder", "entrepreneur",
    "consultant", "contract", "gig", "business owner", "trader", "artist",
    "commission", "startup",
)
_STABLE_INCOME_HINTS = (
    "salaried", "employee", "engineer", "developer", "teacher", "professor",
    "government", "psu", "manager", "analyst", "doctor", "nurse", "officer",
)

# Categories/event types that usually carry a high interest rate. We never see
# the rate itself, so this is stated as "likely", never as fact.
_HIGH_INTEREST_MARKERS = ("credit_card", "credit card", "personal_loan", "personal loan")


@dataclass
class RiskDNA:
    """A multi-dimensional read of the user's risk position.

    Serialized straight into the discovery prompt and into the decision context
    handed to Simulation, so every field is either a number we computed or an
    explicit None meaning "we don't know this yet"."""

    currency: str = "₹"

    # --- Capacity: computed from real figures ------------------------------
    emergency_buffer_months: Optional[float] = None
    reserve_band: str = "unknown"
    reserve_note: str = "No expense figure on file, so coverage can't be computed."

    monthly_surplus: float = 0.0
    savings_rate_pct: Optional[float] = None

    outstanding_debt: float = 0.0
    debt_to_annual_income_pct: Optional[float] = None
    debt_band: str = "unknown"
    likely_high_interest_debt: bool = False
    high_interest_evidence: List[str] = field(default_factory=list)

    dependents: int = 0
    insurance_cover: float = 0.0
    insurance_cover_years_of_income: Optional[float] = None
    insurance_band: str = "unknown"

    existing_investments: float = 0.0
    investment_exposure_pct: Optional[float] = None

    income_stability: str = "unknown"
    income_stability_basis: str = "No occupation recorded."

    capacity_score: int = 0
    capacity_band: str = "unknown"
    capacity_drivers: List[str] = field(default_factory=list)

    # --- Tolerance & purpose: NOT computable, only discoverable ------------
    stated_tolerance: Optional[str] = None
    stated_horizon_years: Optional[float] = None
    stated_objective: Optional[str] = None
    loss_comfort: Optional[str] = None

    # --- Derived judgement -------------------------------------------------
    blocking_priorities: List[Dict[str, Any]] = field(default_factory=list)
    constraints: List[str] = field(default_factory=list)
    unknowns: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def summary_line(self) -> str:
        """One sentence for prompts and CTA copy — deliberately not a label."""
        parts = [f"risk capacity {self.capacity_band} ({self.capacity_score}/100)"]
        if self.emergency_buffer_months is not None:
            parts.append(f"{self.emergency_buffer_months:.1f} months of reserve")
        if self.debt_band not in ("unknown", "none"):
            parts.append(f"{self.debt_band} debt load")
        parts.append(
            f"stated tolerance {self.stated_tolerance}" if self.stated_tolerance
            else "stated tolerance not yet known"
        )
        return "; ".join(parts)


def _band(value: Optional[float], bands) -> tuple:
    if value is None:
        return "unknown", "Not enough data to place this."
    for ceiling, name, note in bands:
        if value < ceiling:
            return name, note
    return bands[-1][1], bands[-1][2]


def _classify_income_stability(profile: Any) -> tuple:
    raw = profile.raw_inputs or {}
    occupation = str(raw.get("occupation") or "").lower().strip()
    if getattr(profile, "key", "") == "startup":
        return "variable", "Founder/startup profile, income is inherently lumpy."
    if not occupation:
        return "unknown", "No occupation recorded."
    for hint in _VARIABLE_INCOME_HINTS:
        if hint in occupation:
            return "variable", f"Occupation '{occupation}' suggests variable income."
    for hint in _STABLE_INCOME_HINTS:
        if hint in occupation:
            return "stable", f"Occupation '{occupation}' suggests regular salaried income."
    return "unknown", f"Occupation '{occupation}' doesn't clearly imply stable or variable income."


def _detect_high_interest_debt(db: Any, profile: Any) -> tuple:
    """Look for evidence of the debt that should out-rank an investment.

    We can never see an interest rate — no route in this app collects one — so
    this reports what it actually found (a credit-card obligation, an EMI) and
    lets the wording downstream stay honest about it being an inference."""
    evidence: List[str] = []
    if db is None:
        return False, evidence
    try:
        from backend.models.domain import UpcomingPayment, StartupTransaction

        rows = (db.query(UpcomingPayment)
                .filter(UpcomingPayment.profile_id == profile.id,
                        UpcomingPayment.is_active.is_(True),
                        (UpcomingPayment.status.is_(None)) | (UpcomingPayment.status == "confirmed"))
                .all())
        for r in rows:
            marker = f"{r.event_type or ''} {r.category or ''}".lower()
            if any(m in marker for m in _HIGH_INTEREST_MARKERS):
                evidence.append(f"Recurring {r.event_type or r.category} obligation: {r.name}")
            elif (r.event_type or "").lower() == "emi":
                evidence.append(f"Active EMI on file: {r.name}")

        txns = (db.query(StartupTransaction)
                .filter(StartupTransaction.profile_id == profile.id,
                        StartupTransaction.type == "out")
                .all())
        for t in txns:
            cat = (t.category or "").lower()
            if any(m in cat for m in _HIGH_INTEREST_MARKERS):
                evidence.append(f"Ledger shows '{t.category}' spending")
                break
    except Exception:
        # A risk read must never take down a chat turn. Missing evidence just
        # means we fall back to the debt-to-income band computed above.
        return False, evidence

    # Dedupe while preserving order, and keep the list short enough to prompt with.
    seen, unique = set(), []
    for e in evidence:
        if e not in seen:
            seen.add(e)
            unique.append(e)
    return bool(unique), unique[:4]


def _score_capacity(dna: RiskDNA) -> tuple:
    """A transparent 0-100 capacity score with its reasons attached.

    Every component is additive and named, so the score can be explained to the
    user rather than asserted at them. This is capacity only — it says nothing
    about whether they *want* risk."""
    score = 50
    drivers: List[str] = []

    if dna.emergency_buffer_months is not None:
        if dna.emergency_buffer_months >= 6:
            score += 20
            drivers.append(f"Strong reserve ({dna.emergency_buffer_months:.1f} months) raises capacity.")
        elif dna.emergency_buffer_months >= 3:
            score += 8
            drivers.append(f"Reserve of {dna.emergency_buffer_months:.1f} months is adequate but not deep.")
        elif dna.emergency_buffer_months >= 1:
            score -= 12
            drivers.append(f"Thin reserve ({dna.emergency_buffer_months:.1f} months) limits how much risk is survivable.")
        else:
            score -= 22
            drivers.append("Almost no emergency reserve. A shock would force selling at the worst time.")

    if dna.savings_rate_pct is not None:
        if dna.savings_rate_pct >= 30:
            score += 12
            drivers.append(f"Saving {dna.savings_rate_pct:.0f}% of income adds real capacity.")
        elif dna.savings_rate_pct >= 10:
            score += 5
            drivers.append(f"Saving {dna.savings_rate_pct:.0f}% of income is a positive but modest cushion.")
        elif dna.savings_rate_pct <= 0:
            score -= 18
            drivers.append("Monthly outflow meets or exceeds income. No new money is available to put at risk.")

    if dna.debt_band == "heavy":
        score -= 20
        drivers.append("Debt exceeds a year of income, which caps risk-taking regardless of preference.")
    elif dna.debt_band == "moderate":
        score -= 10
        drivers.append("A moderate debt load competes with any new investment for the same rupees.")
    elif dna.debt_band == "none":
        score += 8
        drivers.append("No outstanding debt on file.")

    if dna.likely_high_interest_debt:
        score -= 10
        drivers.append("Evidence of likely high-interest debt (card/EMI), paying it down is a guaranteed return.")

    if dna.dependents >= 3:
        score -= 10
        drivers.append(f"{dna.dependents} dependents make income loss costlier.")
    elif dna.dependents >= 1:
        score -= 4
        drivers.append(f"{dna.dependents} dependent(s) reduce how much volatility is comfortable.")

    if dna.income_stability == "variable":
        score -= 10
        drivers.append("Variable income means a bigger reserve is needed before taking market risk.")
    elif dna.income_stability == "stable":
        score += 6
        drivers.append("Stable salaried income supports a longer risk horizon.")

    if dna.insurance_band == "none" and dna.dependents > 0:
        score -= 6
        drivers.append("Dependents with no insurance cover on file is an unhedged risk.")

    score = max(0, min(100, score))
    band = "low" if score < 40 else ("moderate" if score < 70 else "high")
    return score, band, drivers


def _blocking_priorities(dna: RiskDNA, ctx: FinancialContext) -> List[Dict[str, Any]]:
    """What should out-rank a new discretionary investment, in order.

    Returned as structured rows rather than prose so the discovery layer can
    both reason over them and quote them verbatim. An empty list is a
    meaningful answer too: nothing stands in the way."""
    items: List[Dict[str, Any]] = []

    if dna.likely_high_interest_debt:
        items.append({
            "priority": "clear_high_interest_debt",
            "label": "Clear likely high-interest debt first",
            "severity": "high",
            "reason": (
                "Paying down card/EMI debt is a guaranteed, tax-free return at the loan's "
                "interest rate, almost always higher than the expected return on a new investment."
            ),
            "evidence": dna.high_interest_evidence,
        })

    if dna.emergency_buffer_months is not None and dna.emergency_buffer_months < 3:
        target = ctx.expenses * 3 if ctx.expenses else None
        items.append({
            "priority": "build_emergency_fund",
            "label": "Build the emergency fund to at least 3 months",
            "severity": "high" if dna.emergency_buffer_months < 1 else "medium",
            "reason": (
                f"Your reserve covers about {dna.emergency_buffer_months:.1f} months of expenses. "
                "Investing before that means a job gap or a medical bill forces a sale at whatever "
                "the market happens to be doing that week."
            ),
            "target_amount": round(target, 2) if target else None,
        })

    if dna.debt_band == "heavy":
        items.append({
            "priority": "reduce_debt_load",
            "label": "Bring the overall debt load down",
            "severity": "medium",
            "reason": (
                f"Outstanding debt of {dna.currency}{group_indian(dna.outstanding_debt)} is more than a "
                "year of income, which limits how much market risk is survivable."
            ),
        })

    if dna.dependents > 0 and dna.insurance_band in ("none", "thin"):
        items.append({
            "priority": "secure_insurance_cover",
            "label": "Get term cover in place for your dependents",
            "severity": "medium",
            "reason": (
                f"{dna.dependents} dependent(s) with "
                f"{dna.currency}{group_indian(dna.insurance_cover)} of cover on file. Protection is "
                "cheaper than the loss it covers, and it comes before growth."
            ),
        })

    if ctx.surplus <= 0 and ctx.income > 0:
        items.append({
            "priority": "restore_positive_cashflow",
            "label": "Get monthly cash flow positive",
            "severity": "high",
            "reason": (
                f"Income of {dna.currency}{group_indian(ctx.income)} against expenses of "
                f"{dna.currency}{group_indian(ctx.expenses)} leaves no monthly surplus to invest from."
            ),
        })

    return items


def build_risk_profile(profile: Any, ctx: FinancialContext, db: Any = None) -> RiskDNA:
    """Assemble the Risk DNA from everything already stored about the user.

    Never raises: a risk read is an input to a conversation, and a conversation
    should degrade to "we don't know that yet" rather than to a 500."""
    raw = profile.raw_inputs or {}
    dna = RiskDNA(currency=ctx.currency or "₹")

    # --- reserves ----------------------------------------------------------
    dna.emergency_buffer_months = round(ctx.buffer_months, 1) if ctx.buffer_months is not None else None
    dna.reserve_band, dna.reserve_note = _band(dna.emergency_buffer_months, RESERVE_BANDS)

    # --- cash flow ---------------------------------------------------------
    dna.monthly_surplus = round(ctx.surplus, 2)
    if ctx.income > 0:
        dna.savings_rate_pct = round((ctx.surplus / ctx.income) * 100, 1)

    # --- debt --------------------------------------------------------------
    dna.outstanding_debt = round(ctx.loans, 2)
    if ctx.income > 0:
        ratio = ctx.loans / (ctx.income * 12)
        dna.debt_to_annual_income_pct = round(ratio * 100, 1)
        dna.debt_band, _ = _band(ratio, DEBT_BANDS)
    elif ctx.loans == 0:
        dna.debt_band = "none"
    dna.likely_high_interest_debt, dna.high_interest_evidence = _detect_high_interest_debt(db, profile)

    # --- household ---------------------------------------------------------
    try:
        dna.dependents = int(raw.get("dependents") or 0)
    except (TypeError, ValueError):
        dna.dependents = 0
    try:
        dna.insurance_cover = float(raw.get("insurance_coverage") or 0.0)
    except (TypeError, ValueError):
        dna.insurance_cover = 0.0
    if ctx.income > 0:
        years = dna.insurance_cover / (ctx.income * 12)
        dna.insurance_cover_years_of_income = round(years, 1)
        # 10x annual income is the common rule of thumb for term cover; under
        # half a year of income is effectively no cover at all.
        dna.insurance_band = "none" if years < 0.5 else ("thin" if years < 5 else "adequate")
    elif dna.insurance_cover == 0:
        dna.insurance_band = "none"

    # --- existing exposure -------------------------------------------------
    try:
        dna.existing_investments = float(raw.get("existing_investments") or 0.0)
    except (TypeError, ValueError):
        dna.existing_investments = 0.0
    liquid_total = dna.existing_investments + (ctx.savings or 0.0)
    if liquid_total > 0:
        dna.investment_exposure_pct = round((dna.existing_investments / liquid_total) * 100, 1)

    # --- income stability --------------------------------------------------
    dna.income_stability, dna.income_stability_basis = _classify_income_stability(profile)

    # --- preferences the user has already told us --------------------------
    # Stored by the discovery layer when the user answers a preference question,
    # so the same question is never asked twice across conversations.
    prefs = raw.get("risk_preferences") or {}
    if isinstance(prefs, dict):
        dna.stated_tolerance = prefs.get("tolerance")
        dna.loss_comfort = prefs.get("loss_comfort")
        dna.stated_objective = prefs.get("objective")
        horizon = prefs.get("horizon_years")
        try:
            dna.stated_horizon_years = float(horizon) if horizon is not None else None
        except (TypeError, ValueError):
            dna.stated_horizon_years = None

    # --- composite ---------------------------------------------------------
    dna.capacity_score, dna.capacity_band, dna.capacity_drivers = _score_capacity(dna)
    dna.blocking_priorities = _blocking_priorities(dna, ctx)

    # --- hard constraints, stated plainly ----------------------------------
    if dna.reserve_band in ("none", "thin"):
        dna.constraints.append(
            f"Emergency reserve is {dna.reserve_band} ({dna.emergency_buffer_months:.1f} months) - "
            "money that might be needed within a year should not carry market risk."
        )
    if ctx.surplus <= 0 and ctx.income > 0:
        dna.constraints.append("No monthly surplus - any new commitment has to displace existing spending.")
    if dna.likely_high_interest_debt:
        dna.constraints.append("Likely high-interest debt is outstanding, which competes with any expected return.")
    if dna.income_stability == "variable":
        dna.constraints.append("Income is variable, so the reserve needs to be deeper than the usual 3-6 months.")

    # --- what we genuinely do not know -------------------------------------
    if dna.stated_tolerance is None:
        dna.unknowns.append("risk_tolerance")
    if dna.stated_horizon_years is None:
        dna.unknowns.append("investment_horizon")
    if dna.stated_objective is None:
        dna.unknowns.append("purpose_of_money")
    if dna.loss_comfort is None:
        dna.unknowns.append("capital_loss_comfort")
    if ctx.income == 0:
        dna.unknowns.append("monthly_income")
    if ctx.expenses == 0:
        dna.unknowns.append("monthly_expenses")

    return dna


def save_stated_preferences(db: Any, profile: Any, prefs: Dict[str, Any]) -> None:
    """Persist preferences the user revealed in conversation.

    Written into Profile.raw_inputs under a dedicated key rather than as new
    columns: raw_inputs is already the store for "what the user told us", every
    other consumer reads it defensively with .get(), and this keeps the twin's
    memory of a preference alive across sessions so the same question is never
    asked twice. Only non-null values overwrite — an unanswered question must
    not erase an earlier answer."""
    if not prefs or db is None:
        return
    clean = {k: v for k, v in prefs.items() if v is not None and v != ""}
    if not clean:
        return
    raw = dict(profile.raw_inputs or {})
    existing = dict(raw.get("risk_preferences") or {})
    existing.update(clean)
    raw["risk_preferences"] = existing
    # Reassign rather than mutate: SQLAlchemy's JSON column doesn't track
    # in-place mutation of the dict it handed back.
    profile.raw_inputs = raw
    try:
        db.commit()
    except Exception:
        db.rollback()
