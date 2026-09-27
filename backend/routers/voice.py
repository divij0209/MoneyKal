"""Voice (Vapi) router.

Three endpoints, no financial logic:

  POST /voice/session   Authenticated browser asks for a call configuration.
                        Mints the short-lived, user-scoped voice token.
  POST /voice/tool      Vapi calls this when the assistant needs real data.
                        Re-authenticates the user from the signed token, then
                        delegates to the EXISTING Financial Twin brain.
  POST /voice/webhook   End-of-call report. Clears the temporary call context;
                        stores nothing unless VOICE_PERSIST_TRANSCRIPTS=true.

The Vapi assistant never touches the database. It can only reach user data
through /voice/tool, which authorises every single call independently.
"""

import json
import logging
from typing import Any, Dict, List, Tuple, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.core.access import Allowance, require_allowance
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import ChatMessage, ChatSession, Profile, User
from backend.services import vapi_service as vapi
from backend.services.financial_simulator import build_financial_context

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/voice", tags=["Voice"])

# User-facing copy. Internal detail never reaches the caller or the speaker.
ERR_UNAVAILABLE = "I could not reach your financial data just now. Want me to try again?"
ERR_NO_PROFILE = ("I could not find your financial profile yet. Finish onboarding on the website "
                  "and I will have your numbers here.")


# --------------------------------------------------------------------------
# 1. Session handshake (normal platform auth)
# --------------------------------------------------------------------------

@router.get("/status")
def voice_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Lets the UI reflect what is actually available before the user clicks.

    Two independent providers: `enabled` is the in-browser Varta session (Vapi),
    `calling_enabled` is the outbound phone call (Omnidim). `has_phone` lets the
    button explain that a number is missing rather than failing on click.
    """
    from backend.services import omnidim_service
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    phone = (profile.whatsapp_phone if profile else None) or ""
    return {
        "enabled": vapi.voice_enabled(),
        "calling_enabled": omnidim_service.omnidim_enabled(),
        "has_phone": bool(str(phone).strip()),
    }


class OmnidimCallRequest(BaseModel):
    """Body of POST /voice/omnidim/call.

    These were declared as bare `str` arguments, which FastAPI reads as query
    parameters. js/api.js has always sent them as a JSON body, so every call
    arrived with phone=None and the default reason, and the caller's real
    number and reason were silently dropped.
    """
    # Accepted for backward compatibility with js/api.js and then IGNORED.
    # The destination is always the caller's own saved number; honouring a
    # client-supplied one would let anyone have another person's financial
    # summary read out to a number they chose.
    phone: Optional[str] = None
    reason: Optional[str] = None


@router.post("/omnidim/call")
def trigger_omnidim_call(payload: Optional[OmnidimCallRequest] = None,
                         current_user: User = Depends(get_current_user),
                         db: Session = Depends(get_db),
                         # An outbound call bills real money per dispatch, so it
                         # spends the same allowance as Tathya and Varta rather
                         # than being free and unlimited for every SEE user.
                         allowance: Allowance = Depends(require_allowance("ask_twin"))):
    """Trigger an outbound AI call to the user's phone via Omnidim AI with full dashboard context."""
    from backend.services import omnidim_service
    from backend.models.domain import StartupTransaction, UpcomingPayment

    # Refuse before doing any work if the provider is not set up, so the user
    # gets "voice calling is not configured" rather than a generic failure.
    if not omnidim_service.omnidim_enabled():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "voice_not_configured",
                "message": "Phone calling is not switched on for this deployment yet.",
            },
        )

    payload = payload or OmnidimCallRequest()
    reason = (payload.reason or "").strip() or "urgent financial update"

    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()

    # The destination is the caller's OWN number and nothing else. There is
    # deliberately no ALERT_PHONE_NUMBER fallback here: the assistant reads
    # this user's balances, transactions and upcoming bills aloud, so calling
    # any shared or default number would speak one user's finances to whoever
    # picked up. A caller-supplied number is not accepted either — that would
    # let any logged-in user dictate a destination for their own data.
    target_phone = profile.whatsapp_phone if profile else None
    if not target_phone or not str(target_phone).strip():
        raise HTTPException(
            status_code=400,
            detail={
                "error": "no_phone_number",
                "message": "Add a phone number to your profile and I will call you there.",
            },
        )
        
    user_name = (getattr(current_user, "username", "") or "").split("@")[0].split(".")[0].title() or "User"

    ctx_data = {}
    if profile:
        summary_text = _snapshot_text(profile, db=db)
        ctx_data["financial_summary"] = summary_text

        txns = db.query(StartupTransaction).filter(StartupTransaction.profile_id == profile.id).order_by(StartupTransaction.txn_date.desc()).limit(10).all()
        if txns:
            cur = profile.currency or "₹"
            ctx_data["recent_transactions"] = "; ".join([f"{t.txn_date}: {t.type.upper()} {cur}{t.amount:,.0f} for {t.description} ({t.category})" for t in txns])
        
        upcoming = db.query(UpcomingPayment).filter(UpcomingPayment.profile_id == profile.id, UpcomingPayment.is_active == True).order_by(UpcomingPayment.due_date).limit(5).all()
        if upcoming:
            cur = profile.currency or "₹"
            ctx_data["upcoming_bills"] = "; ".join([f"{u.name} {cur}{u.amount:,.0f} due {u.due_date}" for u in upcoming])

    res = omnidim_service.trigger_outbound_call(
        to_phone=target_phone, user_name=user_name, alert_reason=reason,
        custom_context=ctx_data, profile_id=profile.id if profile else None)
    # Only a dispatched call spends the allowance; a provider failure is free.
    if isinstance(res, dict) and res.get("success"):
        allowance.record()
    return res





@router.post("/session")
def create_voice_session(current_user: User = Depends(get_current_user),
                         db: Session = Depends(get_db),
                         # Varta shares Tathya's free allowance; one call is one question.
                         allowance: Allowance = Depends(require_allowance("ask_twin"))):
    if not vapi.voice_enabled():
        raise HTTPException(status_code=503, detail="Voice mode is not configured.")
    if not vapi.VAPI_SERVER_URL:
        raise HTTPException(
            status_code=503,
            detail="Voice mode is not fully configured. Please try again later.",
        )

    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    session_id = vapi.new_session_id()
    token = vapi.mint_voice_token(current_user.id, session_id, profile.key or "individual")
    display_name = (getattr(current_user, "username", "") or "").split("@")[0].split(".")[0].title()

    payload: Dict[str, Any] = {
        "public_key": vapi.VAPI_PUBLIC_KEY,
        "session_id": session_id,
        "max_duration_seconds": vapi.VOICE_MAX_CALL_SECONDS,
    }
    if vapi.uses_managed_assistant():
        payload["assistant_id"] = vapi.VAPI_ASSISTANT_ID
        payload["assistant_overrides"] = vapi.build_assistant_overrides(
            display_name, token, session_id
        )
    else:
        payload["assistant"] = vapi.build_assistant(display_name, token, session_id)
    allowance.record()
    return payload


# --------------------------------------------------------------------------
# 2. Tool endpoint — the only door from Vapi into the Financial Twin
# --------------------------------------------------------------------------

def _extract_token(request: Request, message: Dict[str, Any]) -> str:
    """Header first, then URL fallback, then call metadata (assistant-id mode)."""
    token = request.headers.get("x-voice-token") or ""
    if not token:
        token = request.query_params.get("vs") or ""
    if not token:
        call = message.get("call") or {}
        for holder in (call.get("metadata"), call.get("assistantOverrides", {}).get("metadata"),
                       (call.get("assistant") or {}).get("metadata")):
            if isinstance(holder, dict) and holder.get("voice_token"):
                token = holder["voice_token"]
                break
    return token


def _authorize(request: Request, message: Dict[str, Any], db: Session
               ) -> Tuple[User, Profile, str]:
    """Independent authentication + authorisation for every tool call.

    A user_id in the request body is never trusted; identity comes only from
    the signature on the voice token we minted for an authenticated session.
    """
    if vapi.uses_managed_assistant() and vapi.VAPI_SERVER_SECRET:
        if request.headers.get("x-vapi-secret") != vapi.VAPI_SERVER_SECRET:
            raise HTTPException(status_code=401, detail="Unauthorized")

    claims = vapi.decode_voice_token(_extract_token(request, message))
    if not claims:
        raise HTTPException(status_code=401, detail="Unauthorized")

    user = db.query(User).filter(User.id == int(claims["sub"])).first()
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized")

    query = db.query(Profile).filter(Profile.user_id == user.id)
    profile_key = claims.get("profile_key")
    if profile_key and profile_key != "individual":
        query = query.filter(Profile.key == profile_key)
    profile = query.first()
    if not profile:
        profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    return user, profile, claims.get("vsid") or ""


def _tool_calls(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Vapi has shipped both `toolCallList` and `toolCalls`; accept either."""
    raw = message.get("toolCallList") or message.get("toolCalls") or []
    calls = []
    for c in raw:
        fn = c.get("function") or {}
        args = fn.get("arguments")
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except (ValueError, TypeError):
                args = {}
        calls.append({"id": c.get("id") or c.get("toolCallId") or "",
                      "name": fn.get("name") or c.get("name") or "",
                      "args": args if isinstance(args, dict) else {}})
    return calls


def _snapshot_text(profile: Profile, db: Optional[Session] = None) -> str:
    """Existing grounding step (financial_simulator) plus recent transactions and bills."""
    ctx = build_financial_context(profile)
    cur = ctx.currency or "₹"
    parts = [
        f"Monthly income {cur}{ctx.income:,.0f}",
        f"monthly expenses {cur}{ctx.expenses:,.0f}",
        f"monthly surplus {cur}{ctx.surplus:,.0f}",
        f"total savings {cur}{ctx.savings:,.0f}",
    ]
    if ctx.loans:
        parts.append(f"loans/debt {cur}{ctx.loans:,.0f}")
    if ctx.buffer_months is not None:
        parts.append(f"emergency buffer {ctx.buffer_months:.1f} months of expenses")
    if ctx.goal_title:
        goal = f"goal '{ctx.goal_title}'"
        if ctx.goal_target:
            goal += f" target {cur}{ctx.goal_target:,.0f}"
        if ctx.goal_progress_pct is not None:
            goal += f", {ctx.goal_progress_pct:.0f} percent complete"
        parts.append(goal)

    if db:
        from backend.models.domain import StartupTransaction, UpcomingPayment
        txns = db.query(StartupTransaction).filter(StartupTransaction.profile_id == profile.id).order_by(StartupTransaction.txn_date.desc()).limit(5).all()
        if txns:
            txn_strs = [f"{t.txn_date}: {t.type.upper()} {cur}{t.amount:,.0f} for {t.description} ({t.category})" for t in txns]
            parts.append("Recent Transactions: " + "; ".join(txn_strs))
        
        upcoming = db.query(UpcomingPayment).filter(UpcomingPayment.profile_id == profile.id, UpcomingPayment.is_active == True).order_by(UpcomingPayment.due_date).limit(5).all()
        if upcoming:
            up_strs = [f"{u.name} {cur}{u.amount:,.0f} due {u.due_date}" for u in upcoming]
            parts.append("Upcoming Bills: " + "; ".join(up_strs))

    return ("Verified figures from the Financial Twin database: " + "; ".join(parts) +
            ". Speak only these numbers.")


def _scenario_text(result: Any) -> str:
    """Flatten the existing ScenarioSimulateResponse into speakable facts."""
    impact = result.financial_impact or {}
    lines = [f"Calculated result for: {result.scenario}."]
    if impact:
        readable = "; ".join(
            f"{k.replace('_', ' ')}: {v:,.0f}" if isinstance(v, (int, float)) else
            f"{k.replace('_', ' ')}: {v}"
            for k, v in impact.items() if v is not None
        )
        lines.append(f"Numbers: {readable}.")
    timeline = result.timeline or []
    if timeline:
        last = timeline[-1]
        lines.append("Final timeline point: " + ", ".join(
            f"{k}: {v}" for k, v in last.items() if v is not None))
    if result.recommendation:
        lines.append(f"Recommendation: {result.recommendation}")
    if result.why:
        lines.append(f"Why: {result.why}")
    if result.risks:
        lines.append("Risks: " + "; ".join(result.risks[:3]))
    return vapi.to_speech(" ".join(lines), max_chars=1500)


def _run_tool(name: str, args: Dict[str, Any], profile: Profile, session_id: str,
              db: Session) -> str:
    """Delegate to the existing Financial Twin brain. No logic is re-implemented."""
    # Imported here so a voice request never changes app start-up ordering.
    from backend.agents.orchestrator import orchestrator
    from backend.agents.startup_orchestrator import startup_orchestrator

    active = startup_orchestrator if profile.key == "startup" else orchestrator

    if name == "get_financial_snapshot":
        return _snapshot_text(profile, db=db)

    if name == "simulate_financial_scenario":
        scenario = (args.get("scenario") or "").strip()
        if not scenario:
            return "No scenario was provided. Ask what they would like to simulate."
        # Exactly the entry point POST /twin/simulate-scenario uses.
        result = active.run_scenario_simulation(profile, scenario)
        spoken = _scenario_text(result)
        vapi.append_session_turns(session_id, scenario, spoken)
        return spoken

    if name == "ask_financial_twin":
        question = (args.get("question") or "").strip()
        if not question:
            return "No question was provided. Ask what they would like to know."
        # The same agents and the same grounding POST /twin/chat uses, but
        # entered one level lower, and deliberately so on two counts.
        #
        # The turn buffer here is temporary rather than a stored chat, and the
        # Financial Discovery layer (services/discovery_flow.py) keys its
        # per-conversation memory on a chat_sessions row — which a Vapi call
        # does not have. Without that memory it could not guarantee it wasn't
        # repeating a question, which is the one thing a spoken interface must
        # never do. A caller on the phone also wants an answer rather than a
        # clarifying exchange, so a turn here is always answered directly.
        #
        # Voice in the app is unaffected: it transcribes via POST /twin/stt and
        # then posts the text to POST /twin/chat like any typed question, so it
        # gets the full discovery flow.
        history = vapi.get_session_turns(session_id)
        response = active.process_query(profile, question, chat_history=history, db=db)
        spoken = vapi.to_speech(response.answer)
        vapi.append_session_turns(session_id, question, spoken)
        return spoken

    return "That capability is not available on voice yet."


@router.post("/tool")
async def voice_tool(request: Request, db: Session = Depends(get_db)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request")

    message = body.get("message") or body
    user, profile, session_id = _authorize(request, message, db)

    calls = _tool_calls(message)
    if not calls:
        raise HTTPException(status_code=400, detail="Invalid request")

    results = []
    for call in calls:
        try:
            output = _run_tool(call["name"], call["args"], profile, session_id, db)
        except HTTPException:
            raise
        except Exception:
            logger.exception("Voice tool %s failed for user %s", call["name"], user.id)
            output = ERR_UNAVAILABLE
        results.append({"toolCallId": call["id"], "result": output})

    return {"results": results}


# --------------------------------------------------------------------------
# 3. End-of-call report
# --------------------------------------------------------------------------

def _persist_transcript(db: Session, profile: Profile, messages: List[Dict[str, Any]]) -> None:
    """Opt-in only (VOICE_PERSIST_TRANSCRIPTS). Voice is not durable memory."""
    turns = [m for m in messages if m.get("role") in ("user", "bot", "assistant") and m.get("message")]
    if not turns:
        return
    session = ChatSession(id=vapi.new_session_id(), profile_id=profile.id, title="Voice conversation")
    db.add(session)
    db.commit()
    for m in turns:
        db.add(ChatMessage(
            session_id=session.id,
            role="user" if m["role"] == "user" else "twin",
            content=str(m["message"])[:4000],
        ))
    db.commit()


@router.post("/webhook")
async def voice_webhook(request: Request, db: Session = Depends(get_db)):
    if vapi.VAPI_SERVER_SECRET and request.headers.get("x-vapi-secret") != vapi.VAPI_SERVER_SECRET:
        # Transient-assistant mode does not ship a secret to the browser, so the
        # header is only enforced when one is configured.
        if vapi.uses_managed_assistant():
            raise HTTPException(status_code=401, detail="Unauthorized")

    try:
        body = await request.json()
    except Exception:
        return {"status": "ignored"}

    message = body.get("message") or {}
    if message.get("type") != "end-of-call-report":
        return {"status": "ignored"}

    call = message.get("call") or {}
    metadata = call.get("metadata") or (call.get("assistant") or {}).get("metadata") or {}
    session_id = metadata.get("voice_session_id") or ""

    if vapi.VOICE_PERSIST_TRANSCRIPTS:
        claims = vapi.decode_voice_token(metadata.get("voice_token") or "")
        if claims:
            profile = db.query(Profile).filter(Profile.user_id == int(claims["sub"])).first()
            if profile:
                try:
                    _persist_transcript(db, profile, message.get("messages") or [])
                except Exception:
                    logger.exception("Failed to persist voice transcript")

    # Persist structured VoiceCallLog
    try:
        from backend.models.domain import VoiceCallLog
        profile_id = None
        claims = vapi.decode_voice_token(metadata.get("voice_token") or "")
        if claims:
            prof = db.query(Profile).filter(Profile.user_id == int(claims["sub"])).first()
            if prof:
                profile_id = prof.id

        duration = int(message.get("duration") or message.get("durationSeconds") or call.get("duration") or 0)
        summary = message.get("summary") or (message.get("analysis") or {}).get("summary") or ""
        messages_list = message.get("messages") or []
        ended_reason = message.get("endedReason") or call.get("endedReason") or "normal"

        call_log = VoiceCallLog(
            profile_id=profile_id,
            provider="vapi",
            session_id=session_id,
            call_type="inbound",
            status="completed",
            duration_seconds=duration,
            summary=summary,
            transcript=messages_list,
            ended_reason=ended_reason
        )
        db.add(call_log)
        db.commit()
        logger.info("Saved VoiceCallLog to database for session=%s", session_id)
    except Exception as e:
        logger.exception("Failed to save VoiceCallLog: %s", e)

    vapi.clear_session_turns(session_id)
    logger.info("Voice call ended (session=%s, reason=%s)", session_id,
                message.get("endedReason"))
    return {"status": "ok"}


@router.get("/logs")
def get_voice_logs(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Fetch all voice call logs for the logged-in user."""
    from backend.models.domain import VoiceCallLog
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        return []
    logs = db.query(VoiceCallLog).filter(VoiceCallLog.profile_id == profile.id).order_by(VoiceCallLog.created_at.desc()).all()
    return [
        {
            "id": l.id,
            "provider": l.provider,
            "session_id": l.session_id,
            "call_type": l.call_type,
            "phone_number": l.phone_number,
            "status": l.status,
            "duration_seconds": l.duration_seconds,
            "summary": l.summary,
            "transcript": l.transcript,
            "ended_reason": l.ended_reason,
            "created_at": l.created_at.isoformat() if l.created_at else None
        }
        for l in logs
    ]

