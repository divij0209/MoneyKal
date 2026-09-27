import datetime
from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
# pyrefly: ignore [missing-import]
from sqlalchemy.orm import Session
import uuid

from backend.database import get_db
from backend.models.domain import Profile, AuditTrace, ChatSession, ChatMessage, SimulationRun
from backend.schemas.api_models import ChatRequest, ChatResponse, SimulateRequest, SimulateResponse, Outcome, ChatSessionResponse, ChatSessionDetail, ChatMessageModel, ScenarioSimulateRequest, ScenarioSimulateResponse, ChatRenameRequest, GenericResponse, SimulationRunSummary, SimulationRunDetail
from typing import List, Optional
from backend.core.auth import get_current_user
from backend.core.chat_guard import (
    ChatInputError, REFUSAL_MESSAGE, is_injection_attempt, sanitize_answer,
    validate_message,
)
from backend.models.domain import User
from backend.agents.orchestrator import orchestrator
from backend.agents.startup_orchestrator import startup_orchestrator
# VARTA's transcription. The same module the Tathya agent chain already
# uses, so no second provider and no second key enter the backend.
from backend.services.groq_service import groq_service
# The Financial Discovery layer — intent analysis, follow-up questions and the
# Simulation hand-off. It wraps the orchestrator above rather than replacing it.
from backend.services.discovery_flow import run_discovery_turn
from backend.services.discovery_session import load_decision_context
from backend.routers.startup import log_startup_decision
# Free monthly allowances for Tathya questions and simulations (SEE tier).
from backend.core.access import Allowance, require_allowance

router = APIRouter(prefix="/twin", tags=["Twin"])

@router.get("/chats", response_model=List[ChatSessionResponse])
def get_chat_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        return []
    
    sessions = db.query(ChatSession).filter(ChatSession.profile_id == profile.id).order_by(ChatSession.created_at.desc()).all()
    return [{"id": s.id, "title": s.title or "New Chat", "created_at": s.created_at.isoformat()} for s in sessions]

@router.get("/chats/{session_id}", response_model=ChatSessionDetail)
def get_chat_session(session_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.profile_id == profile.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    return {
        "id": session.id,
        "title": session.title or "New Chat",
        "created_at": session.created_at.isoformat(),
        "messages": [{"role": m.role, "content": m.content} for m in session.messages]
    }

@router.delete("/chats/{session_id}", response_model=GenericResponse)
def delete_chat_session(session_id: str, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.profile_id == profile.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    from backend.models.domain import ChatDiscoveryState
    discovery_state = db.query(ChatDiscoveryState).filter(ChatDiscoveryState.session_id == session_id).first()
    if discovery_state:
        db.delete(discovery_state)
        
    db.delete(session)
    db.commit()
    return {"success": True, "message": "Session deleted"}

@router.put("/chats/{session_id}", response_model=GenericResponse)
def rename_chat_session(session_id: str, req: ChatRenameRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.profile_id == profile.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
        
    session.title = req.title
    db.commit()
    return {"success": True, "message": "Session renamed"}

@router.post("/chat")
def chat_with_twin(req: ChatRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db),
                   allowance: Allowance = Depends(require_allowance("ask_twin"))):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    # Bounds-checked before anything else. An empty message used to be accepted
    # and cost a full 22-second model round trip to answer with nothing; a
    # 13,200-character one took 51 seconds. Neither reaches a model now.
    try:
        message = validate_message(req.message)
    except ChatInputError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # An attempt to address the instruction layer is refused here rather than
    # passed to the model with a polite request not to comply. It is answered in
    # the normal shape — and stored in the transcript — so the conversation
    # continues rather than erroring out.
    if is_injection_attempt(message):
        return _refusal_response(profile, message, req.session_id, db)

    session_id = req.session_id
    if not session_id:
        session_id = str(uuid.uuid4())
        session = ChatSession(id=session_id, profile_id=profile.id, title=message[:30] + "...")
        db.add(session)
    else:
        session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.profile_id == profile.id).first()
        if not session:
            # Check if it exists under a different profile to avoid IntegrityError
            existing = db.query(ChatSession).filter(ChatSession.id == session_id).first()
            if existing:
                session_id = str(uuid.uuid4())
            
            session = ChatSession(id=session_id, profile_id=profile.id, title=message[:30] + "...")
            db.add(session)
            
    db.commit()
            
    user_msg = ChatMessage(session_id=session_id, role="user", content=message)
    db.add(user_msg)
    db.commit()
    
    history = db.query(ChatMessage).filter(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at).all()
    chat_history = [{"role": "assistant" if m.role == "twin" else m.role, "content": m.content} for m in history[:-1]]

    # Chat session storage/CRUD is generic infra shared across personas — only the
    # grounding/calculation engine behind the answer differs.
    active_orchestrator = startup_orchestrator if profile.key == "startup" else orchestrator

    if profile.key == "startup":
        # The Financial Discovery layer's risk model, slot vocabulary and
        # reality checks are all built around an individual's finances
        # (emergency buffer, dependents, personal debt). A founder's twin has
        # its own engine and its own risk language, so it keeps the original
        # path untouched rather than being routed through a model that doesn't
        # describe it.
        response = active_orchestrator.process_query(profile, message, chat_history=chat_history, db=db)
    else:
        response = run_discovery_turn(
            profile=profile,
            message=message,
            chat_history=chat_history,
            session_id=session_id,
            db=db,
        )

    # Outbound guard. An empty answer used to render as an empty chat bubble
    # with confidence "high"; a leaked instruction block used to render in full.
    # Applied before the reply is persisted, so the stored transcript matches
    # what the user actually saw.
    response.answer = sanitize_answer(response.answer)

    twin_msg = ChatMessage(session_id=session_id, role="twin", content=response.answer)
    db.add(twin_msg)

    # Save audit trace
    req_id = str(uuid.uuid4())
    audit = AuditTrace(
        id=req_id,
        profile_id=profile.id,
        query=message,
        response=response.model_dump(),
        reasoning_trace=response.reasoning_trace,
        sources=response.sources
    )
    db.add(audit)
    db.commit()
    # Counted only once the answer exists, so a failed turn costs nothing.
    allowance.record()

    response.session_id = session_id
    return response

def _refusal_response(profile, message: str, session_id, db) -> ChatResponse:
    """Answer an instruction-layer probe without calling a model.

    Shaped exactly like a normal reply — same session handling, same transcript
    write — so the client needs no special case and the conversation carries on.
    """
    if not session_id:
        session_id = str(uuid.uuid4())
        db.add(ChatSession(id=session_id, profile_id=profile.id, title=message[:30] + "..."))
    else:
        exists = db.query(ChatSession).filter(
            ChatSession.id == session_id, ChatSession.profile_id == profile.id
        ).first()
        if not exists:
            session_id = str(uuid.uuid4())
            db.add(ChatSession(id=session_id, profile_id=profile.id, title=message[:30] + "..."))
    db.commit()

    db.add(ChatMessage(session_id=session_id, role="user", content=message))
    db.add(ChatMessage(session_id=session_id, role="twin", content=REFUSAL_MESSAGE))
    db.commit()

    # Same shape as every other reply on this route: reasoning_trace is a list
    # of {agent, action, output} dicts and disclaimer is required, so the client
    # renders this exactly like a normal turn.
    return ChatResponse(
        session_id=session_id,
        answer=REFUSAL_MESSAGE,
        confidence="high",
        sources=[{"source": "Input guard", "timestamp": datetime.datetime.utcnow().isoformat()}],
        reasoning_trace=[{
            "agent": "Guard",
            "action": "Screened the message before any model was called",
            "output": (
                "The message targeted the assistant's instructions rather than asking a "
                "financial question, so it was declined without being sent to a model."
            ),
        }],
        disclaimer="This is an AI-generated response and does not constitute financial advice.",
    )


def compute_outcome(decision: dict, pct: int):
    primary = decision["primaryStart"] + decision["impactRate"] * pct
    secondary = decision["secondaryStart"] + decision["secondaryImpactRate"] * pct
    return primary, secondary

def score_outcome(decision: dict, primary: float, pct: int):
    direction = 1 if decision["goodDirection"] == 'up' else -1
    progress = direction * (primary - decision["primaryStart"])
    overcommitPenalty = (pct - 70) * 0.35 if pct > 70 else 0
    inactionPenalty = 4 if pct == 0 else 0
    return progress - overcommitPenalty - inactionPenalty

@router.post("/simulate")
def simulate_decision(req: SimulateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
        
    decision = next((d for d in profile.decisionTypes if d["id"] == req.decision_id), None)
    if not decision:
        raise HTTPException(status_code=400, detail="Invalid decision ID")

    # Re-implementing the exact logic from the frontend in python
    outcomes = [
        {"label": 'Hold, take no action', "pct": 0},
        {"label": f'Partial ({req.commitment_pct}% commitment)', "pct": req.commitment_pct},
        {"label": 'Full commitment', "pct": 100}
    ]
    
    scored_outcomes = []
    for o in outcomes:
        pri, sec = compute_outcome(decision, o["pct"])
        score = score_outcome(decision, pri, o["pct"])
        scored_outcomes.append({
            "label": o["label"],
            "pct": o["pct"],
            "score": score,
            "primary_outcome": pri,
            "secondary_outcome": sec,
            "is_best": False
        })
        
    best_idx = 0
    for i in range(1, len(scored_outcomes)):
        if scored_outcomes[i]["score"] > scored_outcomes[best_idx]["score"]:
            best_idx = i
            
    scored_outcomes[best_idx]["is_best"] = True
    best = scored_outcomes[best_idx]
    
    explanation = decision["inactionNote"] if best["pct"] == 0 else (
        f"Committing {best['pct']}% moves {decision['primaryLabel'].lower()} to {best['primary_outcome']:.1f}{decision['primaryUnit']} "
        f"while keeping the commitment level measured rather than maximal. The Check agent confirmed this stays within policy."
    )

    return SimulateResponse(outcomes=scored_outcomes, explanation=explanation)


def log_individual_decision(db: Session, profile: Profile, scenario_text: str, response: ScenarioSimulateResponse) -> None:
    from backend.models.domain import DecisionHistory
    if response.mode != "scenario":
        return
        
    tag = "neutral"
    if response.risks and len(response.risks) > 0 and response.risks != ["No material risks identified from the available data."]:
        tag = "warn"
    elif "Approve" in response.recommendation or "good" in response.recommendation.lower() or "proceed" in response.recommendation.lower() or "recommend" in response.recommendation.lower():
        tag = "good"
        
    outcome_text = response.recommendation
    if len(outcome_text) > 100:
        outcome_text = outcome_text[:97] + "..."
        
    log = DecisionHistory(
        profile_id=profile.id,
        title=scenario_text[:120],
        date_str=datetime.datetime.now().strftime("%d %b %Y"),
        outcome=outcome_text,
        tag=tag
    )
    db.add(log)
    db.commit()

def iso_utc(value) -> str:
    """Serialise a stored timestamp as unambiguous UTC.

    `created_at` is written with datetime.utcnow(), which is naive-but-UTC. An
    ISO string with no offset is parsed as *local* time by JavaScript, so a run
    made at 14:00 UTC would show as 14:00 in whatever zone the phone is in. The
    trailing Z removes the guesswork.
    """
    if value is None:
        value = datetime.datetime.utcnow()
    if value.tzinfo is not None:
        return value.astimezone(datetime.timezone.utc).replace(tzinfo=None).isoformat() + "Z"
    return value.isoformat() + "Z"


def resolve_sim_profile(db: Session, current_user: User, x_profile: str = None) -> Profile:
    """The profile a Simulate request belongs to.

    Lifted out of simulate_scenario unchanged so the history routes below
    resolve exactly the same row: a founder must get their own runs back, not
    the Individual profile's, and the header is what decides that.
    """
    query = db.query(Profile).filter(Profile.user_id == current_user.id)
    if x_profile and x_profile != "individual":
        query = query.filter(Profile.key == x_profile)
    profile = query.first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    return profile


def save_simulation_run(db: Session, profile: Profile, scenario_text: str, response: ScenarioSimulateResponse) -> str:
    """Store a completed run whole, and return its id.

    Both personas land here, and informational answers are kept too — from the
    user's side they asked something and got an answer back, and finding it
    missing from the list later would read as lost work.

    Persisting must never cost the user the simulation they just waited for, so
    a failure here is rolled back and swallowed: the response still goes out,
    only unsaved.
    """
    run_id = uuid.uuid4().hex
    # Collapses the newlines a multi-line recommendation carries, so the
    # list row stays one line.
    headline = " ".join((response.recommendation or "").split())
    if len(headline) > 160:
        headline = headline[:157].rstrip() + "..."

    # Stamped before the dump so the stored payload identifies itself — a
    # reopened run then carries its own id, exactly as a fresh one does.
    response.run_id = run_id

    try:
        db.add(SimulationRun(
            id=run_id,
            profile_id=profile.id,
            scenario=scenario_text,
            scenario_type=response.scenario_type or "general",
            mode=response.mode or "scenario",
            headline=headline,
            # mode="json" so datetimes/enums anywhere inside the payload are
            # already JSON-native; the column stores it verbatim.
            result=response.model_dump(mode="json"),
        ))
        db.commit()
    except Exception:
        db.rollback()
        response.run_id = None
        return ""
    return run_id


@router.get("/simulations", response_model=List[SimulationRunSummary])
def list_simulations(
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    x_profile: str = Header(default=None),
):
    """This profile's past runs, newest first — what the Simulate tab opens with."""
    profile = resolve_sim_profile(db, current_user, x_profile)
    limit = max(1, min(limit, 200))

    runs = (
        db.query(SimulationRun)
        .filter(SimulationRun.profile_id == profile.id)
        .order_by(SimulationRun.created_at.desc(), SimulationRun.id.desc())
        .limit(limit)
        .all()
    )
    return [
        SimulationRunSummary(
            id=r.id,
            scenario=r.scenario or "",
            scenario_type=r.scenario_type or "general",
            mode=r.mode or "scenario",
            headline=r.headline or "",
            created_at=iso_utc(r.created_at),
        )
        for r in runs
    ]


@router.get("/simulations/{run_id}", response_model=SimulationRunDetail)
def get_simulation(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    x_profile: str = Header(default=None),
):
    """Reopen a stored run.

    `result` is returned as it was computed, not re-simulated — the numbers a
    user acted on should not quietly move when they look at them again.
    """
    profile = resolve_sim_profile(db, current_user, x_profile)
    run = db.query(SimulationRun).filter(
        SimulationRun.id == run_id,
        SimulationRun.profile_id == profile.id,
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Simulation not found")

    return SimulationRunDetail(
        id=run.id,
        scenario=run.scenario or "",
        scenario_type=run.scenario_type or "general",
        mode=run.mode or "scenario",
        headline=run.headline or "",
        created_at=iso_utc(run.created_at),
        result=ScenarioSimulateResponse(**(run.result or {})),
    )


@router.delete("/simulations/{run_id}", response_model=GenericResponse)
def delete_simulation(
    run_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    x_profile: str = Header(default=None),
):
    profile = resolve_sim_profile(db, current_user, x_profile)
    run = db.query(SimulationRun).filter(
        SimulationRun.id == run_id,
        SimulationRun.profile_id == profile.id,
    ).first()
    if not run:
        raise HTTPException(status_code=404, detail="Simulation not found")

    db.delete(run)
    db.commit()
    return {"success": True, "message": "Simulation deleted"}


@router.post("/simulate-scenario", response_model=ScenarioSimulateResponse)
def simulate_scenario(req: ScenarioSimulateRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db), x_profile: str = Header(default=None),
                      allowance: Allowance = Depends(require_allowance("simulations"))):
    profile = resolve_sim_profile(db, current_user, x_profile)

    scenario = (req.scenario or "").strip()
    if not scenario:
        raise HTTPException(status_code=400, detail="Please describe a financial scenario to simulate.")

    if profile.key == "startup":
        if not profile.startup_profile:
            raise HTTPException(status_code=404, detail="Startup profile not found. Please complete Startup onboarding first.")
        response = startup_orchestrator.run_scenario_simulation(profile, scenario)
        log_startup_decision(db, profile, scenario, response)
        save_simulation_run(db, profile, scenario, response)
        allowance.record()
        return response

    # The chat -> Simulation hand-off. A decision context sent inline wins; a
    # bare session_id falls back to whatever that conversation last discovered,
    # which is what lets the CTA still work after a reload or a cold app start.
    # Neither present means a scenario typed straight into the Simulate box, and
    # that takes the original path untouched.
    context = req.decision_context
    if context is None and req.session_id:
        session = db.query(ChatSession).filter(
            ChatSession.id == req.session_id,
            ChatSession.profile_id == profile.id,
        ).first()
        if session:
            context = load_decision_context(db, req.session_id)

    response = orchestrator.run_scenario_simulation(
        profile,
        scenario,
        decision_context=context.model_dump() if context else None,
    )
    
    if profile.key in ["individual", "enterprise"]:
        log_individual_decision(db, profile, scenario, response)

    # Kept for every persona and both modes, so the Simulate tab's history is
    # the complete record of what this profile has explored. The run's id is
    # stamped onto `response` in there, for the client to file it under.
    save_simulation_run(db, profile, scenario, response)
    allowance.record()

    return response


# Voice is served by the Vapi layer (backend/routers/voice.py). The old
# Edge-TTS endpoint that the browser-STT voice mode used was removed with it.

from pydantic import BaseModel

class TranscriptionResponse(BaseModel):
    text: str
    language: Optional[str] = None


# Groq's own limit is 25 MB on the free tier. Rejecting here rather than
# forwarding keeps an oversized upload from costing a round trip, and VARTA
# never legitimately produces anything near this: a spoken question is a few
# seconds of AAC, which is tens of kilobytes.
MAX_SPEECH_BYTES = 25 * 1024 * 1024


@router.post("/stt", response_model=TranscriptionResponse)
async def transcribe_speech(
    file: UploadFile = File(...),
    language: Optional[str] = Form(default=None),
    current_user: User = Depends(get_current_user),
):
    """VARTA's ear: a recording in, a transcript out.

    This is the mobile counterpart to what the browser does for free. The web
    client uses the Web Speech API (twin-app/js/voice.js), which has no
    equivalent in React Native, so the phone records audio and posts it here
    instead. Both clients end up in the same place — a plain string handed to
    POST /twin/chat — which is what keeps VARTA a voice interface on both.

    Deliberately dumb. It does not see the profile, does not touch the
    database, does not start or continue a chat session, and does not know
    what the words mean. The caller sends the transcript through the ordinary
    chat route afterwards, so every financial answer is still Tathya's, still
    grounded, still persisted and still audited exactly as a typed question is.

    Authenticated like every other AI-spending route here (see /twin/tts and
    /hisaab/scan-receipt): transcription costs money, so it is not reachable
    without a credential.
    """
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=400, detail="No audio was uploaded.")
    if len(audio) > MAX_SPEECH_BYTES:
        raise HTTPException(
            status_code=413,
            detail="That recording is too long. Try a shorter question.",
        )

    if not groq_service.available():
        # 503 rather than 500: nothing is broken, the server simply has no
        # transcription key configured. The app shows this verbatim.
        raise HTTPException(
            status_code=503,
            detail="Voice input is not available right now.",
        )

    try:
        result = groq_service.transcribe(
            audio,
            filename=file.filename or "speech.m4a",
            language=language or None,
        )
    except Exception:
        # groq_service has already logged the type and message. Nothing about
        # the audio or the transcript is repeated here.
        raise HTTPException(
            status_code=502,
            detail="Could not understand that recording. Please try again.",
        )

    # An empty transcript is a legitimate outcome, not an error — the user tapped
    # the mic and said nothing, or the room was too loud. The client tells those
    # apart from a failure by the 200 and asks them to try again.
    return TranscriptionResponse(text=result.get("text", ""), language=result.get("language"))
