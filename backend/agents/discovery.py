"""
The Intelligent Financial Discovery layer.

This is the routing brain that sits in front of the existing Ask Twin
orchestrator. It does not replace it — every final answer is still produced by
the Groq agent pipeline in agents/orchestrator.py, grounded exactly as before.
What this adds is the step that was missing: deciding whether an answer is even
the right response to this turn.

    User query
        -> intent analysis            (what decision is behind the question?)
        -> load Financial Twin        (twin_knowledge.build_twin_knowledge)
        -> known vs missing analysis  (slots, deterministic)
        -> critical info missing?     -> yes: ask the single best question
        -> reality / risk check       -> conflict: challenge respectfully
        -> personalized recommendation (existing orchestrator, given a brief)
        -> concrete decision present + simulatable? -> contextual Simulation CTA
        -> structured decision context handed to Simulation

The LLM is used for judgement (what matters here, what to ask, how to phrase
it). The *state* — what has been asked, what is known, how many questions have
been spent, whether a challenge was already issued — is tracked in code, because
"never ask the same thing twice" has to be a guarantee, not a request in a
prompt. Every LLM output is validated against that state before it is acted on,
and there is a deterministic fallback for every path so the chatbot behaves
sensibly with no API key at all.
"""
import json
import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from backend.agents.discovery_prompts import (
    ROUTER_SYSTEM_PROMPT,
    QUESTION_SYSTEM_PROMPT,
    CHALLENGE_SYSTEM_PROMPT,
    DISCOVERY_BRIEF_TEMPLATE,
)
from backend.schemas.discovery_models import (
    CTA_COPY,
    DECISION_TYPES,
    SIMULATABLE_DECISIONS,
    SIMULATION_TYPE_MAP,
    ConversationDiscoveryState,
    DecisionContext,
    DiscoveryAnalysis,
    FollowUpQuestion,
    RiskConstraints,
    SimulationCTA,
)
from backend.services.financial_simulator import (
    classify_scenario, extract_tokens, is_informational_question, is_recurring,
)
from backend.services.groq_service import groq_service
from backend.services.investment_advisor import BLOCKING_SLOTS, missing_blocking_slots
from backend.services.twin_knowledge import SLOT_LABELS, TwinKnowledge

logger = logging.getLogger(__name__)


# A conversation gets at most this many follow-up questions per decision.
# Past it, the twin answers with stated assumptions instead. Financial
# discovery that turns into an interrogation is worse than a slightly
# hedged answer.
MAX_FOLLOW_UPS = 3

# Investment is the exception, and deliberately so. Building an investment
# profile genuinely needs more than three answers — amount, lump sum vs SIP,
# goal, horizon, return expectation, risk tolerance, liquidity — and each one
# changes the allocation that comes out the other end. The budget is still a
# budget: questioning also stops the moment the blocking set is complete (see
# investment_advisor.missing_blocking_slots), which in practice ends most
# conversations well before this ceiling.
MAX_FOLLOW_UPS_BY_DECISION = {"investment": 6, "retirement": 5}

# Decisions that go through full profiling before a recommendation is given at
# all — the readiness gate in `_enforce` withholds an answer while a blocking
# slot is still missing. Both end in a deterministic allocation, and an
# allocation built on a guessed horizon is not advice.
PROFILED_DECISIONS = {"investment", "retirement"}


def follow_up_budget(decision_type: str) -> int:
    return MAX_FOLLOW_UPS_BY_DECISION.get(decision_type, MAX_FOLLOW_UPS)

# Decision types where a reality conflict should out-rank the literal request.
# Asking "which stock" with no emergency fund is the canonical case; asking
# "how do I pay off this loan" is not — that IS the corrective action.
CHALLENGEABLE_DECISIONS = {"investment", "purchase", "loan", "comparison"}

# Ordered by how much each answer typically moves a recommendation. Used by the
# deterministic fallback router, and as a tie-breaker when the LLM proposes a
# slot that is already known or already asked.
SLOT_PRIORITY = {
    # The investment profiling order. Front-loaded with what changes the answer
    # most: what the money is for, then how it goes in, then how long it has,
    # then how much fluctuation is bearable. Return expectation sits after those
    # because it is only meaningful once there is a horizon to judge it against.
    "investment": ["purpose", "amount", "contribution_mode", "time_horizon",
                   "risk_tolerance", "desired_return", "liquidity_need",
                   "capital_loss_comfort", "income_need_timing",
                   "existing_portfolio", "debt_details"],
    "loan": ["loan_terms", "amount", "time_horizon", "existing_commitments"],
    "purchase": ["amount", "time_horizon", "liquidity_need"],
    "savings": ["purpose", "amount", "time_horizon"],
    "goal_planning": ["goal", "amount", "time_horizon"],
    "retirement": ["target_retirement_age", "amount", "contribution_mode",
                   "risk_tolerance", "desired_return", "existing_portfolio"],
    "debt_payoff": ["debt_details", "amount", "liquidity_need"],
    "insurance": ["dependents", "amount"],
    "income_change": ["time_horizon", "existing_commitments"],
    "comparison": ["option_set", "purpose", "time_horizon"],
}

# Words that genuinely introduce a *new* decision, used to tell "the user
# changed the subject" apart from "the user answered my question".
#
# The router occasionally reads a continuation as a fresh topic — "in about 2
# years, and I can't afford to lose the capital" scans as a loan question
# because of the word "afford" — and then asks about EMIs in the middle of an
# investment conversation. Deliberately excludes "afford" for exactly that
# reason: it is the overlapping word, and it appears far more often as part of
# "can't afford to lose" than as part of an affordability question.
DECISION_CHANGE_MARKERS = {
    "loan": ("loan", "emi", "mortgage", "borrow", "lend"),
    "purchase": ("buy", "buying", "purchase", "car", "house", "flat", "phone", "laptop"),
    "retirement": ("retire", "retirement"),
    "insurance": ("insurance", "term cover", "policy", "premium"),
    "debt_payoff": ("pay off", "payoff", "clear my debt", "repay"),
    "income_change": ("lose my job", "lost my job", "no income", "quit", "laid off"),
    "goal_planning": ("goal", "target", "save for"),
    "savings": ("save more", "savings rate", "cut spending"),
    "investment": ("invest", "sip", "mutual fund", "stock", "equity", "fund"),
    "comparison": ("versus", " vs ", "option a", "option b", "compare"),
}

# Fallback question copy, used when Groq is unavailable. Deliberately the same
# questions the router would reach for, so the degraded path is a quieter
# version of the real one rather than a different product.
FALLBACK_QUESTIONS = {
    "purpose": ("What would you like this money to achieve for you?",
                ["Grow long-term wealth", "Generate income", "Save for a specific goal", "Keep it safe"]),
    "time_horizon": ("When do you expect to need this money back?",
                     ["Within a year", "1-3 years", "3-7 years", "7+ years"]),
    "income_need_timing": ("Do you want income starting right away, or should this grow first and produce income later?",
                           ["Income right away", "Grow first, income later"]),
    "capital_loss_comfort": ("If this dipped 15% for a few months, would you be able to leave it alone?",
                             ["Yes, I'd hold", "I'd be uneasy", "No, I can't lose any of it"]),
    "risk_tolerance": ("How much ups and downs are you comfortable with on this money?",
                       ["Very little", "Some, for better returns", "A lot, I'm in it long-term"]),
    "liquidity_need": ("Does this money need to stay accessible, or can it be locked away?",
                       ["Must stay accessible", "Can be locked for a while"]),
    "contribution_mode": ("Would this be a one-off lump sum, or a fixed amount every month?",
                          ["A one-off lump sum", "Monthly SIP", "A bit of both"]),
    "desired_return": ("What kind of annual return are you hoping for on this?",
                       ["Beat inflation (~7%)", "Around 10-12%", "15%+", "I'm not sure"]),
    "existing_portfolio": ("What are your existing investments held in at the moment?",
                           ["Mostly equity / mutual funds", "Mostly FDs and debt", "A mix", "Not sure"]),
    "debt_details": ("For the debt you're carrying, what's the interest rate, EMI and how long is left?", []),
    "loan_terms": ("What's the loan amount, tenure and expected EMI?", []),
    "amount": ("How much are you planning to put in?", []),
    "target_retirement_age": ("What age would you like to stop working at?", ["45", "50", "55", "60"]),
    "option_set": ("Which two options are you weighing against each other?", []),
    "goal": ("Which goal is this money for?", []),
    "existing_commitments": ("Are there other commitments this money is already promised to?", ["No", "Yes"]),
    "existing_debt": ("What's outstanding on that debt, and roughly what rate?", []),
    "dependents": ("How many people depend on your income?", ["0", "1", "2", "3+"]),
}


def _safe_float(v: Any) -> Optional[float]:
    try:
        if v is None or v == "":
            return None
        return float(str(v).replace(",", "").replace("₹", "").strip())
    except (TypeError, ValueError):
        return None


# The calculators financial_simulator actually implements. The router is told
# to pick from this list, but "generic" is its easy way out, so anything not
# specifically named here falls back to the deterministic map instead.
KNOWN_SIMULATION_TYPES = {
    "invest_lumpsum", "invest_monthly", "emi_affordability",
    "increase_savings", "goal_timeline", "income_loss",
}


def _marker_hit(text: str, markers: Tuple[str, ...]) -> bool:
    """Whether any marker appears as a whole word (or whole phrase).

    Word boundaries are not optional here. A plain substring test reads "quit"
    inside "equity" and turns "I want to put the full amount in equity" into a
    job-loss scenario — the decision type flips, the slots reset, and the user's
    investment profile is thrown away mid-conversation."""
    return any(re.search(rf"(?<!\w){re.escape(m)}(?!\w)", text) for m in markers)


def _decision_from_markers(message: str) -> Optional[str]:
    """The decision type the user named outright, if any.

    First match wins, in the order the markers are declared — which puts the
    unambiguous financial products ahead of the looser purchase words, so
    "home loan" reads as a loan rather than as buying a house."""
    text = message.lower()
    for decision_type, markers in DECISION_CHANGE_MARKERS.items():
        if _marker_hit(text, markers):
            return decision_type
    return None


# Phrases that name a one-off deployment. The recurring side reuses
# financial_simulator.is_recurring, so a SIP is recognised identically whether
# it was typed into Simulate or said in conversation.
_LUMPSUM_MARKERS = ("lump sum", "lumpsum", "lump-sum", "one-off", "one off", "one time",
                    "onetime", "all at once", "in one go", "single payment")


def _contribution_mode(message: str) -> Optional[str]:
    """Whether the user has said this is a SIP or a lump sum."""
    text = message.lower()
    if any(m in text for m in _LUMPSUM_MARKERS):
        return "lump sum"
    if is_recurring(text):
        return "monthly SIP"
    return None


def _looks_recurring(value: Any) -> bool:
    """Whether a discovered slot describes money committed repeatedly.

    Reuses the same reading financial_simulator.is_recurring applies to a typed
    scenario, so "₹10,000 a month" means the same thing whether it was typed
    into Simulate or worked out in conversation."""
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    return is_recurring(str(value))


# The user asking, in so many words, to stop being questioned and be given the
# answer. Discovery exists to serve the recommendation, not to gate it, so this
# ends the questioning immediately — whatever is still unknown becomes a stated
# assumption in the answer instead of another turn.
_CONCLUDE_MARKERS = re.compile(
    r"\b(what should i (actually )?do|just tell me|tell me what|give me (the|your) "
    r"(answer|recommendation|advice)|your recommendation|what do you recommend|"
    r"stop asking|no more questions|enough questions|just answer|so what now|"
    r"what'?s the verdict|make a recommendation)\b",
    re.IGNORECASE,
)


def asks_to_conclude(message: str) -> bool:
    """Whether the user has asked to be given the recommendation now."""
    return bool(_CONCLUDE_MARKERS.search(message.strip()))


# An explicit request for the long form. Everything else gets a conversational
# reply — the ten-section report is a real capability, but it is the wrong
# answer to a one-line question, so it became opt-in rather than automatic.
_DETAIL_MARKERS = re.compile(
    r"\b(detailed?|in detail|full (report|breakdown|analysis)|break ?it ?down|breakdown|"
    r"deep dive|elaborate|step by step|show (me )?(the )?(numbers|maths?|calculations?|working)|"
    r"projection|project (it|this)|long[- ]term outlook|scenario|simulate|compare|comparison|"
    r"side by side|year by year|complete analysis|thorough)\b",
    re.IGNORECASE,
)


def wants_detailed_report(message: str) -> bool:
    """Whether the user actually asked for the long, structured form."""
    return bool(_DETAIL_MARKERS.search(message.strip()))


# The user has heard a concern and is choosing to proceed anyway. That is their
# call to make, and continuing to argue after it would be the system overriding
# a decision that was never its to make.
_INSIST_MARKERS = re.compile(
    r"\b(i still want|still want to|i want to (do it|invest|proceed) anyway|go ahead anyway|"
    r"do it anyway|anyway|regardless|even so|i understand the risk|i know the risk|"
    r"i'?ll take the risk|i am fine with|i'?m fine with|i accept the risk|ignore that|"
    r"proceed anyway|just proceed|i'?ve decided|my decision|understood,? but)\b",
    re.IGNORECASE,
)


def user_insists(message: str) -> bool:
    """Whether the user is explicitly overriding a concern already raised."""
    return bool(_INSIST_MARKERS.search(message.strip()))


_NUMBER_IN_TEXT = re.compile(r"(\d+(?:\.\d+)?)")


def parse_horizon_years(value: Any) -> Optional[float]:
    """Read a time horizon in years out of whatever the model extracted.

    The router fills slots from natural speech, so this arrives as "2 years",
    "18 months", "about 2", or a bare 2.0 — all meaning something specific. A
    plain float() on "2 years" returns None, which would silently drop a horizon
    the user actually gave and send Simulation a defaulted one instead."""
    direct = _safe_float(value)
    if direct is not None:
        return direct
    text = str(value or "").lower()
    match = _NUMBER_IN_TEXT.search(text)
    if not match:
        return None
    n = float(match.group(1))
    if "month" in text:
        return round(n / 12, 2)
    if "week" in text:
        return round(n / 52, 2)
    if "day" in text:
        return round(n / 365, 2)
    return n


def _transcript(chat_history: List[Dict[str, str]], limit: int = 10) -> str:
    rows = []
    for m in (chat_history or [])[-limit:]:
        who = "User" if m.get("role") == "user" else "Twin"
        text = (m.get("content") or "").strip()
        if text:
            rows.append(f"{who}: {text[:600]}")
    return "\n".join(rows) or "(this is the first message)"


class DiscoveryEngine:
    """Decides what a turn should be, then hands the work to the right place."""

    # ------------------------------------------------------------------ 1. analyse

    def analyze(
        self,
        message: str,
        knowledge: TwinKnowledge,
        state: ConversationDiscoveryState,
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> DiscoveryAnalysis:
        """One structured pass: intent, gaps, mode, simulation eligibility.

        The LLM's answer is treated as a proposal. `_enforce` is what actually
        decides, using the session state the model cannot be trusted to
        remember."""
        raw = self._call_router(message, knowledge, state, chat_history)
        analysis = self._parse(raw) if raw else self._fallback_analysis(message, knowledge, state)
        return self._enforce(analysis, message, knowledge, state)

    def _call_router(
        self,
        message: str,
        knowledge: TwinKnowledge,
        state: ConversationDiscoveryState,
        chat_history: Optional[List[Dict[str, str]]],
    ) -> Optional[Dict[str, Any]]:
        if not groq_service.available():
            return None

        payload = {
            "KNOWN_TWIN_DATA": knowledge.known_summary(),
            "KNOWN_SLOTS": knowledge.known,
            "ASKABLE_SLOTS": {s: SLOT_LABELS[s] for s in knowledge.gaps},
            "RISK_DNA": {
                "capacity_score": knowledge.risk.capacity_score,
                "capacity_band": knowledge.risk.capacity_band,
                "capacity_drivers": knowledge.risk.capacity_drivers,
                "emergency_buffer_months": knowledge.risk.emergency_buffer_months,
                "reserve_band": knowledge.risk.reserve_band,
                "debt_band": knowledge.risk.debt_band,
                "likely_high_interest_debt": knowledge.risk.likely_high_interest_debt,
                "income_stability": knowledge.risk.income_stability,
                "dependents": knowledge.risk.dependents,
                "stated_tolerance": knowledge.risk.stated_tolerance,
                "stated_horizon_years": knowledge.risk.stated_horizon_years,
                "constraints": knowledge.risk.constraints,
                "unknowns": knowledge.risk.unknowns,
            },
            "REALITY_FLAGS": knowledge.reality_flags(),
            "ALREADY_ASKED": {
                "slots": state.asked_slots,
                "questions": state.asked_questions,
                "questions_spent": state.question_count,
                "questions_remaining": max(0, follow_up_budget(state.decision_type) - state.question_count),
                "challenge_already_issued": state.challenge_issued,
            },
            "CONVERSATION_STATE": {
                "decision_type": state.decision_type,
                "user_intent": state.user_intent,
                "slots_discovered": state.slots,
            },
            "TRANSCRIPT": _transcript(chat_history or []),
            "NEW_USER_MESSAGE": message,
        }

        try:
            return groq_service.generate_json(
                json.dumps(payload, default=str),
                system_instruction=ROUTER_SYSTEM_PROMPT,
                temperature=0.2,
                # The configured Groq model is a reasoning model, so its thinking
                # tokens are charged against this budget before a single byte of
                # JSON is emitted. Too low and the call fails outright with
                # "max completion tokens reached before generating a valid
                # document", which silently drops every turn to the deterministic
                # fallback. The JSON itself is a few hundred tokens; the rest of
                # this is headroom for the reasoning in front of it.
                max_output_tokens=4096,
            )
        except Exception as e:
            # Never log the payload — it is the user's financial position.
            logger.error(f"Discovery router call failed: {type(e).__name__}")
            return None

    @staticmethod
    def _parse(raw: Dict[str, Any]) -> DiscoveryAnalysis:
        q = raw.get("next_best_question")
        follow_up = None
        if isinstance(q, dict) and (q.get("question") or "").strip():
            follow_up = FollowUpQuestion(
                question=str(q.get("question")).strip(),
                slot=str(q.get("slot") or "").strip() or "purpose",
                why_it_matters=(q.get("why_it_matters") or None),
                suggestions=[str(s) for s in (q.get("suggestions") or [])][:4],
            )

        decision_type = str(raw.get("decision_type") or "none").strip().lower()
        if decision_type not in DECISION_TYPES:
            decision_type = "none"

        return DiscoveryAnalysis(
            user_intent=str(raw.get("user_intent") or "").strip(),
            decision_type=decision_type,
            known_information=raw.get("known_information") or {},
            critical_unknowns=[str(u) for u in (raw.get("critical_unknowns") or [])],
            next_best_question=follow_up,
            answer_readiness=max(0.0, min(1.0, _safe_float(raw.get("answer_readiness")) or 0.0)),
            decision_detected=bool(raw.get("decision_detected")),
            simulation_eligible=bool(raw.get("simulation_eligible")),
            simulation_type=(raw.get("simulation_type") or None),
            mode=str(raw.get("mode") or "answer").strip().lower(),
            reality_conflicts=[str(c) for c in (raw.get("reality_conflicts") or [])],
            extracted_slots=raw.get("extracted_slots") or {},
            stated_preferences=raw.get("stated_preferences") or {},
            reasoning=str(raw.get("reasoning") or ""),
        )

    # ------------------------------------------------------------- 2. deterministic

    def _fallback_analysis(
        self,
        message: str,
        knowledge: TwinKnowledge,
        state: ConversationDiscoveryState,
    ) -> DiscoveryAnalysis:
        """No Groq key, or the router call failed. Route on the same rule-based
        classifiers Simulation already uses so the product still behaves like
        itself — just with less nuance in the question it picks."""
        scenario_type = classify_scenario(message)
        amounts, months = extract_tokens(message)

        decision_map = {
            "invest_monthly": "investment",
            "invest_lumpsum": "investment",
            "emi_affordability": "loan",
            "increase_savings": "savings",
            "goal_timeline": "goal_planning",
            "income_loss": "income_change",
        }
        decision_type = decision_map.get(scenario_type)

        if decision_type is None:
            # The scenario classifier found nothing, which has two very
            # different causes. Either the user named a decision it doesn't
            # have a pattern for ("should I take a home loan?"), or — far more
            # commonly — they are answering a follow-up ("Generate income.",
            # "2 years", "so what should I do?"), in which case the decision
            # lives in the conversation rather than in the sentence.
            named = _decision_from_markers(message)
            if named and named != state.decision_type:
                decision_type = named
            elif state.decision_type not in ("none", "informational") and not is_informational_question(message):
                decision_type = state.decision_type
            else:
                decision_type = "investment" if amounts else "informational"

        slots: Dict[str, Any] = {}
        if amounts:
            slots["amount"] = amounts[0]
        if months:
            slots["time_horizon"] = round(months / 12, 2)

        known = dict(knowledge.known)
        known.update(state.slots)
        known.update(slots)
        unknowns = [
            s for s in SLOT_PRIORITY.get(decision_type, [])
            if s not in known and s not in state.asked_slots
        ]

        return DiscoveryAnalysis(
            user_intent=state.user_intent or f"User is exploring a {decision_type.replace('_', ' ')} decision.",
            decision_type=decision_type,
            known_information=known,
            critical_unknowns=unknowns,
            answer_readiness=0.4 if unknowns else 0.8,
            decision_detected=decision_type not in ("informational", "none"),
            simulation_eligible=False,   # granted only by the gate in _enforce
            simulation_type=SIMULATION_TYPE_MAP.get(decision_type),
            mode="ask" if (unknowns and state.question_count < follow_up_budget(decision_type)) else "answer",
            extracted_slots=slots,
            reasoning="Deterministic routing (LLM router unavailable).",
        )

    # --------------------------------------------------------------- 3. enforcement

    def _enforce(
        self,
        analysis: DiscoveryAnalysis,
        message: str,
        knowledge: TwinKnowledge,
        state: ConversationDiscoveryState,
    ) -> DiscoveryAnalysis:
        """Where the guarantees live.

        Everything the model proposed is checked against what the session
        actually knows. This is the difference between a prompt that says
        "don't repeat questions" and a system that cannot."""
        if analysis.mode not in ("answer", "ask", "challenge"):
            analysis.mode = "answer"

        # Amounts and durations are pulled deterministically from the text as
        # well, so a number the user typed is never lost to a paraphrase.
        amounts, months = extract_tokens(message)
        if amounts and analysis.extracted_slots.get("amount") in (None, ""):
            analysis.extracted_slots["amount"] = amounts[0]
        if months and analysis.extracted_slots.get("time_horizon") in (None, ""):
            analysis.extracted_slots["time_horizon"] = round(months / 12, 2)
        # "A monthly SIP of about 40,000" answers two things at once. The router
        # reliably picks up the number and routinely misses the mode, and asking
        # "lump sum or monthly?" straight after someone has said "monthly SIP"
        # is precisely the failure this layer exists to prevent.
        if analysis.extracted_slots.get("contribution_mode") in (None, ""):
            mode = _contribution_mode(message)
            if mode:
                analysis.extracted_slots["contribution_mode"] = mode

        known_now = dict(knowledge.known)
        known_now.update(state.slots)
        known_now.update({k: v for k, v in analysis.extracted_slots.items() if v not in (None, "")})

        # --- stay on the decision under discussion --------------------------
        # A short reply to a follow-up ("2 years", "generate income", "I can't
        # afford to lose it") is a continuation, not a new subject. Letting the
        # router's per-turn classification override the conversation's own
        # decision is how an investment thread ends up being asked about EMIs.
        if (
            state.decision_type not in ("none", "informational")
            and analysis.decision_type != state.decision_type
            and analysis.decision_type != "informational"
            and not self._introduces_new_decision(message, analysis.decision_type, known_now, amounts)
        ):
            analysis.decision_type = state.decision_type
            analysis.simulation_type = None  # re-derived by the gate below

        # --- an informational question is never an interrogation -----------
        if analysis.decision_type == "informational":
            analysis.mode = "answer"
            analysis.next_best_question = None
            analysis.decision_detected = False

        # --- investment profiling readiness ----------------------------------
        # Investing is the one decision where an answer given too early is worse
        # than a question: an allocation without a horizon or a risk reading is
        # a guess dressed as advice. So the gate runs in both directions —
        # withhold the recommendation while a blocking answer is missing, and
        # stop asking the moment they are all in.
        if analysis.decision_type in PROFILED_DECISIONS:
            missing = missing_blocking_slots(known_now, knowledge.known)
            budget_left = state.question_count < follow_up_budget(analysis.decision_type)
            analysis.answer_readiness = max(
                analysis.answer_readiness,
                round(1.0 - len(missing) / max(len(BLOCKING_SLOTS), 1), 2),
            )
            if analysis.mode == "ask" and state.question_count == 0 and missing:
                # The opening question shapes everything after it — the goal
                # determines the horizon, the horizon caps the equity, and the
                # allocation follows from both. Asking about risk appetite
                # before knowing what the money is even for is the questionnaire
                # habit this layer exists to avoid, so the first question is
                # pinned to the top of the priority order.
                first = next((s_ for s_ in SLOT_PRIORITY[analysis.decision_type] if s_ in missing), None)
                if first and (analysis.next_best_question is None
                              or analysis.next_best_question.slot != first):
                    text, suggestions = FALLBACK_QUESTIONS.get(
                        first, (f"Could you tell me a bit more about {SLOT_LABELS.get(first, first)}?", []))
                    analysis.next_best_question = FollowUpQuestion(
                        question=text, slot=first,
                        why_it_matters="It determines everything that follows.",
                        suggestions=suggestions,
                    )

            if not missing and analysis.mode == "ask":
                # Everything that changes the recommendation is known. Another
                # question here would be curiosity, not diligence.
                analysis.mode = "answer"
                analysis.next_best_question = None
            elif missing and analysis.mode == "answer" and budget_left and not asks_to_conclude(message):
                # A recommendation would have to invent the missing piece.
                # Ask for the most decisive one instead.
                slot = next((s for s in SLOT_PRIORITY[analysis.decision_type]
                             if s in missing and s not in state.asked_slots), None) or missing[0]
                text, suggestions = FALLBACK_QUESTIONS.get(
                    slot, (f"Could you tell me a bit more about {SLOT_LABELS.get(slot, slot)}?", []))
                analysis.mode = "ask"
                analysis.next_best_question = FollowUpQuestion(
                    question=text, slot=slot,
                    why_it_matters="It changes the allocation, not just the wording.",
                    suggestions=suggestions,
                )
                analysis.critical_unknowns = missing

        # --- the user can end the questioning at any point -------------------
        # "So what should I actually do?" is a request for the recommendation,
        # not an invitation to ask a fourth question. Anything still unknown is
        # stated as an assumption in the answer instead.
        if asks_to_conclude(message) and analysis.mode == "ask":
            analysis.mode = "answer"
            analysis.next_best_question = None
            analysis.decision_detected = analysis.decision_type not in ("none", "informational")

        # --- follow-up validity --------------------------------------------
        if analysis.mode == "ask":
            q = analysis.next_best_question
            invalid = (
                q is None
                or not q.question.strip()
                or q.slot in state.asked_slots
                or q.slot in state.declined_slots
                or q.slot in known_now
                or q.question.strip() in state.asked_questions
                or state.question_count >= follow_up_budget(analysis.decision_type)
                or self._slot_belongs_elsewhere(q.slot, analysis.decision_type)
            )
            if invalid:
                replacement = self._next_unasked_slot(analysis.decision_type, known_now, state)
                if replacement and state.question_count < follow_up_budget(analysis.decision_type):
                    text, suggestions = FALLBACK_QUESTIONS.get(
                        replacement, (f"Could you tell me a bit more about {SLOT_LABELS.get(replacement, replacement)}?", [])
                    )
                    analysis.next_best_question = FollowUpQuestion(
                        question=text,
                        slot=replacement,
                        why_it_matters=analysis.next_best_question.why_it_matters if analysis.next_best_question else None,
                        suggestions=suggestions,
                    )
                else:
                    # Nothing left worth asking, or the budget is spent —
                    # answer with what we have rather than stall the user.
                    analysis.mode = "answer"
                    analysis.next_best_question = None
        else:
            analysis.next_best_question = None

        # --- reality check --------------------------------------------------
        flags = knowledge.reality_flags()
        if state.user_insisted and analysis.mode == "challenge":
            # The user heard the concern and chose to go ahead. Repeating it now
            # would be refusing a decision that is theirs to make. The concern
            # is not dropped — build_brief still carries the flags into the
            # recommendation, and the advisor gives the safest version of what
            # was actually asked for.
            analysis.mode = "answer"
        elif state.challenge_issued and analysis.mode == "challenge":
            # The user has already heard this concern once and is asking again.
            # Saying it a second time is nagging, not advising — so answer them.
            # The concern is not dropped: build_brief() passes the same flags to
            # the Explainer, so the recommendation still respects them.
            analysis.mode = "answer"
        elif flags and analysis.decision_type in CHALLENGEABLE_DECISIONS:
            severe = [f for f in flags if f.get("severity") == "high"]
            if severe and analysis.mode == "answer":
                # A high-severity conflict out-ranks a straight answer, once.
                analysis.mode = "challenge"
            if analysis.mode == "challenge":
                analysis.reality_conflicts = analysis.reality_conflicts or [f["reason"] for f in flags]
        elif analysis.mode == "challenge" and not flags and not analysis.reality_conflicts:
            # The model wanted to push back but has nothing concrete to push
            # back with. Challenging a sound plan is its own failure.
            analysis.mode = "answer"

        # --- simulation gate ------------------------------------------------
        analysis.simulation_eligible, analysis.simulation_type = self._simulation_gate(
            analysis, known_now
        )
        return analysis

    @staticmethod
    def _slot_belongs_elsewhere(slot: str, decision_type: str) -> bool:
        """Reject a question that only makes sense for a different decision.

        Deliberately narrow. The router is free to ask about anything that is
        plausibly relevant here — the order and the wording stay its call, which
        is what keeps this a dynamic information-gap approach rather than a
        questionnaire. What it may not do is ask for a loan's tenure in the
        middle of an investment conversation, and `loan_terms` appearing only
        under "loan" is what makes that checkable."""
        if slot not in SLOT_LABELS:
            return False
        owners = {dt for dt, slots in SLOT_PRIORITY.items() if slot in slots}
        return bool(owners) and len(owners) == 1 and decision_type not in owners

    @staticmethod
    def _introduces_new_decision(
        message: str,
        proposed_type: str,
        known: Dict[str, Any],
        amounts: List[float],
    ) -> bool:
        """Did the user actually raise a different decision in this message?

        Two signals count, and nothing else does: they named the new decision
        outright, or they put a different sum of money on the table. Both are
        things a person genuinely changing subject does; neither happens when
        they are simply answering the question they were asked."""
        text = message.lower()
        if _marker_hit(text, DECISION_CHANGE_MARKERS.get(proposed_type, ())):
            return True

        known_amount = _safe_float(known.get("amount"))
        return any(a != known_amount for a in amounts) if known_amount is not None else bool(amounts)

    @staticmethod
    def _next_unasked_slot(
        decision_type: str,
        known: Dict[str, Any],
        state: ConversationDiscoveryState,
    ) -> Optional[str]:
        for slot in SLOT_PRIORITY.get(decision_type, []):
            if slot in known or slot in state.asked_slots or slot in state.declined_slots:
                continue
            return slot
        return None

    @staticmethod
    def _simulation_gate(analysis: DiscoveryAnalysis, known: Dict[str, Any]) -> Tuple[bool, Optional[str]]:
        """The four conditions from the product brief, checked in code.

        The LLM's own `simulation_eligible` is only ever allowed to *reduce*
        eligibility — it can veto, it cannot grant. Everything else is
        determined here, so a CTA never appears mid-discovery or on a question
        about last month's spending."""
        if analysis.mode == "ask":
            return False, None
        if not analysis.decision_detected:
            return False, None
        if analysis.decision_type not in SIMULATABLE_DECISIONS:
            return False, None

        # "Enough context to create a meaningful simulation": a number to
        # project, or a goal/horizon to project against.
        has_amount = _safe_float(known.get("amount")) is not None
        has_horizon = known.get("time_horizon") is not None or known.get("target_retirement_age") is not None
        has_goal = known.get("goal") is not None
        if not (has_amount or (has_horizon and has_goal) or analysis.decision_type == "goal_planning"):
            return False, None

        # The decision type determines which calculator runs. The router's own
        # suggestion is only honoured when it names a real, specific calculator
        # — it reaches for "generic" readily, and a generic run would throw away
        # the very context the hand-off exists to carry.
        sim_type = analysis.simulation_type
        if sim_type not in KNOWN_SIMULATION_TYPES:
            sim_type = SIMULATION_TYPE_MAP.get(analysis.decision_type, "generic")

        # Lump sum vs. recurring is the one distinction the map can't make from
        # the decision type alone, and it changes the projection completely.
        if analysis.decision_type == "investment":
            recurring = any(
                _looks_recurring(known.get(k)) for k in ("amount", "recurring", "purpose")
            )
            sim_type = "invest_monthly" if recurring else "invest_lumpsum"

        return True, sim_type

    # ------------------------------------------------------------ 4. decision context

    def build_decision_context(
        self,
        analysis: DiscoveryAnalysis,
        knowledge: TwinKnowledge,
        state: ConversationDiscoveryState,
        session_id: Optional[str],
        chat_history: Optional[List[Dict[str, str]]] = None,
    ) -> DecisionContext:
        """Everything discovered, packaged for Simulation.

        The point of this object is that the user never re-enters what they
        already said. It carries the discovered slots, the computed risk
        position and the conversation's own summary — but explicitly not the
        chatbot's recommendation, because Simulation is meant to explore
        alternatives rather than confirm one path."""
        slots = dict(state.slots)
        slots.update({k: v for k, v in analysis.extracted_slots.items() if v not in (None, "")})

        risk = knowledge.risk
        fin = knowledge.fin

        horizon = parse_horizon_years(slots.get("time_horizon"))
        if horizon is None and risk and risk.stated_horizon_years is not None:
            horizon = risk.stated_horizon_years

        constraints = RiskConstraints(
            growth_preference=slots.get("risk_tolerance") or (risk.stated_tolerance if risk else None),
            capital_loss_preference=slots.get("capital_loss_comfort") or (risk.loss_comfort if risk else None),
            liquidity_need=slots.get("liquidity_need"),
            horizon_years=horizon,
            conflicts=analysis.reality_conflicts,
        )

        return DecisionContext(
            decision_type=analysis.decision_type,
            simulation_type=analysis.simulation_type,
            amount=_safe_float(slots.get("amount")),
            recurring=bool(slots.get("recurring")) or analysis.simulation_type == "invest_monthly",
            objective=slots.get("purpose") or (risk.stated_objective if risk else None),
            time_horizon_years=horizon,
            risk_profile={
                "capacity_score": risk.capacity_score if risk else None,
                "capacity_band": risk.capacity_band if risk else None,
                "reserve_band": risk.reserve_band if risk else None,
                "emergency_buffer_months": risk.emergency_buffer_months if risk else None,
                "debt_band": risk.debt_band if risk else None,
                "income_stability": risk.income_stability if risk else None,
                "summary": risk.summary_line() if risk else None,
            },
            risk_constraints=constraints,
            financial_health_context={
                "currency": knowledge.currency,
                "monthly_income": fin.income if fin else None,
                "monthly_expenses": fin.expenses if fin else None,
                "monthly_surplus": round(fin.surplus, 2) if fin else None,
                "total_savings": fin.savings if fin else None,
                "outstanding_loans": fin.loans if fin else None,
                "emergency_buffer_months": risk.emergency_buffer_months if risk else None,
            },
            existing_investments=risk.existing_investments if risk else None,
            user_constraints=(risk.constraints if risk else []),
            blocking_priorities=(risk.blocking_priorities if risk else []),
            conversation_context=self._conversation_context(analysis, state, chat_history),
            discovered_slots=slots,
            session_id=session_id,
        )

    @staticmethod
    def _conversation_context(
        analysis: DiscoveryAnalysis,
        state: ConversationDiscoveryState,
        chat_history: Optional[List[Dict[str, str]]],
    ) -> str:
        """A short prose record of how this decision was arrived at.

        Carried into Simulation so the Recommend stage can see the reasoning
        behind the numbers, and so the UI can show the user what was carried
        over. Kept to the questions and answers that established the decision
        rather than the full transcript — the structured slots already hold the
        facts, and a whole conversation in a prompt invites paraphrase."""
        parts = [analysis.user_intent or state.user_intent or ""]
        if state.asked_questions:
            parts.append("Established by asking: " + "; ".join(state.asked_questions[-3:]))
        if chat_history:
            last_user = [m.get("content", "") for m in chat_history if m.get("role") == "user"][-2:]
            if last_user:
                parts.append("The user's own words: " + " | ".join(t[:200] for t in last_user))
        return " ".join(p for p in parts if p).strip()

    def build_cta(
        self,
        analysis: DiscoveryAnalysis,
        context: DecisionContext,
        original_query: str,
    ) -> Optional[SimulationCTA]:
        """The contextual CTA — or nothing at all, which is the common case."""
        if not analysis.simulation_eligible:
            return None

        label, sublabel = CTA_COPY.get(
            analysis.decision_type,
            ("Compare Future Outcomes", "Model this against your twin's projected future."),
        )
        return SimulationCTA(
            label=label,
            sublabel=sublabel,
            simulation_type=analysis.simulation_type or "generic",
            scenario=self._scenario_sentence(context, original_query),
            decision_context=context,
        )

    @staticmethod
    def _scenario_sentence(context: DecisionContext, original_query: str) -> str:
        """A human-readable restatement of the decision, for the Simulation
        input box. Built from discovered facts rather than the raw question, so
        what Simulation shows matches what was actually established."""
        cur = context.financial_health_context.get("currency") or "₹"
        amount = f"{cur}{context.amount:,.0f}" if context.amount else None
        bits: List[str] = []

        if context.decision_type == "investment":
            bits.append(f"Invest {amount}" if amount else "Invest the amount discussed")
            if context.recurring:
                bits.append("every month")
        elif context.decision_type == "loan":
            bits.append(f"Take on an EMI of {amount}" if amount else "Take on the loan discussed")
        elif context.decision_type == "purchase":
            bits.append(f"Make a {amount} purchase" if amount else "Make the purchase discussed")
        elif context.decision_type == "savings":
            bits.append(f"Save an extra {amount} a month" if amount else "Increase monthly savings")
        elif context.decision_type == "retirement":
            bits.append(f"Invest {amount} a month towards retiring early" if amount else "Plan for early retirement")
        elif context.decision_type == "goal_planning":
            bits.append("Reach my savings goal")
        elif context.decision_type == "income_change":
            bits.append("Manage a period without income")
        elif context.decision_type == "debt_payoff":
            bits.append(f"Put {amount} towards clearing debt" if amount else "Clear outstanding debt faster")
        else:
            return original_query.strip()

        if context.objective:
            # The objective is whatever the user said ("Generate income.",
            # "grow_capital_then_generate_income"), so it needs tidying before
            # it can sit mid-sentence.
            objective = str(context.objective).replace("_", " ").strip().rstrip(".!,")
            if objective:
                bits.append(f"to {objective[0].lower() + objective[1:]}")
        if context.time_horizon_years:
            years = context.time_horizon_years
            bits.append(f"over {years:g} year{'s' if years != 1 else ''}")
        return " ".join(bits).strip()

    # ------------------------------------------------------------------ 5. generation

    def render_question(self, analysis: DiscoveryAnalysis, knowledge: TwinKnowledge, message: str) -> str:
        """Phrase the chosen follow-up. Falls back to the question verbatim,
        which is already a complete, sensible turn on its own."""
        q = analysis.next_best_question
        if not q:
            return ""
        if not groq_service.available():
            return q.question

        known = knowledge.known_summary()
        prompt = (
            f"The user just said: {message}\n\n"
            f"What they appear to be trying to achieve: {analysis.user_intent}\n"
            f"Already known about them (use ONE relevant figure to show you're not re-asking): {json.dumps(known, default=str)}\n"
            f"Currency symbol to use: {knowledge.currency}\n"
            f"The exact question to ask: {q.question}\n"
            f"Why it matters: {q.why_it_matters or 'It materially changes the recommendation.'}\n"
        )
        try:
            text = groq_service.generate(
                prompt,
                system_instruction=QUESTION_SYSTEM_PROMPT,
                temperature=0.5,
                # The prompt caps the reply at 70 words, but the configured Groq
                # model is a reasoning model and spends this budget on thinking
                # before it writes anything. Too low and the call returns a
                # fragment ("I see you're") rather than failing outright.
                max_output_tokens=1200,
            )
            phrased = (text or "").strip()
            # A phrasing that lost the question is worse than no phrasing. The
            # raw question is always a complete, sensible turn on its own.
            if not phrased or "?" not in phrased or len(phrased) < len(q.question) / 2:
                return q.question
            return phrased
        except Exception as e:
            logger.error(f"Discovery question generation failed: {type(e).__name__}")
            return q.question

    def render_challenge(self, analysis: DiscoveryAnalysis, knowledge: TwinKnowledge, message: str) -> str:
        """Write the push-back, grounded in the deterministic reality flags."""
        flags = knowledge.reality_flags()
        if not groq_service.available():
            return self._fallback_challenge(flags, knowledge)

        prompt = (
            f"The user asked: {message}\n\n"
            f"What they're trying to achieve: {analysis.user_intent}\n"
            f"Currency symbol to use: {knowledge.currency}\n"
            f"Their real financial position: {json.dumps(knowledge.known_summary(), default=str)}\n"
            f"Verified conflicts (computed from their own figures — quote these, invent nothing): "
            f"{json.dumps(flags, default=str)}\n"
            f"Additional conflicts detected in what they asked for: {analysis.reality_conflicts}\n"
        )
        try:
            text = groq_service.generate(
                prompt,
                system_instruction=CHALLENGE_SYSTEM_PROMPT,
                temperature=0.45,
                # The prompt caps the challenge at 180 words; this leaves room
                # for that plus the model's reasoning tokens, so a push-back is
                # never cut off mid-sentence.
                max_output_tokens=1100,
            )
            return (text or "").strip() or self._fallback_challenge(flags, knowledge)
        except Exception as e:
            logger.error(f"Discovery challenge generation failed: {type(e).__name__}")
            return self._fallback_challenge(flags, knowledge)

    @staticmethod
    def _fallback_challenge(flags: List[Dict[str, Any]], knowledge: TwinKnowledge) -> str:
        if not flags:
            return ""
        top = flags[0]
        cur = knowledge.currency
        lines = [
            "Before we get to that, one thing in your own numbers is worth putting first.",
            "",
            f"**{top['label']}.** {top['reason']}",
        ]
        if top.get("target_amount"):
            lines.append(
                f"On your current expenses that's about {cur}{top['target_amount']:,.0f} to set aside first."
            )
        if len(flags) > 1:
            lines.append("")
            lines.append("Also worth knowing: " + flags[1]["reason"])
        lines += [
            "",
            "That said, it's your call. If you'd still like to go ahead with what you asked, "
            "tell me and I'll work through it with you properly.",
        ]
        return "\n".join(lines)

    @staticmethod
    def build_brief(analysis: DiscoveryAnalysis, knowledge: TwinKnowledge, state: ConversationDiscoveryState) -> str:
        """The instruction block appended to the existing Explainer's task.

        This is how discovery reaches the final answer without replacing the
        pipeline that produces it: the orchestrator still does the grounding,
        the market data and the formatting — it just now knows what was
        actually being asked."""
        slots = dict(state.slots)
        slots.update({k: v for k, v in analysis.extracted_slots.items() if v not in (None, "")})
        risk = knowledge.risk
        return DISCOVERY_BRIEF_TEMPLATE.format(
            intent=analysis.user_intent or "Not explicitly stated.",
            decision_type=analysis.decision_type,
            known=json.dumps(knowledge.known_summary(), default=str),
            slots=json.dumps(slots, default=str) or "nothing beyond the profile",
            risk_summary=risk.summary_line() if risk else "unknown",
            capacity_drivers="; ".join(risk.capacity_drivers) if risk and risk.capacity_drivers else "none computed",
            constraints="; ".join(risk.constraints) if risk and risk.constraints else "none",
            flags="; ".join(f["reason"] for f in knowledge.reality_flags()) or "none",
            insistence=(
                "THE USER HAS ALREADY HEARD THESE CONCERNS AND CHOSE TO PROCEED. Do not re-argue "
                "them and do not refuse. Acknowledge the risk in a single sentence, then give the "
                "safest workable version of what they actually asked for."
                if state.user_insisted else ""
            ),
        )


discovery_engine = DiscoveryEngine()
