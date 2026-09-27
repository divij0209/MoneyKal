"""Omnidim AI Voice Service.

Handles automated outbound AI phone calls using Omnidim API keys and Agent ID
for urgent financial alerts, low runway warnings, and budget alerts.
"""
import os
import logging
import httpx
from typing import Optional, Dict, Any
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

logger = logging.getLogger(__name__)

OMNIDIM_API_KEY = os.getenv("OMNIDIM_API_KEY", "")
OMNIDIM_AGENT_ID = os.getenv("OMNIDIM_AGENT_ID", "250569")
OMNIDIM_FROM_NUMBER_ID = os.getenv("OMNIDIM_FROM_NUMBER_ID", "6861")
# No default. This used to fall back to a hardcoded personal number, which
# meant any user without a phone on their profile had their own financial
# summary, recent transactions and upcoming bills read aloud down someone
# else's phone. A call with no destination is now refused instead.
ALERT_PHONE_NUMBER = os.getenv("ALERT_PHONE_NUMBER", "")

OMNIDIM_API_URL = "https://omnidim.io/api/v1/calls/dispatch"


def omnidim_enabled() -> bool:
    """Whether outbound calling is set up for this deployment.

    Lets the route and the UI say "calling is not configured" up front instead
    of accepting the request, spending the caller's allowance and only then
    discovering there is no API key.
    """
    return bool(OMNIDIM_API_KEY and OMNIDIM_AGENT_ID and OMNIDIM_FROM_NUMBER_ID)


def _format_e164(phone: str) -> str:
    """Ensure phone number is formatted in E.164 with a leading '+'."""
    if not phone:
        return ""
    cleaned = str(phone).strip().replace(" ", "").replace("-", "").replace("(", "").replace(")", "")
    if not cleaned.startswith("+"):
        if len(cleaned) == 10:
            cleaned = "+91" + cleaned
        else:
            cleaned = "+" + cleaned
    return cleaned


def trigger_outbound_call(
    to_phone: Optional[str] = None,
    user_name: str = "User",
    alert_reason: str = "urgent financial update",
    custom_context: Optional[Dict[str, Any]] = None,
    profile_id: Optional[int] = None
) -> Dict[str, Any]:
    """
    Trigger an outbound AI call via Omnidim AI.
    """
    # No ALERT_PHONE_NUMBER fallback. The caller passes the destination or
    # there is no call: `variables` below carries the user's balances,
    # transactions and upcoming bills, so dialling a default number would read
    # one person's finances to whoever answers. The route already refuses
    # earlier; this is the second lock on the same door.
    phone_number = _format_e164(to_phone or "")
    if not phone_number or len(phone_number) < 8:
        logger.warning("Omnidim call refused: no usable destination number.")
        return {"success": False, "reason": "no_phone_number",
                "error": "No phone number on file for this account."}

    if not omnidim_enabled():
        logger.warning("Omnidim not configured. Call dispatch skipped.")
        return {"success": False, "reason": "not_configured",
                "error": "Phone calling is not configured for this deployment."}

    headers = {
        "Authorization": f"Bearer {OMNIDIM_API_KEY}",
        "Content-Type": "application/json",
    }

    payload = {
        "agent_id": int(OMNIDIM_AGENT_ID) if OMNIDIM_AGENT_ID.isdigit() else OMNIDIM_AGENT_ID,
        "from_number_id": int(OMNIDIM_FROM_NUMBER_ID) if OMNIDIM_FROM_NUMBER_ID.isdigit() else OMNIDIM_FROM_NUMBER_ID,
        "to_number": phone_number,
        "variables": {
            "user_name": user_name,
            "alert_reason": alert_reason,
            "financial_summary": (custom_context or {}).get("financial_summary", ""),
            "recent_transactions": (custom_context or {}).get("recent_transactions", ""),
            "upcoming_bills": (custom_context or {}).get("upcoming_bills", ""),
            **(custom_context or {})
        }
    }

    try:
        resp = httpx.post(OMNIDIM_API_URL, json=payload, headers=headers, timeout=15)
        success = resp.status_code in (200, 201)
        data = resp.json() if success else {}
        
        logger.info(f"Omnidim outbound call response ({resp.status_code}): {resp.text[:200]}")

        # Save call log entry to database
        db = None
        try:
            from backend.database import SessionLocal
            from backend.models.domain import VoiceCallLog
            db = SessionLocal()
            call_log = VoiceCallLog(
                # Without this the row is orphaned and GET /voice/logs, which
                # filters by profile, never returns a single outbound call.
                profile_id=profile_id,
                provider="omnidim",
                session_id=str(data.get("requestId") or data.get("call_id") or data.get("id") or ""),
                call_type="outbound",
                phone_number=phone_number,
                status="dispatched" if success else "failed",
                summary=f"Outbound AI Call: {alert_reason}",
                ended_reason="dispatched" if success else f"HTTP {resp.status_code}"
            )
            db.add(call_log)
            db.commit()
        except Exception as log_err:
            # Logging a call must never fail the call that was placed.
            logger.error(f"Failed to log Omnidim call to DB: {log_err}")
        finally:
            # Was only closed on the happy path, so every failed write leaked
            # a pooled connection.
            if db is not None:
                db.close()

        if success:
            return {"success": True, "call_details": data}
        else:
            reason = resp.text
            try:
                err_data = resp.json()
                reason = err_data.get("error_description") or err_data.get("message") or err_data.get("error") or resp.text
            except Exception:
                pass
            return {"success": False, "status_code": resp.status_code, "error": reason}
    except Exception as e:
        logger.error(f"Omnidim call dispatch exception: {e}")
        return {"success": False, "error": str(e)}

# Auto-reload trigger
