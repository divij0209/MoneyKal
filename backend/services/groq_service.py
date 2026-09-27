"""
Centralized Groq access point. Two callers, both narrow:

  - generate()/generate_json() — the Tathya chatbot's agent pipeline
    (backend/agents/sub_agents.py's Agent.process(), i.e. the
    Data/Risk/Compliance/Explainer chain behind every Ask Twin / Tathya chat
    reply, reached via POST /twin/chat).
  - transcribe() — VARTA's speech-to-text, reached via POST /twin/stt.

Note what the second one is not. Transcription turns a recording into a
string and stops there; the string is then sent through the ordinary
POST /twin/chat path, so Tathya remains the only thing in this system that
reasons about money. VARTA is the microphone and the speaker, nothing more.

Every other AI call in the backend (Simulation's Recommend/Teach stages,
onboarding extraction, market-sentiment tagging) still goes through
backend/services/gemini_service.py — this file intentionally mirrors that
module's public shape (available()/generate()/generate_json()) so the two
providers are interchangeable from a caller's point of view, but it does not
replace or touch anything Gemini-related.
"""
import os
import re
import json
import time
import logging
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

logger = logging.getLogger(__name__)

GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

# Speech-to-text for VARTA (POST /twin/stt). Separate from GROQ_MODEL because
# it names an audio model, not a chat one, and the two are swapped for
# different reasons. Whisper large v3 *turbo* is the default: it is the
# cheapest and fastest of the Whisper variants Groq hosts, and a spoken
# question to VARTA is short, so the accuracy gap over the full model does
# not justify the extra latency in a turn the user is waiting through.
GROQ_STT_MODEL = os.getenv("GROQ_STT_MODEL", "whisper-large-v3-turbo")


def _is_rate_limit_error(e: Exception) -> bool:
    """Best-effort detection of rate-limit/quota errors across whatever shape
    the SDK raises (HTTP status code, error code string, or message text)."""
    status = getattr(e, "status_code", None) or getattr(e, "code", None)
    if status == 429:
        return True
    err_str = str(e)
    return "429" in err_str or "rate limit" in err_str.lower() or "rate_limit" in err_str.lower()


def _build_client():
    """Lazily construct the Groq client. Returns None if no key is configured
    or the SDK can't be initialized, so callers can fall back gracefully
    instead of crashing (mirrors gemini_service's optional-client behaviour)."""
    key = os.getenv("GROQ_API_KEY")
    if not key:
        return None
    try:
        from groq import Groq
        return Groq(api_key=key)
    except Exception as e:
        logger.error(f"Failed to initialize Groq client: {type(e).__name__}")
        return None


class GroqService:
    """Thin wrapper around the Groq SDK used for the Tathya chatbot's
    generation calls. Same generate()/generate_json()/available() interface
    as GeminiService so it's a drop-in for the callers that use it."""

    def __init__(self):
        self._client = None
        self._init_attempted = False

    @property
    def client(self):
        if not self._init_attempted:
            self._client = _build_client()
            self._init_attempted = True
        return self._client

    def available(self) -> bool:
        return self.client is not None

    def generate(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
        json_mode: bool = False,
        temperature: float = 0.4,
        max_output_tokens: int = 2048,
    ) -> str:
        """Generate text (or a JSON string, if json_mode=True). Raises on
        failure so callers can decide how to fall back — never invents a
        response silently."""
        if not self.client:
            raise RuntimeError("Groq client not configured (GROQ_API_KEY missing)")

        messages: List[Dict[str, str]] = []
        if system_instruction:
            messages.append({"role": "system", "content": system_instruction})
        if chat_history:
            for msg in chat_history[-8:]:
                role = "assistant" if msg.get("role") in ("assistant", "twin", "model") else "user"
                text = msg.get("content", "")
                if text:
                    messages.append({"role": role, "content": text})
        messages.append({"role": "user", "content": prompt})

        kwargs: Dict[str, Any] = {
            "model": GROQ_MODEL,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_output_tokens,
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        # Retry on rate-limit errors with a short backoff — mirrors
        # gemini_service.generate()'s resilience so the chatbot degrades the
        # same way regardless of which provider is behind it.
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                response = self.client.chat.completions.create(**kwargs)
                text = response.choices[0].message.content
                if text is None:
                    raise RuntimeError("Groq returned an empty response")
                return text
            except Exception as e:
                # Log only the error type/message — never the prompt or context,
                # which may contain the user's financial data.
                logger.error(f"Groq generation failed ({GROQ_MODEL}), attempt {attempt + 1}/{max_attempts}: {type(e).__name__}: {e}")
                if _is_rate_limit_error(e) and attempt < max_attempts - 1:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise

    def generate_json(
        self,
        prompt: str,
        system_instruction: Optional[str] = None,
        temperature: float = 0.2,
        max_output_tokens: int = 2048,
    ) -> Optional[Dict[str, Any]]:
        """Generate and parse a JSON object. Returns None on failure instead
        of raising, since JSON-mode callers usually have a deterministic
        fallback path."""
        try:
            text = self.generate(
                prompt,
                system_instruction=system_instruction,
                json_mode=True,
                temperature=temperature,
                max_output_tokens=max_output_tokens,
            )
        except Exception:
            return None

        try:
            return json.loads(text)
        except Exception:
            match = re.search(r'\{[\s\S]*\}', text)
            if match:
                try:
                    return json.loads(match.group(0))
                except Exception:
                    return None
        return None

    def transcribe(
        self,
        audio: bytes,
        filename: str = "speech.m4a",
        language: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Turn spoken audio into text. Returns {"text": str, "language": str|None}.

        This is VARTA's ear, and it is deliberately the *only* thing VARTA is
        allowed to do with a recording: the text it produces goes straight to
        POST /twin/chat, which is where every financial judgement is made. No
        prompt, no profile and no financial context is passed here — Whisper is
        a transcriber, not a participant in the conversation.

        It lives in this module for the same reason generate() does: one file
        owns the Groq client, the key and the retry policy.

        Raises on failure rather than returning empty text, so the caller can
        tell "the service is down" apart from "the user said nothing" — those
        need different answers on screen.
        """
        if not self.client:
            raise RuntimeError("Groq client not configured (GROQ_API_KEY missing)")
        if not audio:
            raise ValueError("No audio to transcribe")

        kwargs: Dict[str, Any] = {
            # The SDK accepts the (name, bytes) tuple form. The name matters:
            # Groq picks the decoder from the extension, so a wrong suffix
            # fails on a file that is otherwise perfectly readable.
            "file": (filename, audio),
            "model": GROQ_STT_MODEL,
            # Gives back the detected language alongside the text. The client
            # shows nothing with it today; it is logged-free plumbing for the
            # multilingual VARTA that Hinglish support would need.
            "response_format": "verbose_json",
            # Whisper hallucinates fluent nonsense on silence when it is free to
            # sample. Pinning to 0 makes an empty recording come back empty.
            "temperature": 0.0,
        }
        if language:
            kwargs["language"] = language

        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                result = self.client.audio.transcriptions.create(**kwargs)
                break
            except Exception as e:
                # Never log the audio or the transcript — it is the user
                # speaking about their own money.
                logger.error(
                    f"Groq transcription failed ({GROQ_STT_MODEL}), "
                    f"attempt {attempt + 1}/{max_attempts}: {type(e).__name__}: {e}"
                )
                if _is_rate_limit_error(e) and attempt < max_attempts - 1:
                    time.sleep(2 * (attempt + 1))
                    continue
                raise

        # The SDK returns a model object, but has returned a plain dict across
        # versions. Read both shapes rather than pinning to one.
        if isinstance(result, dict):
            text = result.get("text") or ""
            detected = result.get("language")
        else:
            text = getattr(result, "text", "") or ""
            detected = getattr(result, "language", None)

        return {"text": text.strip(), "language": detected}



# Singleton used by the Tathya chatbot pipeline (backend/agents/sub_agents.py)
# and by VARTA's transcription route (backend/routers/twin.py) — the one place
# in the backend that talks to Groq.
groq_service = GroqService()
