"""
Structured output for the Intelligent Financial Discovery layer.

These models are the contract between three things that must not drift apart:
the JSON the router LLM is asked to emit, the state persisted per chat session,
and the payload the frontend renders. Validating through Pydantic (rather than
trusting the model's JSON) is what keeps a malformed or over-confident
generation from turning into a bad question or a bogus Simulation hand-off —
anything that fails validation falls back to a deterministic path.
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


# The three things the chatbot is allowed to do with a turn. Named rather than
# free-form so the router can't invent a fourth behaviour.
CHAT_MODES = ("answer", "ask", "challenge")

# Decision types the twin recognizes. Simulation eligibility is keyed off this,
# so adding one here without a calculator behind it would offer a CTA that
# can't be honoured — see SIMULATABLE_DECISIONS below.
DECISION_TYPES = (
    "investment", "loan", "purchase", "savings", "goal_planning",
    "retirement", "debt_payoff", "insurance", "income_change",
    "comparison", "informational", "none",
)

# Which decision types actually have future consequences we can model. This is
# the deterministic gate behind "Can it be meaningfully simulated?" in the flow
# — the LLM proposes, this decides.
SIMULATABLE_DECISIONS = {
    "investment", "loan", "purchase", "savings",
    "goal_planning", "retirement", "debt_payoff", "income_change", "comparison",
}

# Contextual CTA copy per decision type. A generic "Simulate this" everywhere
# is exactly what the product brief rules out.
CTA_COPY = {
    "investment": ("Explore Investment Outcomes", "See how this money could grow, and what it costs you if it doesn't."),
    "loan": ("Stress-Test This Loan", "Project the EMI against your cash flow, buffer and goals."),
    "purchase": ("Check Future Affordability", "See what this purchase does to your savings and goals over time."),
    "savings": ("Project This Savings Plan", "See where this rate takes you, and how much sooner your goal lands."),
    "goal_planning": ("Test This Goal Plan", "Check whether the timeline holds at your current savings rate."),
    "retirement": ("Test My Retirement Plan", "Project the corpus against the age you want to stop working."),
    "debt_payoff": ("Compare Payoff Strategies", "See what clearing this first does to your long-term position."),
    "income_change": ("Stress-Test This Scenario", "See how long your position holds if income changes."),
    "comparison": ("Compare Future Outcomes", "Model both options side by side against your twin."),
}

# The simulation the CTA should run, per decision type. Maps onto the scenario
# types financial_simulator already calculates.
SIMULATION_TYPE_MAP = {
    "investment": "invest_lumpsum",
    "loan": "emi_affordability",
    "purchase": "emi_affordability",
    "savings": "increase_savings",
    "goal_planning": "goal_timeline",
    "retirement": "invest_monthly",
    "debt_payoff": "increase_savings",
    "income_change": "income_loss",
    "comparison": "generic",
}


class RiskConstraints(BaseModel):
    """The preference half of the risk picture — what the user has actually
    told us, kept separate from the computed capacity so a stated wish is never
    mistaken for a measured fact."""
    growth_preference: Optional[str] = None       # low | moderate | high
    capital_loss_preference: Optional[str] = None  # none | low | moderate | high
    liquidity_need: Optional[str] = None           # immediate | within_year | flexible
    horizon_years: Optional[float] = None
    conflicts: List[str] = Field(default_factory=list)


class DecisionContext(BaseModel):
    """The structured hand-off from chat to Simulation.

    Everything discovered in conversation lands here so the user never re-enters
    what they already said. Sent to POST /twin/simulate-scenario, which uses it
    instead of regex-parsing the sentence."""
    decision_type: str = "none"
    simulation_type: Optional[str] = None
    amount: Optional[float] = None
    recurring: bool = False
    objective: Optional[str] = None
    time_horizon_years: Optional[float] = None
    risk_profile: Dict[str, Any] = Field(default_factory=dict)
    risk_constraints: RiskConstraints = Field(default_factory=RiskConstraints)
    financial_health_context: Dict[str, Any] = Field(default_factory=dict)
    existing_investments: Optional[float] = None
    user_constraints: List[str] = Field(default_factory=list)
    blocking_priorities: List[Dict[str, Any]] = Field(default_factory=list)
    conversation_context: str = ""
    discovered_slots: Dict[str, Any] = Field(default_factory=dict)
    source: str = "chat_discovery"
    session_id: Optional[str] = None


class SimulationCTA(BaseModel):
    """Rendered only when the gate in discovery.py says every condition holds.
    The frontend does no eligibility thinking of its own — if this is absent,
    there is no button."""
    label: str
    sublabel: Optional[str] = None
    simulation_type: str
    scenario: str                      # the sentence Simulation receives
    decision_context: DecisionContext


class FollowUpQuestion(BaseModel):
    """One question, and the reason it earns a turn."""
    question: str
    slot: str
    why_it_matters: Optional[str] = None
    # Optional tappable answers. Free text always stays available — the user
    # must be able to say something the twin didn't anticipate.
    suggestions: List[str] = Field(default_factory=list)


class DiscoveryAnalysis(BaseModel):
    """The router's structured read of the turn — the fields the brief names.

    Held separately from the response so it can be persisted as session state
    and audited, not just rendered."""
    user_intent: str = ""
    decision_type: str = "none"
    known_information: Dict[str, Any] = Field(default_factory=dict)
    critical_unknowns: List[str] = Field(default_factory=list)
    next_best_question: Optional[FollowUpQuestion] = None
    answer_readiness: float = 0.0            # 0-1
    decision_detected: bool = False
    simulation_eligible: bool = False
    simulation_type: Optional[str] = None
    mode: str = "answer"
    reality_conflicts: List[str] = Field(default_factory=list)
    extracted_slots: Dict[str, Any] = Field(default_factory=dict)
    stated_preferences: Dict[str, Any] = Field(default_factory=dict)
    reasoning: str = ""


class ConversationDiscoveryState(BaseModel):
    """What the session remembers between turns.

    This is the "structured state" the brief asks for alongside the LLM: the
    model decides what to ask, but what has *already* been asked and answered is
    tracked in code, which is what makes "never ask twice" a guarantee rather
    than an instruction the model may ignore."""
    decision_type: str = "none"
    user_intent: str = ""
    slots: Dict[str, Any] = Field(default_factory=dict)
    asked_slots: List[str] = Field(default_factory=list)
    asked_questions: List[str] = Field(default_factory=list)
    declined_slots: List[str] = Field(default_factory=list)
    question_count: int = 0
    challenge_issued: bool = False
    # The user heard a concern and chose to proceed anyway. Once set, the twin
    # stops arguing: it states the risk once and gives the safest version of
    # what was actually asked for. Overriding a decision the user has explicitly
    # made is not the twin's call.
    user_insisted: bool = False
    last_mode: str = "answer"
    # A fingerprint of the profile the last recommendation was built from.
    # Re-emitting an identical allocation every turn is what makes a chatbot
    # feel like a form rather than a conversation, so a recommendation is only
    # regenerated when something that would change it has actually changed.
    recommended_signature: Optional[str] = None
    # The slot the twin asked about on the previous turn and is still waiting on.
    # Whatever the user says next is, by construction, the answer to it — so this
    # is what lets a reply be captured even when the router fails to extract it.
    pending_slot: Optional[str] = None
    decision_context: Optional[DecisionContext] = None

    def register_question(self, q: FollowUpQuestion) -> None:
        self.question_count += 1
        if q.slot and q.slot not in self.asked_slots:
            self.asked_slots.append(q.slot)
        if q.question:
            self.asked_questions.append(q.question)
        self.pending_slot = q.slot or None

    def absorb(self, slots: Dict[str, Any]) -> None:
        """Fold newly extracted answers into the state. Null values are dropped
        so a turn the model couldn't parse never erases a real earlier answer."""
        for k, v in (slots or {}).items():
            if v is None or v == "":
                continue
            self.slots[k] = v
