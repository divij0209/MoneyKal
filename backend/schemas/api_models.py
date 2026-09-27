from pydantic import BaseModel
from typing import List, Optional, Any, Dict

from backend.schemas.discovery_models import DecisionContext, FollowUpQuestion, SimulationCTA

class Metric(BaseModel):
    id: str
    label: str
    value: float
    unit: str
    trend: List[float]
    isPercent: Optional[bool] = False

class Goal(BaseModel):
    title: str
    progress: float
    target: float

class Alert(BaseModel):
    level: str
    text: str

class DecisionHistory(BaseModel):
    title: str
    date: str
    outcome: str
    tag: str

class DecisionType(BaseModel):
    id: str
    label: str
    primaryLabel: str
    primaryUnit: str
    primaryStart: float
    impactRate: float
    goodDirection: str
    secondaryLabel: str
    secondaryUnit: str
    secondaryStart: float
    secondaryImpactRate: float
    inactionNote: str

class ProfileResponse(BaseModel):
    key: str
    label: str
    persona: str
    currency: str
    metrics: List[Metric]
    goal: Goal
    alerts: List[Alert]
    history: List[DecisionHistory]
    decisionTypes: List[DecisionType]

class ChatRequest(BaseModel):
    message: str
    session_id: Optional[str] = None

class ChatMessageModel(BaseModel):
    role: str
    content: str
    
class ChatSessionResponse(BaseModel):
    id: str
    title: str
    created_at: str

class ChatSessionDetail(ChatSessionResponse):
    messages: List[ChatMessageModel]

class ChatRenameRequest(BaseModel):
    title: str

class GenericResponse(BaseModel):
    success: bool
    message: Optional[str] = None

class ChatResponse(BaseModel):
    session_id: str
    answer: str
    confidence: str
    sources: List[Dict[str, str]]
    reasoning_trace: List[Dict[str, str]]
    disclaimer: str
    # Optional structured chart data for numeric/trend questions (Startup's Ask
    # Twin only, for now — always built from already-computed Financial Twin
    # metrics, never invented by the LLM). Individual leaves this unset.
    visualization: Optional[Dict[str, Any]] = None

    # --- Financial Discovery layer (backend/agents/discovery.py) -----------
    # All optional and all additive: a client that ignores them renders exactly
    # the conversation it rendered before this layer existed.
    #
    # `mode` is what the twin decided this turn should be — "answer" (the
    # existing behaviour), "ask" (a single follow-up question, because a
    # critical unknown would change the recommendation) or "challenge" (the
    # request conflicts with the user's own figures).
    mode: str = "answer"
    user_intent: Optional[str] = None
    decision_type: Optional[str] = None
    # Present only when mode == "ask". Carries the slot being filled and
    # optional tappable answers; free text always stays available.
    follow_up: Optional[FollowUpQuestion] = None
    # Present ONLY when a concrete, simulatable decision has been discovered.
    # Its absence is meaningful: no CTA should be rendered. The client does no
    # eligibility reasoning of its own.
    simulation_cta: Optional[SimulationCTA] = None
    # What the twin knew vs. what it still needs — surfaced for transparency
    # (and to prove to the user it isn't asking for what it already has).
    discovery: Optional[Dict[str, Any]] = None

class SimulateRequest(BaseModel):
    decision_id: str
    commitment_pct: int

class Outcome(BaseModel):
    label: str
    pct: int
    score: float
    primary_outcome: float
    secondary_outcome: float
    is_best: bool

class SimulateResponse(BaseModel):
    outcomes: List[Outcome]
    explanation: str

class ScenarioSimulateRequest(BaseModel):
    scenario: str
    # Handed over by the chatbot's Simulation CTA. When present, Simulation
    # uses these already-discovered facts instead of re-parsing the sentence,
    # so the user never re-enters what the conversation already established.
    decision_context: Optional[DecisionContext] = None
    # Lets Simulation pull the stored context for a conversation when the
    # client would rather send an id than the whole object.
    session_id: Optional[str] = None

class StageTrace(BaseModel):
    agent: str
    status: str
    summary: str

class ScenarioSimulateResponse(BaseModel):
    scenario: str
    scenario_type: str
    mode: str = "scenario"  # "scenario" (Understand->Check pipeline) or "informational" (direct Ask Twin answer)
    parsed_params: Dict[str, Any]
    stages: List[StageTrace]
    financial_impact: Dict[str, Any]
    timeline: List[Dict[str, Any]]
    recommendation: str
    why: str
    risks: List[str]
    assumptions: List[str]
    teaching: str
    disclaimer: str
    # Optional — Startup only. Full-resolution baseline-vs-scenario cash series
    # for the Scenario Projection chart, and deterministic alternative-option
    # comparisons (e.g. "Don't hire" / "Hire 3" / "Hire 5"). Individual leaves
    # these unset; both are built entirely from startup_engine/startup_scenario,
    # never from the LLM.
    timeline_series: Optional[Dict[str, Any]] = None
    comparison_variants: Optional[List[Dict[str, Any]]] = None
    # --- Chat -> Simulation hand-off ---------------------------------------
    # Echoed back so the UI can show what the conversation established, and so
    # a re-run doesn't lose the discovered context.
    decision_context: Optional[DecisionContext] = None
    # Realistic alternatives to the path the chatbot suggested — Simulation's
    # job is to explore, not to confirm one recommendation. Deterministically
    # computed (see financial_simulator.build_alternative_paths), never invented.
    alternative_paths: Optional[List[Dict[str, Any]]] = None
    # Id of the stored SimulationRun this response was persisted as. Lets the
    # client drop the finished run straight into its history list, and know
    # which stored run the result on screen corresponds to.
    run_id: Optional[str] = None


# --------------------------------------------------------- Simulation history
# Every run of /twin/simulate-scenario is stored against the profile, so the
# Simulate tab opens with the user's past runs already there instead of an
# empty session list — and any of them can be reopened in full.

class SimulationRunSummary(BaseModel):
    """One row in the history list. Deliberately small: the list is loaded on
    every visit to the tab, and the full payload is only fetched when a run is
    actually opened."""
    id: str
    scenario: str
    scenario_type: str
    mode: str
    headline: str
    created_at: str  # ISO-8601, UTC


class SimulationRunDetail(SimulationRunSummary):
    """A stored run, reopened. `result` is the exact ScenarioSimulateResponse
    the pipeline produced at the time, so reopening renders through the same
    component as a live run and shows the same numbers — not a re-simulation
    against today's data, which would quietly change what the user decided on."""
    result: ScenarioSimulateResponse

