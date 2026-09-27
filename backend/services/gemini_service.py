"""
Centralized Gemini access point.

Every LLM/RAG/agent-generation call in the backend (Ask Twin's agent
pipeline, Simulation's Recommend/Teach stages, onboarding extraction,
market-sentiment tagging) goes through this module instead of calling a
provider SDK directly. That keeps the API key server-side only, keeps
generation parameters consistent, and makes a future provider swap a
one-file change.
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

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")


def _is_rate_limit_error(e: Exception) -> bool:
    """Best-effort detection of rate-limit/quota errors across whatever shape
    the SDK raises (HTTP status code, error code string, or message text)."""
    status = getattr(e, "status_code", None) or getattr(e, "code", None)
    if status == 429:
        return True
    err_str = str(e)
    return "429" in err_str or "RESOURCE_EXHAUSTED" in err_str or "rate limit" in err_str.lower()


def _build_client():
    """Lazily construct the Gemini client. Returns None if no key is configured
    or the SDK can't be initialized, so callers can fall back gracefully
    instead of crashing (mirrors the previous Groq-optional behaviour)."""
    key = os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    try:
        from google import genai
        return genai.Client(api_key=key)
    except Exception as e:
        logger.error(f"Failed to initialize Gemini client: {type(e).__name__}")
        return None


class GeminiService:
    """Thin wrapper around the Gemini SDK used for every generation task."""

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
        max_output_tokens: int = 512,
        image_bytes: Optional[bytes] = None,
        mime_type: Optional[str] = None,
    ) -> str:
        """Generate text (or a JSON string, if json_mode=True). Raises on
        failure so callers can decide how to fall back — never invents a
        response silently."""
        if not self.client:
            raise RuntimeError("Gemini client not configured (GEMINI_API_KEY missing)")

        from google.genai import types

        contents = []
        if chat_history:
            for msg in chat_history[-8:]:
                role = "model" if msg.get("role") in ("assistant", "twin", "model") else "user"
                text = msg.get("content", "")
                if text:
                    contents.append(types.Content(role=role, parts=[types.Part(text=text)]))
        parts = []
        if image_bytes and mime_type:
            parts.append(types.Part.from_bytes(data=image_bytes, mime_type=mime_type))
        parts.append(types.Part.from_text(text=prompt))
        contents.append(types.Content(role="user", parts=parts))

        config_kwargs: Dict[str, Any] = {
            "temperature": temperature,
            "max_output_tokens": max_output_tokens,
            "thinking_config": types.ThinkingConfig(thinking_budget=1),
        }
        if system_instruction:
            config_kwargs["system_instruction"] = system_instruction
        if json_mode:
            config_kwargs["response_mime_type"] = "application/json"

        config = types.GenerateContentConfig(**config_kwargs)

        # Retry on rate-limit errors with a short backoff — centralized here
        # so every caller (Ask Twin agents, Simulation, onboarding) gets the
        # same resilience without duplicating retry logic.
        max_attempts = 3
        for attempt in range(max_attempts):
            try:
                response = self.client.models.generate_content(
                    model=GEMINI_MODEL,
                    contents=contents,
                    config=config,
                )
                text = response.text
                if text is None:
                    raise RuntimeError("Gemini returned an empty response")
                return text
            except Exception as e:
                # Log only the error type/message — never the prompt or context,
                # which may contain the user's financial data.
                logger.error(f"Gemini generation failed ({GEMINI_MODEL}), attempt {attempt + 1}/{max_attempts}: {type(e).__name__}: {e}")
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
        image_bytes: Optional[bytes] = None,
        mime_type: Optional[str] = None,
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
                image_bytes=image_bytes,
                mime_type=mime_type,
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


    def generate_with_tools(
        self,
        prompt: str,
        tools: list,
        tool_context: dict = None,
        system_instruction: Optional[str] = None,
        chat_history: Optional[List[Dict[str, str]]] = None,
        temperature: float = 0.3,
        max_output_tokens: int = 1200,
    ) -> str:
        """Use Gemini's native function calling to answer a prompt using tools.

        The model autonomously decides which tools to call, calls them with
        extracted arguments, and synthesizes the results into a final answer.
        `tool_context` is a dict of extra runtime args (like `profile_id`, `db`)
        that are injected into tool calls since Gemini cannot pass them itself.

        Falls back to standard generate() if tool calling fails for any reason.
        """
        if not self.client:
            raise RuntimeError("Gemini client not configured (GEMINI_API_KEY missing)")

        from google.genai import types
        import inspect

        contents = []
        if chat_history:
            for msg in chat_history[-6:]:
                role = "model" if msg.get("role") in ("assistant", "twin", "model") else "user"
                text = msg.get("content", "")
                if text:
                    contents.append(types.Content(role=role, parts=[types.Part(text=text)]))
        contents.append(types.Content(role="user", parts=[types.Part(text=prompt)]))

        config = types.GenerateContentConfig(
            temperature=temperature,
            max_output_tokens=max_output_tokens,
            tools=tools,
            # automatic_function_calling handles the multi-turn loop internally
            automatic_function_calling=types.AutomaticFunctionCallingConfig(
                disable=False
            ),
            system_instruction=system_instruction or (
                "You are MoneyKal's AI Financial Assistant. Use the tools available to you to fetch "
                "real user data and search the financial knowledge base before answering. "
                "Always ground your answer in real numbers and retrieved knowledge. "
                "Never guess a user's balance, spending, or tax rate — look it up first."
            ),
        )

        # Wrap each tool function so that we inject runtime context (profile_id, db)
        # into the call, since Gemini only provides the user-visible arguments.
        wrapped_tools = []
        for fn in tools:
            sig = inspect.signature(fn)
            params = list(sig.parameters.keys())
            ctx = tool_context or {}

            def make_wrapper(f, p, c):
                def wrapper(**kwargs):
                    # Inject runtime context args the LLM can't know about
                    for k, v in c.items():
                        if k in p and k not in kwargs:
                            kwargs[k] = v
                    try:
                        return f(**kwargs)
                    except Exception as e:
                        logger.error(f"Tool '{f.__name__}' failed: {e}")
                        return {"error": str(e), "tool": f.__name__}
                wrapper.__name__ = f.__name__
                wrapper.__doc__ = f.__doc__
                wrapper.__annotations__ = f.__annotations__
                return wrapper

            wrapped_tools.append(make_wrapper(fn, params, ctx))

        config.tools = wrapped_tools

        try:
            response = self.client.models.generate_content(
                model=GEMINI_MODEL,
                contents=contents,
                config=config,
            )
            text = response.text
            if text is None:
                raise RuntimeError("Gemini returned an empty response from tool-calling mode")
            return text
        except Exception as e:
            logger.error(f"Tool-calling generation failed, falling back to standard generate: {e}")
            # Graceful fallback: answer without tools
            return self.generate(prompt, system_instruction=system_instruction,
                                 chat_history=chat_history, temperature=temperature,
                                 max_output_tokens=max_output_tokens)


# Singleton used across the app — the one place that talks to Gemini.
gemini_service = GeminiService()

