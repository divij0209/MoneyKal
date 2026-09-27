"""
WhatsApp webhook router for MoneyKal.

GET /whatsapp/webhook  -- Meta verification challenge
POST /whatsapp/webhook -- Incoming messages from Meta Cloud API
POST /whatsapp/test    -- Internal test endpoint to send a message manually
"""
import logging
from fastapi import APIRouter, Request, Query, HTTPException, BackgroundTasks, Depends
from fastapi.responses import PlainTextResponse
from backend.core.auth import get_current_user
from backend.models.domain import User
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

import collections

logger = logging.getLogger(__name__)

VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", "moneykal_secret_2026")

_seen_messages = collections.deque(maxlen=1000)

router = APIRouter(prefix="/whatsapp", tags=["WhatsApp"])


# ---------------------------------------------------------------------------
# Webhook verification (GET)
# ---------------------------------------------------------------------------

@router.get("/webhook")
def verify_webhook(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge"),
):
    """Meta calls this once to verify the webhook endpoint."""
    if hub_mode == "subscribe" and hub_verify_token == VERIFY_TOKEN:
        logger.info("WhatsApp webhook verified successfully.")
        return PlainTextResponse(content=hub_challenge)
    raise HTTPException(status_code=403, detail="Webhook verification failed.")


# ---------------------------------------------------------------------------
# Incoming messages (POST)
# ---------------------------------------------------------------------------

@router.post("/webhook")
async def receive_webhook(request: Request, background_tasks: BackgroundTasks):
    """Receive and handle incoming WhatsApp messages."""
    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    # Pass only the payload — background task opens its own DB session
    background_tasks.add_task(_process_webhook, payload)
    # Always return 200 quickly -- Meta retries if we take too long
    return {"status": "ok"}


WHATSAPP_UPGRADE_REPLY = (
    "Logging on WhatsApp is part of MoneyKal ACT.\n"
    "Open MoneyKal on the website and go to Plans & Billing to upgrade. "
    "Everything you have already logged is still in your dashboard."
)


def _whatsapp_locked(db, from_phone: str) -> bool:
    """True for a linked account that is not on ACT.

    Unlinked numbers are not locked here: the existing handlers already answer
    them with how to link an account, and that reply should stay as it is.
    Outbound bill reminders and daily summaries are separate scheduler jobs and
    are not affected.
    """
    from backend.core.access import has_act
    from backend.models.domain import Profile

    profile = db.query(Profile).filter(Profile.whatsapp_phone == from_phone).first()
    return bool(profile and profile.user_id and not has_act(db, profile.user_id))


def _process_webhook(payload: dict):
    """Parse Meta webhook payload and route each message.
    Opens its own DB session so it is not affected by the request lifecycle."""
    from backend.services.whatsapp_service import handle_incoming_message, send_message, download_whatsapp_media, handle_incoming_image
    from backend.services.groq_service import groq_service
    from backend.database import SessionLocal

    db = SessionLocal()
    try:
        for entry in payload.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                messages = value.get("messages", [])
                for msg in messages:
                    from_phone = msg.get("from", "")
                    msg_type = msg.get("type")
                    msg_id = msg.get("id")
                    
                    if msg_id:
                        if msg_id in _seen_messages:
                            logger.info(f"Skipping duplicate WhatsApp message: {msg_id}")
                            continue
                        _seen_messages.append(msg_id)

                    if msg_type in ("text", "image", "audio") and _whatsapp_locked(db, from_phone):
                        send_message(from_phone, WHATSAPP_UPGRADE_REPLY)
                        continue

                    if msg_type == "text":
                        text = msg.get("text", {}).get("body", "").strip()
                        if not text:
                            continue
                        logger.info(f"Incoming WhatsApp text from {from_phone}: {text[:80]}")
                        try:
                            reply_payload = handle_incoming_message(from_phone, text, db)
                            _deliver_reply(from_phone, reply_payload)
                        except Exception as e:
                            logger.error(f"Error handling text message from {from_phone}: {e}")

                    elif msg_type == "interactive":
                        interactive = msg.get("interactive", {})
                        int_type = interactive.get("type")
                        button_reply = interactive.get("button_reply", {})
                        list_reply = interactive.get("list_reply", {})

                        selected_id = button_reply.get("id") or list_reply.get("id") or ""
                        selected_title = button_reply.get("title") or list_reply.get("title") or ""
                        
                        logger.info(f"Incoming WhatsApp interactive click from {from_phone}: ID={selected_id}, Title='{selected_title}'")
                        try:
                            # Route button click ID / text back to our message router
                            incoming_text = selected_id if selected_id.startswith("cmd_") or selected_id.startswith("mark_paid_") else selected_title
                            reply_payload = handle_incoming_message(from_phone, incoming_text, db)
                            _deliver_reply(from_phone, reply_payload)
                        except Exception as e:
                            logger.error(f"Error handling interactive selection from {from_phone}: {e}")

                    elif msg_type == "image":
                        image_data = msg.get("image", {})
                        media_id = image_data.get("id")
                        if not media_id:
                            continue
                        logger.info(f"Incoming WhatsApp image from {from_phone} (ID: {media_id})")
                        send_message(from_phone, "Got it! Reading your receipt... 🧾")
                        image_bytes, mime_type = download_whatsapp_media(media_id)
                        if not image_bytes:
                            send_message(from_phone, "Sorry, I couldn't download that image. Meta may have restricted it.")
                            continue
                        try:
                            reply_payload = handle_incoming_image(from_phone, image_bytes, mime_type, db)
                            _deliver_reply(from_phone, reply_payload)
                        except Exception as e:
                            logger.error(f"Error handling image from {from_phone}: {e}")

                    elif msg_type == "audio":
                        audio_data = msg.get("audio", {})
                        media_id = audio_data.get("id")
                        if not media_id:
                            continue
                        logger.info(f"Incoming WhatsApp audio from {from_phone} (ID: {media_id})")
                        send_message(from_phone, "Listening to your voice note... 🎙️")
                        audio_bytes, mime_type = download_whatsapp_media(media_id)
                        if not audio_bytes:
                            send_message(from_phone, "Sorry, I couldn't download that voice note. Meta may have restricted it.")
                            continue
                        try:
                            transcription = groq_service.transcribe(audio_bytes, filename="audio.ogg")
                            text = transcription.get("text", "").strip()
                            if not text:
                                send_message(from_phone, "I couldn't hear any speech in that voice note.")
                                continue

                            reply_payload = handle_incoming_message(from_phone, text, db)
                            _deliver_reply(from_phone, reply_payload)
                        except Exception as e:
                            logger.error(f"Error handling audio from {from_phone}: {e}")
    except Exception as e:
        logger.error(f"WhatsApp webhook processing error: {e}")
    finally:
        db.close()


def _deliver_reply(from_phone: str, reply_payload):
    """Deliver a text, button, or list menu payload to the user's WhatsApp."""
    from backend.services.whatsapp_service import send_message, send_button_message, send_list_message

    if isinstance(reply_payload, dict):
        msg_kind = reply_payload.get("kind")
        if msg_kind == "button":
            send_button_message(
                to_phone=from_phone,
                body_text=reply_payload.get("body", ""),
                buttons=reply_payload.get("buttons", []),
                header_text=reply_payload.get("header"),
                footer_text=reply_payload.get("footer")
            )
        elif msg_kind == "list":
            send_list_message(
                to_phone=from_phone,
                body_text=reply_payload.get("body", ""),
                button_text=reply_payload.get("button_text", "Open Menu"),
                sections=reply_payload.get("sections", []),
                header_text=reply_payload.get("header"),
                footer_text=reply_payload.get("footer")
            )
        else:
            send_message(from_phone, reply_payload.get("body", str(reply_payload)))
    elif isinstance(reply_payload, str):
        send_message(from_phone, reply_payload)



# ---------------------------------------------------------------------------
# Manual test endpoint
# ---------------------------------------------------------------------------

@router.post("/test-send")
def test_send(phone: str, message: str, current_user: User = Depends(get_current_user)):
    """Dev-only: send a message to a phone number directly.

    Requires a logged-in caller and is off unless WHATSAPP_TEST_SEND=true.
    It took no authentication at all and is mounted in every environment, so
    anyone who could reach the API could send arbitrary WhatsApp messages to
    arbitrary numbers through the project's own Evolution account.
    """
    if os.getenv("WHATSAPP_TEST_SEND", "").lower() not in ("1", "true", "yes"):
        raise HTTPException(status_code=404, detail="Not found")
    from backend.services.whatsapp_service import send_message
    success = send_message(phone, message)
    return {"sent": success}
