"""
What the Financial Twin already knows — assembled in one place.

The single most common failure of a "smart" financial chatbot is asking a
question it already has the answer to. This module exists so that can't happen:
before any follow-up question is chosen, the discovery layer reads a snapshot
built here, and every field in that snapshot is either a real value (so it must
never be asked about) or an explicit gap (so it may be).

It is a *reader*, not a new source of truth. Every number comes from something
that already existed:

  - `build_financial_context()` (financial_simulator) — the same normalized
    income/expenses/savings/loans that Ask Twin and Simulation already ground on.
  - `build_risk_profile()` (risk_profile) — the deterministic Risk DNA.
  - FinancialGoal / UpcomingPayment / StartupTransaction rows — the Daily Home
    layer's goals, obligations and ledger.
  - Profile.raw_inputs — what the user typed at onboarding, plus any preference
    they have since revealed in conversation.

Nothing here computes a recommendation and nothing here calls an LLM.
"""
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional

from backend.services.financial_simulator import FinancialContext, build_financial_context
from backend.services.risk_profile import RiskDNA, build_risk_profile


# The slots the discovery layer is allowed to reason about. Naming them here
# (rather than letting the LLM invent slot names per turn) is what makes
# "already asked" and "already known" checkable in code.
SLOT_LABELS = {
    "amount": "How much money is involved",
    "contribution_mode": "Whether this is a monthly SIP or a one-off lump sum",
    "purpose": "What the money is meant to achieve",
    "time_horizon": "When the money is needed or should start working",
    "income_need_timing": "Whether income is needed now or after a growth period",
    "desired_return": "The return the user is hoping for",
    "risk_tolerance": "How much fluctuation the user is willing to accept",
    "capital_loss_comfort": "Whether any capital loss is acceptable",
    "liquidity_need": "Whether the money must stay accessible",
    "existing_portfolio": "What the user's existing investments are actually held in",
    "debt_details": "Type, interest rate, EMI and remaining tenure of existing debt",
    "existing_commitments": "Other commitments competing for the same money",
    "monthly_income": "Monthly income",
    "monthly_expenses": "Monthly expenses",
    "emergency_fund": "Emergency reserve position",
    "existing_debt": "Outstanding debt",
    "existing_investments": "What is already invested",
    "dependents": "People financially dependent on the user",
    "goal": "The goal this money is attached to",
    "loan_terms": "Loan amount, tenure and EMI",
    "target_retirement_age": "The age the user wants to retire at",
    "option_set": "The specific options being compared",
}


@dataclass
class TwinKnowledge:
    """One turn's worth of "everything we know", ready to prompt with."""

    currency: str = "₹"
    persona: str = "individual"
    display_name: Optional[str] = None

    fin: Optional[FinancialContext] = None
    risk: Optional[RiskDNA] = None

    # slot -> value. Only ever populated from stored data, never from a guess.
    known: Dict[str, Any] = field(default_factory=dict)
    # Slots with no stored answer. The discovery layer may ask about these.
    gaps: List[str] = field(default_factory=list)

    goals: List[Dict[str, Any]] = field(default_factory=list)
    upcoming: List[Dict[str, Any]] = field(default_factory=list)
    recent_spend: Dict[str, Any] = field(default_factory=dict)
    alerts: List[str] = field(default_factory=list)

    def known_summary(self) -> Dict[str, Any]:
        """The compact form that goes into the prompt. Keeping this small
        matters: a bloated context is what makes a model start inventing."""
        f = self.fin
        r = self.risk
        out: Dict[str, Any] = {
            "currency": self.currency,
            "monthly_income": f.income if f else None,
            "monthly_expenses": f.expenses if f else None,
            "monthly_surplus": round(f.surplus, 2) if f else None,
            "total_savings": f.savings if f else None,
            "outstanding_loans": f.loans if f else None,
            "emergency_buffer_months": r.emergency_buffer_months if r else None,
            "existing_investments": r.existing_investments if r else None,
            "dependents": r.dependents if r else None,
            "insurance_cover": r.insurance_cover if r else None,
            "income_stability": r.income_stability if r else None,
            "risk_capacity_band": r.capacity_band if r else None,
            "risk_capacity_score": r.capacity_score if r else None,
            "stated_risk_tolerance": r.stated_tolerance if r else None,
            "stated_horizon_years": r.stated_horizon_years if r else None,
            "stated_objective": r.stated_objective if r else None,
            "goals": self.goals[:4],
            "upcoming_obligations": self.upcoming[:5],
            "this_month_spend": self.recent_spend or None,
            "active_alerts": self.alerts[:3],
        }
        return {k: v for k, v in out.items() if v is not None and v != [] and v != {}}

    def reality_flags(self) -> List[Dict[str, Any]]:
        """The deterministic grounds for challenging a request. Passed through
        to the prompt verbatim so a challenge always cites a real number."""
        return list(self.risk.blocking_priorities) if self.risk else []


def _goal_rows(db: Any, profile: Any, currency: str, today: date) -> List[Dict[str, Any]]:
    """Goals from the Daily Home layer, falling back to the legacy
    Profile.goal blob that predates it (still the only goal an older profile
    has, and still what Simulation's goal_timeline calculator reads)."""
    rows: List[Dict[str, Any]] = []
    if db is not None:
        try:
            from backend.models.domain import FinancialGoal
            goals = (db.query(FinancialGoal)
                     .filter(FinancialGoal.profile_id == profile.id,
                             FinancialGoal.status == "active")
                     .all())
            for g in goals:
                target = g.target_amount or 0
                rows.append({
                    "name": g.name,
                    "target_amount": target,
                    "saved_amount": g.current_amount or 0,
                    "progress_pct": round(((g.current_amount or 0) / target) * 100, 1) if target else None,
                    "target_date": g.target_date.isoformat() if g.target_date else None,
                    "months_left": (
                        max(0, (g.target_date.year - today.year) * 12 + (g.target_date.month - today.month))
                        if g.target_date else None
                    ),
                    "is_primary": bool(g.is_primary),
                })
        except Exception:
            rows = []

    if not rows:
        legacy = profile.goal or {}
        if legacy.get("title"):
            rows.append({
                "name": legacy.get("title"),
                "target_amount": legacy.get("target"),
                "progress_pct": legacy.get("progress"),
                "target_date": legacy.get("target_date"),
                "is_primary": True,
            })
    return rows


def _upcoming_rows(db: Any, profile: Any) -> List[Dict[str, Any]]:
    """Confirmed future outflows only. Rows awaiting review are excluded on
    purpose — an unconfirmed detection is a suggestion, not a financial fact,
    and must not silently shape a recommendation."""
    if db is None:
        return []
    try:
        from backend.models.domain import UpcomingPayment
        rows = (db.query(UpcomingPayment)
                .filter(UpcomingPayment.profile_id == profile.id,
                        UpcomingPayment.is_active.is_(True),
                        (UpcomingPayment.status.is_(None)) | (UpcomingPayment.status == "confirmed"))
                .order_by(UpcomingPayment.due_date)
                .limit(12)
                .all())
        return [{
            "name": r.name,
            "amount": r.amount,
            "due_date": r.due_date.isoformat() if r.due_date else None,
            "recurrence": r.recurrence,
            "type": r.event_type or r.category,
            "direction": r.direction or "out",
        } for r in rows]
    except Exception:
        return []


def _recent_spend(db: Any, profile: Any, today: date) -> Dict[str, Any]:
    """This calendar month's outflow from the Hisaab ledger, by category.

    Read directly rather than via home_service.build_monthly_spending() because
    all that is needed here is a total and the top categories — pulling in the
    full Daily Home builder would compute half a dashboard for one prompt."""
    if db is None:
        return {}
    try:
        from backend.models.domain import StartupTransaction
        start = today.replace(day=1)
        txns = (db.query(StartupTransaction)
                .filter(StartupTransaction.profile_id == profile.id,
                        StartupTransaction.type == "out",
                        StartupTransaction.txn_date >= start)
                .all())
        if not txns:
            return {}
        by_cat: Dict[str, float] = {}
        for t in txns:
            by_cat[t.category or "Other"] = by_cat.get(t.category or "Other", 0.0) + (t.amount or 0.0)
        top = sorted(by_cat.items(), key=lambda kv: kv[1], reverse=True)[:3]
        return {
            "month_to_date_total": round(sum(by_cat.values()), 2),
            "top_categories": [{"category": c, "amount": round(a, 2)} for c, a in top],
            "transaction_count": len(txns),
        }
    except Exception:
        return {}


def build_twin_knowledge(profile: Any, db: Any = None, today: Optional[date] = None) -> TwinKnowledge:
    """Gather everything the twin already knows about this user.

    Deliberately tolerant: any sub-read that fails degrades to "we don't know
    that", which is exactly the state the discovery layer is built to handle."""
    today = today or date.today()
    fin = build_financial_context(profile)
    risk = build_risk_profile(profile, fin, db=db)

    tk = TwinKnowledge(
        currency=fin.currency or "₹",
        persona=getattr(profile, "key", "individual") or "individual",
        display_name=(profile.raw_inputs or {}).get("full_name") or profile.persona or None,
        fin=fin,
        risk=risk,
    )

    tk.goals = _goal_rows(db, profile, tk.currency, today)
    tk.upcoming = _upcoming_rows(db, profile)
    tk.recent_spend = _recent_spend(db, profile, today)
    try:
        tk.alerts = [a.text for a in (profile.alerts or []) if getattr(a, "text", None)][:3]
    except Exception:
        tk.alerts = []

    # --- Which slots are already answered ----------------------------------
    # A slot lands in `known` only when there is a real stored value behind it.
    # Everything else lands in `gaps`, and only gaps are ever askable.
    if fin.income:
        tk.known["monthly_income"] = fin.income
    if fin.expenses:
        tk.known["monthly_expenses"] = fin.expenses
    if fin.buffer_months is not None:
        tk.known["emergency_fund"] = f"{fin.buffer_months:.1f} months of expenses covered"
    if fin.loans:
        tk.known["existing_debt"] = fin.loans
    elif fin.income:
        # Zero loans against a known income is itself an answer, not a gap.
        tk.known["existing_debt"] = 0
    if risk.existing_investments:
        tk.known["existing_investments"] = risk.existing_investments
    if risk.dependents:
        tk.known["dependents"] = risk.dependents
    if tk.goals:
        tk.known["goal"] = tk.goals[0].get("name")
    if tk.upcoming:
        tk.known["existing_commitments"] = [u["name"] for u in tk.upcoming[:5]]
    # Only the preferences that are facts about the *person* count as answered.
    # A remembered purpose and horizon (risk.stated_objective /
    # stated_horizon_years) are deliberately left out: they seed a default in
    # the Simulation hand-off, but what the last pot of money was for says
    # nothing about what this one is for, and treating it as settled would stop
    # the twin asking the single most important question it has.
    if risk.stated_tolerance:
        tk.known["risk_tolerance"] = risk.stated_tolerance
    if risk.loss_comfort:
        tk.known["capital_loss_comfort"] = risk.loss_comfort

    tk.gaps = [
        slot for slot in SLOT_LABELS
        if slot not in tk.known and _is_askable(slot, tk)
    ]
    return tk


def _is_askable(slot: str, tk: "TwinKnowledge") -> bool:
    """Whether a gap is worth putting to this particular user.

    Some questions are only meaningful given what the profile already says. A
    user with no debt should never be asked about their interest rate, and a
    user with nothing invested should never be asked what their portfolio holds
    — asking either would prove the twin wasn't reading its own data, which is
    exactly the failure this whole layer exists to prevent."""
    fin, risk = tk.fin, tk.risk

    if slot == "debt_details":
        # Only where debt actually exists. The amount is on file; what is
        # missing is the rate, EMI and tenure that decide whether clearing it
        # beats investing.
        return bool(fin and fin.loans and fin.loans > 0)

    if slot == "existing_portfolio":
        # The total is on file from onboarding; how it is held is not, and that
        # is what says whether new money adds diversification or doubles down.
        return bool(risk and risk.existing_investments and risk.existing_investments > 0)

    if slot == "existing_commitments":
        # Already answered when the Daily Home layer knows the obligations.
        return not tk.upcoming

    return True
