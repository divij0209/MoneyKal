"""
WhatsApp service for MoneyKal.

Handles:
- Sending outbound messages via Meta WhatsApp Cloud API
- Parsing natural-language transaction messages with Gemini
- Building daily summaries and bill reminders
- Routing inbound messages to the right handler
"""
from backend.core.money import group_indian
import os
import json
import logging
import httpx
from datetime import date, timedelta, datetime
from typing import Optional

from dotenv import load_dotenv
from sqlalchemy.orm import Session

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))

logger = logging.getLogger(__name__)

WHATSAPP_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
GRAPH_API_URL = f"https://graph.facebook.com/v19.0/{PHONE_NUMBER_ID}/messages"


# ---------------------------------------------------------------------------
# Outbound
# ---------------------------------------------------------------------------

def send_message(to_phone: str, text: str) -> bool:
    """Send a plain-text WhatsApp message. Returns True on success."""
    if not WHATSAPP_TOKEN or not PHONE_NUMBER_ID:
        logger.warning("WhatsApp credentials not configured -- message not sent.")
        return False
    payload = {
        "messaging_product": "whatsapp",
        "to": to_phone,
        "type": "text",
        "text": {"body": text},
    }
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        resp = httpx.post(GRAPH_API_URL, json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"WhatsApp message sent to {to_phone}")
            return True
        else:
            logger.error(f"WhatsApp API error {resp.status_code}: {resp.text}")
            return False
    except Exception as e:
        logger.error(f"WhatsApp send failed: {e}")
        return False


def send_button_message(to_phone: str, body_text: str, buttons: list[dict], header_text: Optional[str] = None, footer_text: Optional[str] = None) -> bool:
    """
    Send an interactive Quick Reply button message via Meta Cloud API.
    `buttons` should be a list of dicts: [{"id": "btn_1", "title": "Check Balance"}] (max 3 buttons).
    """
    if not WHATSAPP_TOKEN or not PHONE_NUMBER_ID:
        logger.warning("WhatsApp credentials not configured -- button message not sent.")
        return False

    formatted_buttons = []
    for btn in buttons[:3]:  # WhatsApp limit: max 3 interactive buttons
        formatted_buttons.append({
            "type": "reply",
            "reply": {
                "id": str(btn["id"]),
                "title": str(btn["title"])[:20]  # WhatsApp limit: max 20 chars
            }
        })

    interactive_obj = {
        "type": "button",
        "body": {"text": body_text},
        "action": {"buttons": formatted_buttons}
    }
    if header_text:
        interactive_obj["header"] = {"type": "text", "text": header_text}
    if footer_text:
        interactive_obj["footer"] = {"text": footer_text}

    payload = {
        "messaging_product": "whatsapp",
        "to": to_phone,
        "type": "interactive",
        "interactive": interactive_obj
    }
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        resp = httpx.post(GRAPH_API_URL, json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"WhatsApp button message sent to {to_phone}")
            return True
        else:
            logger.error(f"WhatsApp button API error {resp.status_code}: {resp.text}")
            fallback_text = body_text + "\n\nQuick Options:\n" + "\n".join([f"• {b['title']}" for b in buttons])
            return send_message(to_phone, fallback_text)
    except Exception as e:
        logger.error(f"WhatsApp button send failed: {e}")
        return send_message(to_phone, body_text)


def send_list_message(to_phone: str, body_text: str, button_text: str, sections: list[dict], header_text: Optional[str] = None, footer_text: Optional[str] = None) -> bool:
    """
    Send an interactive List Menu message via Meta Cloud API.
    `sections` format:
    [
        {
            "title": "Section Title",
            "rows": [
                {"id": "row_1", "title": "Row Title", "description": "Short subtitle"}
            ]
        }
    ]
    """
    if not WHATSAPP_TOKEN or not PHONE_NUMBER_ID:
        logger.warning("WhatsApp credentials not configured -- list message not sent.")
        return False

    formatted_sections = []
    for sec in sections:
        sec_rows = []
        for r in sec.get("rows", []):
            row_obj = {
                "id": str(r["id"]),
                "title": str(r["title"])[:24]
            }
            if r.get("description"):
                row_obj["description"] = str(r["description"])[:72]
            sec_rows.append(row_obj)
        formatted_sections.append({
            "title": str(sec.get("title", "Menu"))[:24],
            "rows": sec_rows
        })

    interactive_obj = {
        "type": "list",
        "body": {"text": body_text},
        "action": {
            "button": str(button_text)[:20],
            "sections": formatted_sections
        }
    }
    if header_text:
        interactive_obj["header"] = {"type": "text", "text": header_text}
    if footer_text:
        interactive_obj["footer"] = {"text": footer_text}

    payload = {
        "messaging_product": "whatsapp",
        "to": to_phone,
        "type": "interactive",
        "interactive": interactive_obj
    }
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json",
    }
    try:
        resp = httpx.post(GRAPH_API_URL, json=payload, headers=headers, timeout=10)
        if resp.status_code == 200:
            logger.info(f"WhatsApp list message sent to {to_phone}")
            return True
        else:
            logger.error(f"WhatsApp list API error {resp.status_code}: {resp.text}")
            return send_message(to_phone, body_text)
    except Exception as e:
        logger.error(f"WhatsApp list send failed: {e}")
        return send_message(to_phone, body_text)


def download_whatsapp_media(media_id: str) -> tuple[Optional[bytes], Optional[str]]:
    """Download binary media from WhatsApp using a media ID."""
    if not WHATSAPP_TOKEN:
        return None, None
    headers = {"Authorization": f"Bearer {WHATSAPP_TOKEN}"}
    try:
        url_resp = httpx.get(f"https://graph.facebook.com/v19.0/{media_id}", headers=headers, timeout=10)
        url_resp.raise_for_status()
        media_url = url_resp.json().get("url")
        mime_type = url_resp.json().get("mime_type")
        if not media_url:
            return None, None
            
        media_resp = httpx.get(media_url, headers=headers, timeout=15)
        media_resp.raise_for_status()
        return media_resp.content, mime_type
    except Exception as e:
        logger.error(f"Failed to download WhatsApp media {media_id}: {e}")
        return None, None


# ---------------------------------------------------------------------------
# AI Transaction Parser
# ---------------------------------------------------------------------------

PARSE_PROMPT = """You are a financial transaction parser for an Indian personal finance app.
Extract the transaction from the user's WhatsApp message and return a JSON object with:
- "amount": number (required, in rupees)
- "direction": "in" or "out" (in = money received, out = money spent/paid)
- "category": one of ["Groceries", "Food & Dining", "Utilities & Bills", "Subscriptions", "Rent / Housing", "Travel & Transport", "Health & Medical", "Shopping", "Entertainment", "Taxes", "Professional fees", "Software/Tools", "Salary / Income", "Other income", "Other expense"]
- "description": short description (max 60 chars)
- "txn_date": "YYYY-MM-DD" (use today if not specified: {today})
- "is_goal": boolean (true if the user is saving or contributing money towards a specific fund/goal)
- "goal_name": string (the name of the goal/fund, if is_goal is true)

Respond with ONLY valid JSON. If the message is not a transaction, return {{"error": "not_a_transaction"}}.

Message: {message}"""

def parse_transaction_from_message(message: str) -> Optional[dict]:
    """Use Gemini to extract transaction data from a free-text message."""
    try:
        from backend.services.gemini_service import gemini_service
        today = date.today().isoformat()
        prompt = PARSE_PROMPT.format(message=message, today=today)
        data = gemini_service.generate_json(prompt)
        if not data or "error" in data:
            return None
        return data
    except Exception as e:
        logger.error(f"Transaction parse failed: {e}")
        return None

PARSE_SUBSCRIPTION_PROMPT = """You are a financial subscription parser for an Indian personal finance app.
Extract the subscription details from the user's WhatsApp message and return a JSON object with:
- "is_subscription": boolean (true if the user is asking to add a new subscription, bill, or recurring payment reminder)
- "name": string (the name of the service, e.g. "Netflix")
- "amount": number (required, in rupees)
- "recurrence": one of ["none", "weekly", "monthly", "quarterly", "yearly"]
- "payment_url": string (the URL to pay the subscription, if provided in the text. Must start with http:// or https://)

Respond with ONLY valid JSON. If the message is not a subscription addition, return {{"is_subscription": false}}.

Message: {message}"""

def parse_subscription_from_message(message: str) -> Optional[dict]:
    try:
        from backend.services.gemini_service import gemini_service
        prompt = PARSE_SUBSCRIPTION_PROMPT.format(message=message)
        data = gemini_service.generate_json(prompt)
        if not data or not data.get("is_subscription"):
            return None
        return data
    except Exception as e:
        logger.error(f"Subscription parse failed: {e}")
        return None

def parse_transaction_from_image(image_bytes: bytes, mime_type: str) -> Optional[dict]:
    """Use Gemini Vision to extract transaction data from a receipt image."""
    try:
        from backend.services.gemini_service import gemini_service
        today = date.today().isoformat()
        prompt = "Extract the transaction from this receipt image. " + PARSE_PROMPT.format(message="", today=today)
        data = gemini_service.generate_json(prompt, image_bytes=image_bytes, mime_type=mime_type)
        if not data or "error" in data:
            return None
        return data
    except Exception as e:
        logger.error(f"Image transaction parse failed: {e}")
        return None


# ---------------------------------------------------------------------------
# Summary Builder
# ---------------------------------------------------------------------------

def build_daily_summary(profile, db: Session) -> str:
    """Build a morning summary message for this profile."""
    from backend.models.domain import StartupTransaction, UpcomingPayment

    currency = profile.currency or "Rs."
    today = date.today()
    yesterday = today - timedelta(days=1)

    yesterday_txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile.id,
        StartupTransaction.txn_date == yesterday,
    ).all()
    spent_yday = sum(t.amount for t in yesterday_txns if t.type == "out")
    income_yday = sum(t.amount for t in yesterday_txns if t.type == "in")

    upcoming = db.query(UpcomingPayment).filter(
        UpcomingPayment.profile_id == profile.id,
        UpcomingPayment.is_active == True,
        UpcomingPayment.due_date >= today,
        UpcomingPayment.due_date <= today + timedelta(days=7),
    ).order_by(UpcomingPayment.due_date).all()

    all_txns = db.query(StartupTransaction).filter(
        StartupTransaction.profile_id == profile.id,
    ).all()
    total_in = sum(t.amount for t in all_txns if t.type == "in")
    total_out = sum(t.amount for t in all_txns if t.type == "out")
    net = total_in - total_out

    name = (profile.persona or "there").split()[0]
    hour = datetime.now().hour
    if hour < 12:
        greeting = "Good morning"
    elif hour < 17:
        greeting = "Good afternoon"
    else:
        greeting = "Good evening"
    lines = [f"{greeting}, {name}! Here is your MoneyKal update:\n"]

    if spent_yday or income_yday:
        if spent_yday:
            lines.append(f"Yesterday you spent {currency}{group_indian(spent_yday)}")
        if income_yday:
            lines.append(f"Yesterday you received {currency}{group_indian(income_yday)}")
    else:
        lines.append("No transactions logged yesterday.")

    lines.append(f"Net balance (Hisaab): {currency}{group_indian(net)}")

    if upcoming:
        lines.append(f"\n{len(upcoming)} bill(s) due this week:")
        for u in upcoming[:3]:
            days_left = (u.due_date - today).days
            due_str = "today" if days_left == 0 else f"in {days_left} day(s)"
            lines.append(f"  - {u.name} -- {currency}{group_indian(u.amount)} ({due_str})")
        if len(upcoming) > 3:
            lines.append(f"  ...and {len(upcoming) - 3} more.")
    else:
        lines.append("\nNo bills due this week.")

    lines.append("\nReply with a transaction like \"Paid 500 for groceries\" and I will log it for you!")
    return "\n".join(lines)


def build_bill_reminder(payment, currency: str = "Rs.") -> str:
    """Build a reminder message for an upcoming payment."""
    today = date.today()
    days_left = (payment.due_date - today).days
    if days_left == 0:
        urgency = "Due TODAY"
    elif days_left <= 3:
        urgency = f"Due in {days_left} day(s)"
    else:
        urgency = f"Due in {days_left} days"

    lines = [f"{urgency}: {payment.name} -- {currency}{group_indian(payment.amount)}"]
    
    if payment.source_meta and payment.source_meta.get("payment_url"):
        lines.append(f"Pay now: {payment.source_meta.get('payment_url')}")
        
    lines.append(f"Reply 'Mark paid {payment.id}' to log it in Hisaab automatically.")
    
    return "\n".join(lines)

def send_daily_summaries(db: Session):
    """Send morning summaries to all individual profiles."""
    from backend.models.domain import Profile
    profiles = db.query(Profile).filter(Profile.whatsapp_phone != None).all()
    for profile in profiles:
        summary = build_daily_summary(profile, db)
        send_message(profile.whatsapp_phone, summary)

def send_bill_reminders(db: Session):
    """Send bill reminders to all profiles with upcoming payments due soon using interactive buttons."""
    from backend.models.domain import Profile, UpcomingPayment
    today = date.today()
    payments = db.query(UpcomingPayment).filter(
        UpcomingPayment.is_active == True,
        UpcomingPayment.due_date >= today,
        UpcomingPayment.due_date <= today + timedelta(days=3),
    ).all()
    for payment in payments:
        profile = db.query(Profile).filter(Profile.id == payment.profile_id).first()
        if profile and profile.whatsapp_phone:
            currency = profile.currency or "Rs."
            days_left = (payment.due_date - today).days
            urgency = "Due TODAY" if days_left == 0 else f"Due in {days_left} day(s)"
            
            body_text = f"Reminder: {payment.name} is {urgency}.\nAmount: {currency}{group_indian(payment.amount)}"
            if payment.source_meta and payment.source_meta.get("payment_url"):
                body_text += f"\nPay Link: {payment.source_meta.get('payment_url')}"
                
            send_button_message(
                to_phone=profile.whatsapp_phone,
                header_text="Upcoming Bill Alert",
                body_text=body_text,
                buttons=[
                    {"id": f"mark_paid_{payment.id}", "title": "Mark as Paid"},
                    {"id": "cmd_bills", "title": "View All Bills"},
                    {"id": "cmd_menu", "title": "Main Menu"}
                ]
            )



# ---------------------------------------------------------------------------
# Inbound Message Router
# ---------------------------------------------------------------------------

def handle_incoming_message(from_phone: str, message_text: str, db: Session):
    """
    Route an inbound WhatsApp message to the right handler.
    Returns either a reply string or an interactive payload dictionary (button/list).
    """
    from backend.models.domain import Profile, StartupTransaction, UpcomingPayment

    profile = db.query(Profile).filter(Profile.whatsapp_phone == from_phone).first()
    if not profile:
        return (
            "Hi! I couldn't find a MoneyKal account linked to this number.\n"
            "Open your MoneyKal dashboard, go to Edit Profile, and add your WhatsApp number."
        )

    text = message_text.strip().lower()

    # --- Direct command IDs from interactive clicks ---
    if text == "cmd_summary":
        text = "summary"
    elif text == "cmd_bills":
        text = "bills"
    elif text == "cmd_menu" or text == "cmd_help":
        text = "help"
    elif text.startswith("mark_paid_"):
        try:
            pid = int(text.replace("mark_paid_", ""))
            text = f"mark paid {pid}"
        except ValueError:
            pass

    # --- Mark paid command ---
    if text.startswith("mark paid"):
        parts = message_text.split()
        payment_id = None
        for p in parts:
            if p.isdigit():
                payment_id = int(p)
                break

        if payment_id:
            item = db.query(UpcomingPayment).filter(
                UpcomingPayment.id == payment_id,
                UpcomingPayment.profile_id == profile.id,
            ).first()
            if item:
                item.last_paid_on = date.today()
                txn = StartupTransaction(
                    profile_id=profile.id,
                    txn_date=date.today(),
                    type=item.direction,
                    amount=item.amount,
                    category=item.category or "Other expense",
                    description=item.name,
                    source="whatsapp",
                )
                db.add(txn)
                db.commit()
                currency = profile.currency or "Rs."
                
                return {
                    "kind": "button",
                    "header": "Bill Marked Paid!",
                    "body": f"Marked {item.name} ({currency}{group_indian(item.amount)}) as paid and logged in Hisaab!",
                    "buttons": [
                        {"id": "cmd_bills", "title": "View Remaining Bills"},
                        {"id": "cmd_summary", "title": "Check Balance"},
                        {"id": "cmd_menu", "title": "Main Menu"}
                    ]
                }
            else:
                return "Payment not found. Try checking your MoneyKal dashboard."

    # --- Balance / summary query ---
    if any(kw in text for kw in ["balance", "summary", "how much", "spending", "hisaab", "show"]):
        summary_text = build_daily_summary(profile, db)
        return {
            "kind": "button",
            "header": "MoneyKal Financial Summary",
            "body": summary_text,
            "buttons": [
                {"id": "cmd_bills", "title": "View Upcoming Bills"},
                {"id": "cmd_menu", "title": "Main Menu"}
            ]
        }

    # --- Bills query ---
    if any(kw in text for kw in ["bills", "due", "upcoming", "what's due", "payments"]):
        today = date.today()
        upcoming = db.query(UpcomingPayment).filter(
            UpcomingPayment.profile_id == profile.id,
            UpcomingPayment.is_active == True,
            UpcomingPayment.due_date >= today,
        ).order_by(UpcomingPayment.due_date).limit(10).all()
        
        if not upcoming:
            return {
                "kind": "button",
                "body": "No upcoming bills found in your MoneyKal account.",
                "buttons": [
                    {"id": "cmd_summary", "title": "Check Balance"},
                    {"id": "cmd_menu", "title": "Main Menu"}
                ]
            }
        
        currency = profile.currency or "Rs."
        
        # Build interactive list menu for upcoming bills so user can click to pay!
        rows = []
        for u in upcoming[:10]:
            days_left = (u.due_date - today).days
            due_str = "Due TODAY" if days_left == 0 else f"Due in {days_left}d"
            rows.append({
                "id": f"mark_paid_{u.id}",
                "title": f"Mark Paid: {u.name[:14]}",
                "description": f"{currency}{group_indian(u.amount)} ({due_str})"
            })
            
        sections = [
            {
                "title": "Select a Bill to Mark Paid",
                "rows": rows
            }
        ]
        
        return {
            "kind": "list",
            "header": "Upcoming Bills & Subscriptions",
            "body": "Here are your upcoming payments. Click 'Mark as Paid' below to select a bill and log it into Hisaab with 1 tap!",
            "button_text": "Mark a Bill Paid",
            "sections": sections,
            "footer": "MoneyKal Financial Decision Twin"
        }

    # --- Help / Welcome Menu ---
    if any(kw in text for kw in ["help", "hi", "hello", "hey", "start", "menu"]):
        sections = [
            {
                "title": "Quick Actions",
                "rows": [
                    {
                        "id": "cmd_summary",
                        "title": "Check Balance & Hisaab",
                        "description": "View net balance, yesterday's spending & health"
                    },
                    {
                        "id": "cmd_bills",
                        "title": "View Upcoming Bills",
                        "description": "See due subscriptions and mark paid with 1 tap"
                    }
                ]
            },
            {
                "title": "Smart Logging",
                "rows": [
                    {
                        "id": "cmd_log_info",
                        "title": "Log a Transaction",
                        "description": "Send text like 'Paid 500 for groceries' or photo receipt"
                    },
                    {
                        "id": "cmd_sub_info",
                        "title": "Add Subscription",
                        "description": "Send text like 'Remind Netflix 499 monthly'"
                    }
                ]
            }
        ]
        
        return {
            "kind": "list",
            "header": "Welcome to MoneyKal Twin",
            "body": "Manage your finances directly in WhatsApp! Tap the button below to select an action without typing.",
            "button_text": "Select Action",
            "sections": sections,
            "footer": "Synced live with your MoneyKal Dashboard"
        }
        
    if text == "cmd_log_info":
        return {
            "kind": "button",
            "body": "To log a transaction:\n\n1. Type a message like 'Paid 350 for lunch'\n2. Or take a photo of any receipt & send it here!",
            "buttons": [
                {"id": "cmd_summary", "title": "Check Balance"},
                {"id": "cmd_menu", "title": "Main Menu"}
            ]
        }
        
    if text == "cmd_sub_info":
        return {
            "kind": "button",
            "body": "To add a recurring subscription or bill reminder:\n\nType 'Remind me to pay Spotify 119 monthly' and MoneyKal will remind you before it's due!",
            "buttons": [
                {"id": "cmd_bills", "title": "View Bills"},
                {"id": "cmd_menu", "title": "Main Menu"}
            ]
        }


    import concurrent.futures

    sub_parsed = None
    parsed = None
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        future_sub = executor.submit(parse_subscription_from_message, message_text)
        future_txn = executor.submit(parse_transaction_from_message, message_text)
        sub_parsed = future_sub.result()
        parsed = future_txn.result()

    # --- Try to parse as a subscription addition ---
    if sub_parsed and sub_parsed.get("is_subscription") and "amount" in sub_parsed and "name" in sub_parsed:
        try:
            url = sub_parsed.get("payment_url")
            meta = {"payment_url": url} if url else None
            
            sub = UpcomingPayment(
                profile_id=profile.id,
                name=sub_parsed["name"],
                amount=float(sub_parsed["amount"]),
                due_date=date.today(),
                category="Subscriptions",
                recurrence=sub_parsed.get("recurrence", "monthly"),
                direction="out",
                event_type="subscription",
                source="whatsapp",
                status="confirmed",
                source_meta=meta
            )
            db.add(sub)
            db.commit()
            
            currency = profile.currency or "Rs."
            return (
                f"Added '{sub.name}' subscription for {currency}{group_indian(sub.amount)} ({sub.recurrence}).\n"
                "I will remind you when it's due!"
            )
        except Exception as e:
            logger.error(f"Failed to save WhatsApp subscription: {e}")
            return "Something went wrong saving that subscription. Please try again."

    # --- Try to parse as a transaction ---
    # (Already parsed concurrently above)
    if parsed and "amount" in parsed:
        if parsed.get("is_goal") and parsed.get("goal_name"):
            from backend.models.domain import FinancialGoal
            goal_name = parsed["goal_name"]
            goal = db.query(FinancialGoal).filter(
                FinancialGoal.profile_id == profile.id,
                FinancialGoal.name.ilike(f"%{goal_name}%")
            ).first()
            if goal:
                goal.current_amount += float(parsed["amount"])
                db.commit()
                currency = profile.currency or "Rs."
                return f"Awesome! Added {currency}{group_indian(parsed['amount'])} to '{goal.name}'. You are now at {currency}{group_indian(goal.current_amount)} / {currency}{group_indian(goal.target_amount)}!"
            else:
                return f"Could not find a savings goal matching '{goal_name}'."
        
        try:
            txn = StartupTransaction(
                profile_id=profile.id,
                txn_date=date.fromisoformat(parsed.get("txn_date", date.today().isoformat())),
                type=parsed["direction"],
                amount=float(parsed["amount"]),
                category=parsed.get("category", "Other expense"),
                description=parsed.get("description", message_text[:60]),
                source="whatsapp",
            )
            db.add(txn)
            db.commit()
            currency = profile.currency or "Rs."
            direction_label = "received" if parsed["direction"] == "in" else "spent"
            return (
                f"Logged! You {direction_label} {currency}{group_indian(parsed['amount'])}"
                f" -- {parsed.get('category', 'Other')}\n"
                f"{parsed.get('description', '')}\n"
                f"View in Hisaab on your MoneyKal dashboard."
            )
        except Exception as e:
            logger.error(f"Failed to save WhatsApp transaction: {e}")
            return "Something went wrong saving that transaction. Please try again."

    # --- Fallback: Route to Tool-Calling Agent (RAG + Live Data) ---
    from backend.models.domain import ChatSession, ChatMessage, AuditTrace
    import uuid
    from backend.agents.orchestrator import orchestrator
    from backend.agents.startup_orchestrator import startup_orchestrator
    from backend.services.discovery_flow import run_discovery_turn
    from backend.services.gemini_service import gemini_service
    from backend.services.agent_tools import ALL_TOOLS

    session_id = f"whatsapp_{profile.id}"
    session = db.query(ChatSession).filter(ChatSession.id == session_id).first()
    if not session:
        session = ChatSession(id=session_id, profile_id=profile.id, title="WhatsApp Chat")
        db.add(session)
        db.commit()

    user_msg = ChatMessage(session_id=session_id, role="user", content=message_text)
    db.add(user_msg)
    db.commit()

    history = db.query(ChatMessage).filter(ChatMessage.session_id == session_id).order_by(ChatMessage.created_at).all()
    # keep last 8 messages for context
    chat_history = [{"role": "assistant" if m.role == "twin" else m.role, "content": m.content} for m in history[-9:-1]]

    # First, try the powerful Tool Calling + RAG agent
    answer = None
    try:
        tool_context = {"profile_id": profile.id, "db": db}
        answer = gemini_service.generate_with_tools(
            prompt=message_text,
            tools=ALL_TOOLS,
            tool_context=tool_context,
            chat_history=chat_history,
        )
    except Exception as e:
        logger.warning(f"Tool-calling agent failed for WhatsApp, falling back to orchestrator: {e}")

    # If tool calling failed, fall back to the existing orchestrator pipeline
    if not answer:
        active_orchestrator = startup_orchestrator if profile.key == "startup" else orchestrator
        if profile.key == "startup":
            response = active_orchestrator.process_query(profile, message_text, chat_history=chat_history, db=db)
        else:
            response = run_discovery_turn(
                profile=profile,
                message=message_text,
                chat_history=chat_history,
                session_id=session_id,
                db=db,
            )
        answer = response.answer

    twin_msg = ChatMessage(session_id=session_id, role="twin", content=answer)
    db.add(twin_msg)

    req_id = str(uuid.uuid4())
    audit = AuditTrace(
        id=req_id,
        profile_id=profile.id,
        query=message_text,
        response={"answer": answer},
        reasoning_trace=[{"agent": "ToolCallingAgent", "action": "Executed tools + RAG"}],
        sources=[{"source": "Tool Calling + ChromaDB RAG"}]
    )
    db.add(audit)
    db.commit()

    return answer


def handle_incoming_image(from_phone: str, image_bytes: bytes, mime_type: str, db: Session) -> str:
    """Route an inbound WhatsApp image to extract a receipt."""
    from backend.models.domain import Profile, StartupTransaction
    
    profile = db.query(Profile).filter(Profile.whatsapp_phone == from_phone).first()
    if not profile:
        return "Hi! I couldn't find a MoneyKal account linked to this number."
        
    parsed = parse_transaction_from_image(image_bytes, mime_type)
    if parsed and "amount" in parsed:
        try:
            txn = StartupTransaction(
                profile_id=profile.id,
                txn_date=date.fromisoformat(parsed.get("txn_date", date.today().isoformat())),
                type=parsed["direction"],
                amount=float(parsed["amount"]),
                category=parsed.get("category", "Other expense"),
                description=parsed.get("description", "Receipt upload"),
                source="whatsapp",
            )
            db.add(txn)
            db.commit()
            currency = profile.currency or "Rs."
            direction_label = "received" if parsed["direction"] == "in" else "spent"
            return (
                f"Receipt Logged! You {direction_label} {currency}{group_indian(parsed['amount'])}"
                f" -- {parsed.get('category', 'Other')}\n"
                f"{parsed.get('description', '')}"
            )
        except Exception as e:
            logger.error(f"Failed to save WhatsApp image transaction: {e}")
            return "Something went wrong saving that receipt. Please try again."
    return "I couldn't read a clear transaction from that image. Try sending it as text."
