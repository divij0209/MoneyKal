"""
One chat turn, routed through the Financial Discovery layer.

This is the module POST /twin/chat calls for an individual profile. It is the
glue between four things that already existed or were added alongside it:

  twin_knowledge.build_twin_knowledge  — what the twin already knows
  discovery_session.load_state/save_state — what this conversation established
  discovery.discovery_engine           — what should happen with this turn
  orchestrator.process_query           — the existing grounded answer pipeline

The important property: the grounding never changes. The Data agent and the
market intelligence run exactly as they always did; what the discovery layer
adds is knowing what the user is actually deciding before answering it.

There are three answer shapes, and which one runs is decided, not guessed:

  - An investment or retirement decision whose profile is complete is answered
    from `services/investment_advisor.py`. Every figure in that reply — the
    investable amount, the allocation, the return range, the downside — is
    computed there, and the model is given those numbers and forbidden from
    producing others.
  - Everything else goes through the original orchestrator, conversationally by
    default. The ten-section report is still exactly one request away: ask for
    a breakdown, a comparison or projections and `wants_detailed_report` routes
    you to it, unchanged.
  - "ask" and "challenge" write their own short replies and never invoke the
    report format, because a follow-up question is not a report.
"""
from backend.core.money import group_indian
import datetime
import logging
from typing import Any, Dict, List, Optional

from backend.agents.discovery import (
    PROFILED_DECISIONS,
    asks_to_conclude,
    discovery_engine,
    parse_horizon_years,
    user_insists,
    wants_detailed_report,
)
from backend.agents.orchestrator import orchestrator
from backend.agents.sub_agents import investment_agent, is_agent_error
from backend.schemas.api_models import ChatResponse
from backend.services.discovery_session import load_state, save_state
from backend.services.groq_service import groq_service
from backend.services.investment_advisor import (
    BLOCKING_SLOTS,
    build_recommendation,
    missing_blocking_slots,
    render_recommendation_text,
)
from backend.services.risk_profile import save_stated_preferences
from backend.services.twin_knowledge import SLOT_LABELS, build_twin_knowledge

logger = logging.getLogger(__name__)

# Same set the orchestrator fast-paths on. Checked here too so a "hi" never
# costs a router call — there is no decision behind a greeting to discover.
_GREETINGS = {"hi", "hello", "hey", "hii", "hiya", "yo", "sup", "hola", "namaste", "thanks", "thank you", "ok", "okay"}

# Which discovered slots outlive the decision they were discovered in.
#
# How much volatility a person can live with is a fact about them; what this
# particular ₹10,000 is for is a fact about one decision. Only the first kind
# survives a change of subject, and only the first kind is allowed to suppress
# a future question — see `known` in twin_knowledge.build_twin_knowledge.
DURABLE_SLOTS = {"risk_tolerance", "capital_loss_comfort"}

# Slots written back to the profile (risk_profile.save_stated_preferences) so a
# future conversation starts already knowing them. Purpose and horizon are here
# as *remembered context* rather than as established fact: they seed a default
# in the decision hand-off, but they deliberately do not mark the corresponding
# question as answered, because the purpose of the next pot of money is a
# genuinely open question.
PREFERENCE_SLOTS = {
    "risk_tolerance": "tolerance",
    "capital_loss_comfort": "loss_comfort",
    "purpose": "objective",
    "time_horizon": "horizon_years",
}

DISCLAIMER = (
    "This is an AI-generated analysis based on your financial profile and does not constitute "
    "financial advice. Consider consulting a certified financial advisor before making major "
    "financial decisions."
)


def _sources(extra: Optional[List[str]] = None) -> List[Dict[str, str]]:
    now = datetime.datetime.utcnow().isoformat()
    rows = [{"source": "Financial Twin Profile", "timestamp": now},
            {"source": "Financial Risk DNA", "timestamp": now}]
    for name in extra or []:
        rows.append({"source": name, "timestamp": now})
    return rows


def run_discovery_turn(
    profile: Any,
    message: str,
    chat_history: List[Dict[str, str]],
    session_id: Optional[str],
    db: Any,
) -> ChatResponse:
    """Decide what this turn should be, then produce it.

    Never raises on a discovery failure: if anything in the new layer breaks,
    the turn falls through to the original orchestrator path, which is exactly
    what the chatbot did before this layer existed."""
    try:
        return _run(profile, message, chat_history, session_id, db)
    except Exception as e:
        logger.error(f"Discovery turn failed, falling back to the base pipeline: {type(e).__name__}: {e}")
        return orchestrator.process_query(profile, message, chat_history=chat_history, db=db)


def _run(
    profile: Any,
    message: str,
    chat_history: List[Dict[str, str]],
    session_id: Optional[str],
    db: Any,
) -> ChatResponse:
    # Small talk has no decision behind it. Straight to the existing fast path.
    if message.strip().lower().strip("!.? ") in _GREETINGS:
        return orchestrator.process_query(profile, message, chat_history=chat_history, db=db)

    knowledge = build_twin_knowledge(profile, db=db)
    state = load_state(db, session_id)

    analysis = discovery_engine.analyze(message, knowledge, state, chat_history)

    # --- capture the answer to the question we actually asked ---------------
    # When the twin asked about a slot last turn, this message is the answer to
    # it. The router usually reports that in `extracted_slots`, but not always —
    # and a dropped answer is the worst possible failure here, because the next
    # turn would ask the same thing again. Recording it structurally means the
    # user only ever has to say something once.
    if state.pending_slot and analysis.decision_type == state.decision_type:
        already = {k: v for k, v in analysis.extracted_slots.items() if v not in (None, "")}
        # "Just tell me" and "I still want to" are statements about the
        # conversation, not answers to the question. Filing one as the user's
        # risk tolerance or contribution mode would corrupt the profile with
        # the one thing they explicitly declined to give.
        is_meta = asks_to_conclude(message) or user_insists(message)
        if not already and not is_meta:
            # The router extracted nothing at all, so the message is the answer
            # to what was asked. Without this, an answer the model failed to
            # parse is lost and the same question comes round again.
            analysis.extracted_slots[state.pending_slot] = message.strip()[:200]
        # When it DID extract something, that mapping is trusted over the raw
        # text. Someone answering "long-term wealth building" to a question
        # about risk appetite has told you their goal, not their tolerance, and
        # filing it under tolerance would corrupt the allocation downstream.
        state.pending_slot = None

    # --- has the user overridden a concern already raised? -----------------
    # Sticky for the rest of the conversation. Requirement is simple and
    # absolute: having said "I understand the risk, go ahead", they must not be
    # told again on the next turn, or the turn after that.
    if state.challenge_issued and user_insists(message):
        state.user_insisted = True

    # --- did the user change subject? --------------------------------------
    # Checked BEFORE this turn's discoveries are folded in, and only when there
    # was a real previous decision to move away from. Both matter: the first
    # classification of a conversation goes "none" -> "investment", and treating
    # that as a subject change would wipe the amount discovered on the very same
    # turn — leaving the twin to ask for a figure the user had already given.
    changed_subject = (
        analysis.decision_type not in ("none", "informational")
        and state.decision_type not in ("none", "informational")
        and state.decision_type != analysis.decision_type
    )
    if changed_subject:
        # Question budget and challenge state are per-decision, so a genuinely
        # new decision gets a fresh start rather than inheriting a spent budget
        # — otherwise changing your mind would silently cost you the twin's
        # ability to ask anything.
        #
        # The decision-specific slots go too. Carrying "₹10,000, to generate
        # income, over 2 years" into a question about a home loan would hand
        # Simulation figures the user never gave for that decision. What
        # survives is what is true about the person rather than the plan.
        state.question_count = 0
        state.asked_slots = []
        state.challenge_issued = False
        state.pending_slot = None
        state.recommended_signature = None
        state.slots = {k: v for k, v in state.slots.items() if k in DURABLE_SLOTS}

    if analysis.decision_type not in ("none", "informational"):
        state.decision_type = analysis.decision_type

    # --- fold what this turn revealed into the conversation's memory -------
    state.absorb(analysis.extracted_slots)
    if analysis.user_intent:
        state.user_intent = analysis.user_intent

    # Preferences the user stated are persisted to the profile, not just to the
    # session — so a future conversation already knows them and never re-asks.
    # Derived from the discovered slots as well as from the router's own report,
    # because the slot is the thing the user actually answered: relying on the
    # model to also remember to fill `stated_preferences` loses the memory
    # whenever it doesn't.
    prefs = dict(analysis.stated_preferences or {})
    for slot, key in PREFERENCE_SLOTS.items():
        if state.slots.get(slot) is not None and not prefs.get(key):
            prefs[key] = state.slots[slot]
    # A horizon reaches us as "2 years" or "18 months" as often as a number.
    # It is stored numerically because that is how build_risk_profile reads it
    # back — storing the phrase would silently lose the preference.
    if prefs.get("horizon_years") is not None:
        prefs["horizon_years"] = parse_horizon_years(prefs["horizon_years"])
    save_stated_preferences(db, profile, prefs)

    # --- route -------------------------------------------------------------
    if analysis.mode == "ask":
        response = _ask(analysis, knowledge, message, state)
    elif analysis.mode == "challenge":
        # A challenge is free-form prose, which is exactly where invented
        # numbers creep in. Once an investment profile is complete there is a
        # computed recommendation available, and it already carries the
        # blocking priorities and the return conflicts — so the push-back is
        # made with real figures instead of plausible-sounding ones.
        computed = None
        if analysis.decision_type in PROFILED_DECISIONS:
            computed = _investment_answer(analysis, knowledge, message, state, chat_history)
        if computed is not None:
            state.challenge_issued = True
            response = computed
        else:
            response = _challenge(analysis, knowledge, message, state, profile, chat_history, db)
    else:
        response = _answer(analysis, knowledge, message, state, profile, chat_history, db)

    # --- simulation hand-off -----------------------------------------------
    context = None
    if analysis.simulation_eligible:
        context = discovery_engine.build_decision_context(
            analysis, knowledge, state, session_id, chat_history
        )
        cta = discovery_engine.build_cta(analysis, context, message)
        if cta:
            response.simulation_cta = cta
            state.decision_context = context

    # --- transparency -------------------------------------------------------
    response.mode = analysis.mode
    response.user_intent = analysis.user_intent or None
    response.decision_type = analysis.decision_type
    response.discovery = {
        "answer_readiness": round(analysis.answer_readiness, 2),
        "decision_detected": analysis.decision_detected,
        "known_from_profile": [
            SLOT_LABELS.get(s, s) for s in knowledge.known
        ],
        "critical_unknowns": [
            SLOT_LABELS.get(u, u) for u in analysis.critical_unknowns
        ],
        "questions_asked": state.question_count,
        "risk_summary": knowledge.risk.summary_line() if knowledge.risk else None,
        "reasoning": analysis.reasoning,
    }

    state.last_mode = analysis.mode
    save_state(db, session_id, state, context)
    return response


# ---------------------------------------------------------------------------
# The three modes
# ---------------------------------------------------------------------------

def _ask(analysis, knowledge, message: str, state) -> ChatResponse:
    """A single follow-up question — never a report, never a recommendation."""
    text = discovery_engine.render_question(analysis, knowledge, message)
    q = analysis.next_best_question
    if q:
        state.register_question(q)

    trace = [
        {
            "agent": "Discovery",
            "action": "Analysed the decision behind the question",
            "output": analysis.user_intent or "Intent still forming.",
        },
        {
            "agent": "Data",
            "action": "Checked the Financial Twin for what is already known",
            "output": ", ".join(SLOT_LABELS.get(s, s) for s in knowledge.known) or "Nothing on file yet.",
        },
        {
            "agent": "Discovery",
            "action": "Identified the single unknown that would most change the recommendation",
            "output": f"{SLOT_LABELS.get(q.slot, q.slot) if q else 'unknown'}: {q.why_it_matters if q and q.why_it_matters else 'materially changes the advice'}",
        },
    ]

    return ChatResponse(
        session_id="",
        answer=text,
        confidence="medium",
        sources=_sources(),
        reasoning_trace=trace,
        # A question is not advice, so the advice disclaimer would be noise here.
        disclaimer="",
        follow_up=q,
    )


def _challenge(analysis, knowledge, message: str, state, profile, chat_history, db) -> ChatResponse:
    """Respectful push-back, grounded in the user's own figures.

    Issued at most once per decision (`challenge_issued`). If the user hears it
    and asks again, the next turn answers them properly — this is a twin, not a
    gatekeeper."""
    text = discovery_engine.render_challenge(analysis, knowledge, message)
    if not text:
        # Nothing concrete to say — never manufacture a concern.
        return _answer(analysis, knowledge, message, state, profile, chat_history, db)

    state.challenge_issued = True
    flags = knowledge.reality_flags()

    trace = [
        {
            "agent": "Discovery",
            "action": "Analysed the decision behind the question",
            "output": analysis.user_intent or message[:200],
        },
        {
            "agent": "Risk",
            "action": "Checked the request against the user's real financial position",
            "output": "; ".join(f["label"] for f in flags) or "; ".join(analysis.reality_conflicts),
        },
        {
            "agent": "Discovery",
            "action": "Chose to raise a higher-priority alternative rather than answer directly",
            "output": analysis.reasoning or "The request conflicts with a computed financial priority.",
        },
    ]

    return ChatResponse(
        session_id="",
        answer=text,
        confidence="high",
        sources=_sources(),
        reasoning_trace=trace,
        disclaimer=DISCLAIMER,
    )


def _investment_answer(analysis, knowledge, message: str, state, chat_history) -> Optional[ChatResponse]:
    """A fully-computed investment recommendation, phrased by the LLM.

    Everything that is a number — the investable amount, the allocation, the
    expected range, the downside, the projection — comes from
    services/investment_advisor.py. The model receives those as facts and is
    forbidden from producing any others, so the allocation a user acts on is
    the output of arithmetic against their real position rather than of a
    language model's intuition about portfolios.

    Returns None when the profile isn't complete enough, letting the caller
    fall through to the ordinary grounded answer."""
    slots = dict(state.slots)
    if missing_blocking_slots(slots, knowledge.known):
        return None

    # Has anything that would change the allocation actually changed? If the
    # user is just talking after receiving a recommendation, restating the same
    # allocation word for word is not an answer to what they said.
    signature = "|".join(f"{k}={slots.get(k)}" for k in sorted(BLOCKING_SLOTS)) \
        + f"|insisted={state.user_insisted}"
    # Asking for it again is always honoured. Suppressing a recommendation
    # because it was given a turn ago would answer "so what should I actually
    # do?" with silence, which is the one thing worse than repeating yourself.
    asked_for_it = wants_detailed_report(message) or asks_to_conclude(message)
    if state.recommended_signature == signature and not asked_for_it:
        return None
    is_revision = state.recommended_signature is not None
    state.recommended_signature = signature

    rec = build_recommendation(
        knowledge.fin, knowledge.risk, slots, user_insisted=state.user_insisted,
    )
    payload = rec.to_dict()
    payload["user_insisted"] = state.user_insisted
    payload["user_question"] = message
    # A revision is a different conversational act from a first recommendation:
    # the user changed something and wants to know what it did, not to be told
    # the whole plan again from scratch.
    payload["is_revision"] = is_revision

    answer = ""
    if groq_service.available():
        try:
            answer = investment_agent.process(
                {"COMPUTED_RECOMMENDATION": payload},
                "Deliver this recommendation in the user's own terms. Use only the numbers given.",
                chat_history=chat_history,
                max_output_tokens=1100,
            ).strip()
        except Exception as e:
            logger.error(f"Investment recommendation phrasing failed: {type(e).__name__}")

    # An LLM failure must not cost the user their recommendation — the whole
    # thing is already computed, so it can be written out directly.
    if not answer or is_agent_error(answer):
        answer = render_recommendation_text(rec)

    trace = [
        {"agent": "Discovery", "action": "Investment profile complete",
         "output": ", ".join(f"{k}={v}" for k, v in slots.items())},
        {"agent": "Risk", "action": "Reconciled risk tolerance against risk capacity",
         "output": rec.risk.get("explanation", "")},
        {"agent": "Advisor", "action": "Computed investable amount, allocation and return range deterministically",
         "output": f"{rec.currency}{group_indian(rec.investable.get('recommended', 0))} across "
                   + ", ".join(f"{a['pct']}% {a['sleeve']}" for a in rec.allocation)},
        {"agent": "Check", "action": "Compared the desired return against risk and horizon",
         "output": rec.feasibility.get("explanation", "")},
    ]

    return ChatResponse(
        session_id="",
        answer=answer,
        confidence="high",
        sources=_sources(["Investment Advisor (deterministic)"]),
        reasoning_trace=trace,
        disclaimer=DISCLAIMER,
    )


def _answer(analysis, knowledge, message: str, state, profile, chat_history, db) -> ChatResponse:
    """The original grounded pipeline, now told what it is actually answering."""
    # An investment decision with a complete profile is answered from computed
    # figures rather than from the general pipeline.
    if analysis.decision_type in PROFILED_DECISIONS:
        computed = _investment_answer(analysis, knowledge, message, state, chat_history)
        if computed is not None:
            return computed

    brief = discovery_engine.build_brief(analysis, knowledge, state)
    # Conversational unless the user actually asked for the long form. The
    # ten-section report is still exactly one request away, and Simulation and
    # the startup persona are untouched by this.
    style = "detailed" if wants_detailed_report(message) else "concise"
    response = orchestrator.process_query(
        profile, message, chat_history=chat_history, db=db, discovery_brief=brief, style=style,
    )

    # If the provider was down or rate-limited, the Explainer hands back its own
    # error string rather than an answer. Where an investment profile exists,
    # the recommendation is already computed and can be written out instead —
    # an outage should cost the user some warmth of tone, not their advice.
    if is_agent_error(response.answer) and analysis.decision_type in PROFILED_DECISIONS:
        slots = dict(state.slots)
        if not missing_blocking_slots(slots, knowledge.known):
            rec = build_recommendation(
                knowledge.fin, knowledge.risk, slots, user_insisted=state.user_insisted,
            )
            response.answer = render_recommendation_text(rec)
            response.sources = _sources(["Investment Advisor (deterministic)"])
            response.reasoning_trace = list(response.reasoning_trace or []) + [{
                "agent": "Advisor",
                "action": "Language model unavailable, rendered the computed recommendation directly",
                "output": f"{rec.currency}{group_indian(rec.investable.get('recommended', 0))}",
            }]
    # Put the discovery step at the front of the trace so the audit record
    # shows the routing decision that led to this answer.
    response.reasoning_trace = [{
        "agent": "Discovery",
        "action": "Analysed intent, checked the twin for known data, and judged the query answerable",
        "output": analysis.reasoning or (analysis.user_intent or "Query was complete enough to answer."),
    }] + list(response.reasoning_trace or [])
    return response
