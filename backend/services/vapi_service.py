"""Vapi voice layer — transport only.

Vapi is ONLY the real-time voice channel: microphone -> STT -> turn-taking ->
TTS. Every personalised or financial answer is produced by the EXISTING
Financial Twin brain (backend.agents.orchestrator / startup_orchestrator /
services.financial_simulator) behind authenticated backend tools.

Nothing in this module calculates finances, reads the database directly, or
duplicates chatbot logic. It builds the assistant configuration, mints/verifies
the short-lived voice-session token that carries the authenticated identity, and
keeps a temporary (in-memory, TTL'd) turn buffer so a call has conversational
context without becoming a second source of truth.

The assistant definition is channel-agnostic on purpose: build_assistant(...,
channel="phone") is the same agent with the same tools, so telephony can be
added later without touching the Financial Twin backend.
"""

import os
import re
import threading
import time
import uuid
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from jose import JWTError, jwt

from backend.core.auth import SECRET_KEY, ALGORITHM

load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# --- Configuration ---------------------------------------------------------
# Only the public key ever reaches the browser. The private key is used solely
# for optional server-side assistant management and never leaves the backend.
VAPI_PUBLIC_KEY = os.getenv("VAPI_PUBLIC_KEY", "")
VAPI_PRIVATE_KEY = os.getenv("VAPI_PRIVATE_KEY", "")

# Optional: a persistent assistant created in the Vapi dashboard. When set, the
# browser starts that assistant by id and the tool server secret stays on Vapi's
# side. When unset, we hand the browser a transient assistant built here.
VAPI_ASSISTANT_ID = os.getenv("VAPI_ASSISTANT_ID", "")

# Public base URL of THIS backend, as reachable from Vapi servers (use an
# ngrok/tunnel URL in local development).
VAPI_SERVER_URL = os.getenv("VAPI_SERVER_URL", "").rstrip("/")
# Shared secret Vapi echoes back as the X-Vapi-Secret header. Only used in
# assistant-id mode, where it never touches the browser.
VAPI_SERVER_SECRET = os.getenv("VAPI_SERVER_SECRET", "")

VAPI_MODEL_PROVIDER = os.getenv("VAPI_MODEL_PROVIDER", "openai")
VAPI_MODEL = os.getenv("VAPI_MODEL", "gpt-4o-mini")
VAPI_VOICE_PROVIDER = os.getenv("VAPI_VOICE_PROVIDER", "vapi")
VAPI_VOICE_ID = os.getenv("VAPI_VOICE_ID", "Neha")
VAPI_TRANSCRIBER_PROVIDER = os.getenv("VAPI_TRANSCRIBER_PROVIDER", "deepgram")
VAPI_TRANSCRIBER_MODEL = os.getenv("VAPI_TRANSCRIBER_MODEL", "nova-2")
VAPI_TRANSCRIBER_LANGUAGE = os.getenv("VAPI_TRANSCRIBER_LANGUAGE", "en")

VOICE_MAX_CALL_SECONDS = int(os.getenv("VOICE_MAX_CALL_SECONDS", "900"))
# Whether an ended call's transcript is written to chat history and
# voice_call_logs. Off unless the deployment opts in, which is the contract
# stated in backend/.env.example and in the routers/voice.py docstring. It was
# briefly hardcoded True, which silently persisted every financial
# conversation on deployments whose .env said false.
VOICE_PERSIST_TRANSCRIPTS = os.getenv("VOICE_PERSIST_TRANSCRIPTS", "").lower() in ("1", "true", "yes")

VOICE_TOKEN_SCOPE = "voice"


def voice_enabled() -> bool:
    return bool(VAPI_PUBLIC_KEY)


def uses_managed_assistant() -> bool:
    """True when a dashboard-managed assistant id is configured."""
    return bool(VAPI_ASSISTANT_ID)


# --- Voice-session token ---------------------------------------------------
# The browser never tells the backend who it is. /voice/session authenticates
# the platform user with the normal bearer token and mints this short-lived,
# scope-limited JWT. Every tool call is authorised from the token signature —
# a client-supplied user_id is never trusted anywhere in this flow.

def mint_voice_token(user_id: int, session_id: str, profile_key: str = "individual") -> str:
    expire = datetime.utcnow() + timedelta(seconds=VOICE_MAX_CALL_SECONDS + 120)
    return jwt.encode(
        {
            "sub": str(user_id),
            "scope": VOICE_TOKEN_SCOPE,
            "vsid": session_id,
            "profile_key": profile_key,
            "exp": expire,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )


def decode_voice_token(token: str) -> Optional[Dict[str, Any]]:
    """Return the claims of a valid voice token, or None. Never raises."""
    if not token:
        return None
    try:
        claims = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None
    if claims.get("scope") != VOICE_TOKEN_SCOPE or not claims.get("sub"):
        return None
    return claims


def new_session_id() -> str:
    return str(uuid.uuid4())


# --- Temporary per-call context -------------------------------------------
# Short-lived, in-process, capped and TTL'd. This exists so a call can say
# "and what about 10,000 instead?" — it is deliberately NOT durable memory.
# The database / RAG remain the only source of truth.

_TURN_TTL_SECONDS = VOICE_MAX_CALL_SECONDS + 300
_MAX_TURNS = 12
_turns: Dict[str, Dict[str, Any]] = {}
_turns_lock = threading.Lock()


def _prune_locked() -> None:
    now = time.time()
    for sid in [s for s, v in _turns.items() if now - v["ts"] > _TURN_TTL_SECONDS]:
        _turns.pop(sid, None)


def get_session_turns(session_id: str) -> List[Dict[str, str]]:
    if not session_id:
        return []
    with _turns_lock:
        _prune_locked()
        entry = _turns.get(session_id)
        return list(entry["turns"]) if entry else []


def append_session_turns(session_id: str, user_text: str, assistant_text: str) -> None:
    if not session_id:
        return
    with _turns_lock:
        _prune_locked()
        entry = _turns.setdefault(session_id, {"turns": [], "ts": time.time()})
        entry["turns"].append({"role": "user", "content": user_text})
        entry["turns"].append({"role": "assistant", "content": assistant_text})
        entry["turns"] = entry["turns"][-_MAX_TURNS:]
        entry["ts"] = time.time()


def clear_session_turns(session_id: str) -> None:
    with _turns_lock:
        _turns.pop(session_id, None)


# --- Speech shaping --------------------------------------------------------
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]+\)")
_MD_CHARS = re.compile(r"[*_#>]+|`")
_BULLET = re.compile(r"^\s*[-•]\s*", re.MULTILINE)
_CURRENCY = re.compile(r"₹\s?([\d,]+(?:\.\d+)?)\s*(cr|crore|lakh|l|k)?", re.IGNORECASE)
_WS = re.compile(r"\s+")

_UNIT_WORDS = {"cr": "crore", "crore": "crore", "lakh": "lakh", "l": "lakh", "k": "thousand"}


def to_speech(text: str, max_chars: int = 1100) -> str:
    """Make an existing backend answer comfortable to hear.

    Formatting only — no number is changed, added or removed.
    """
    if not text:
        return ""
    out = _MD_LINK.sub(r"\1", str(text))
    out = _MD_CHARS.sub("", out)
    out = _BULLET.sub("", out)

    def _money(m):
        unit = _UNIT_WORDS.get((m.group(2) or "").lower(), "")
        return " ".join(p for p in (m.group(1), unit, "rupees") if p)

    out = _CURRENCY.sub(_money, out)
    out = _WS.sub(" ", out).strip()
    if len(out) > max_chars:
        cut = out[:max_chars]
        stop = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        out = (cut[: stop + 1] if stop > max_chars * 0.5 else cut).strip()
    return out


# --- Assistant definition --------------------------------------------------
SYSTEM_PROMPT = """You are the voice of MoneyKal, the Agentic Financial Decision Twin. \
You are speaking with {name} on a live voice call.

WHAT YOU ARE
You are a voice interface, not a financial engine. The Financial Twin backend holds this real \
profile, transactions, simulations and market intelligence. Your job is to listen, call the right \
backend tool, and speak the result back naturally.

HARD RULES
- NEVER invent, estimate, recalculate or round a personal figure. Any number about this money — \
income, expenses, savings, runway, goals, projections, "what if I invest X" outcomes — must come \
from a tool result in this conversation. If you do not have it, call the tool.
- If a tool fails or returns nothing usable, say you could not reach the financial data right now \
and offer to try again. Never fill the gap with a plausible-sounding number.
- Do not present regulated advice as fact; the backend already frames its recommendations. \
General financial education with no personal figures is fine to answer directly.

WHICH TOOL
- get_financial_snapshot: quick current-state facts (income, expenses, savings, surplus, \
emergency buffer, goal progress).
- simulate_financial_scenario: any hypothetical or forward-looking question — "what if I invest \
7000 a month", "can I afford a 40 lakh home loan", "should I switch jobs".
- ask_financial_twin: everything else about these finances, this data, markets, or explanations \
grounded in this situation.

HOW TO SPEAK
- Natural spoken Indian English. Short sentences. Two to four sentences per turn unless asked for \
detail, then offer to go deeper.
- Speak numbers the way a person would: "seven thousand rupees a month", "about four point two \
lakh". Never read out markdown, bullet points, URLs or JSON.
- Before a tool call that may take a moment, say a short natural filler like "let me check that".
- Let the user interrupt you. If they cut in, stop and listen.
"""

FIRST_MESSAGE = "Hi {name}, it's your financial twin. What would you like to think through today?"


def _tool(name: str, description: str, properties: Dict[str, Any], required: List[str],
          server: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
        "server": server,
        "async": False,
    }


def build_tools(voice_token: str) -> List[Dict[str, Any]]:
    """The three authenticated doors into the existing backend.

    Each tool is served by POST /voice/tool, which re-authenticates the user
    from the signed voice token before touching any profile data.
    """
    server: Dict[str, Any] = {"url": f"{VAPI_SERVER_URL}/voice/tool", "timeoutSeconds": 45}
    if uses_managed_assistant():
        # Secret lives on Vapi, not in the browser.
        if VAPI_SERVER_SECRET:
            server["secret"] = VAPI_SERVER_SECRET
    else:
        # Transient assistant: identity travels in a header, and in the URL as a
        # fallback since some transports drop custom headers. The token only
        # ever grants access to the very user who requested it.
        server["headers"] = {"X-Voice-Token": voice_token}
        server["url"] = f"{server['url']}?vs={voice_token}"

    return [
        _tool(
            "get_financial_snapshot",
            "Get the current real financial position from the Financial Twin backend: "
            "monthly income, expenses, surplus, total savings, emergency buffer in months and "
            "goal progress. Use for any question about where things stand right now.",
            {},
            [],
            server,
        ),
        _tool(
            "simulate_financial_scenario",
            "Run a hypothetical through the existing Financial Twin simulation engine — "
            "investing a monthly amount, taking a loan or EMI, a big purchase, a salary change, "
            "a runway or affordability question. Returns the real calculated outcome, timeline "
            "and recommendation for THIS user.",
            {
                "scenario": {
                    "type": "string",
                    "description": "The scenario in the speaker's own words, e.g. 'what happens "
                                   "if I invest 7000 rupees per month for 5 years'.",
                }
            },
            ["scenario"],
            server,
        ),
        _tool(
            "ask_financial_twin",
            "Ask the Financial Twin chatbot anything else about these finances, this data, "
            "markets, or an explanation grounded in this profile. Same brain as the website text "
            "chat.",
            {
                "question": {
                    "type": "string",
                    "description": "The question, rephrased into a complete sentence.",
                }
            },
            ["question"],
            server,
        ),
    ]


def build_assistant(display_name: str, voice_token: str, session_id: str,
                    channel: str = "web") -> Dict[str, Any]:
    """Transient assistant definition.

    channel is carried in metadata only — the agent, prompt and tools are
    identical for web and (future) telephony, so a phone number can be pointed
    at this same definition later with no backend change.
    """
    name = display_name or "there"
    assistant: Dict[str, Any] = {
        "name": "MoneyKal Financial Twin",
        "firstMessage": FIRST_MESSAGE.format(name=name),
        "firstMessageMode": "assistant-speaks-first",
        "model": {
            "provider": VAPI_MODEL_PROVIDER,
            "model": VAPI_MODEL,
            "temperature": 0.3,
            "messages": [{"role": "system", "content": SYSTEM_PROMPT.format(name=name)}],
            "tools": build_tools(voice_token),
        },
        "voice": {"provider": VAPI_VOICE_PROVIDER, "voiceId": VAPI_VOICE_ID},
        "transcriber": {
            "provider": VAPI_TRANSCRIBER_PROVIDER,
            "model": VAPI_TRANSCRIBER_MODEL,
            "language": VAPI_TRANSCRIBER_LANGUAGE,
        },
        # Barge-in: the user can cut the assistant off mid-sentence.
        "stopSpeakingPlan": {"numWords": 2, "voiceSeconds": 0.2, "backoffSeconds": 1.0},
        "startSpeakingPlan": {"waitSeconds": 0.4},
        "backgroundDenoisingEnabled": True,
        "silenceTimeoutSeconds": 30,
        "maxDurationSeconds": VOICE_MAX_CALL_SECONDS,
        "metadata": {"voice_session_id": session_id, "channel": channel, "voice_token": voice_token},
        "endCallMessage": "Talk soon.",
    }
    if VAPI_SERVER_URL:
        assistant["server"] = {"url": f"{VAPI_SERVER_URL}/voice/webhook"}
        assistant["serverMessages"] = ["end-of-call-report"]
        if uses_managed_assistant() and VAPI_SERVER_SECRET:
            assistant["server"]["secret"] = VAPI_SERVER_SECRET
    return assistant


def build_assistant_overrides(display_name: str, voice_token: str, session_id: str,
                              channel: str = "web") -> Dict[str, Any]:
    """Overrides for assistant-id mode: identity and personalisation only.

    The prompt, tools and tool-server secret stay on the managed assistant, so
    nothing sensitive is handed to the browser.
    """
    return {
        "variableValues": {
            "name": display_name or "there",
            "voiceToken": voice_token,
            "voiceSessionId": session_id,
        },
        "metadata": {
            "voice_token": voice_token,
            "voice_session_id": session_id,
            "channel": channel,
        },
    }
