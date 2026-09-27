"""
Gmail auto-import for Hisaab.

Reads the founder's Gmail inbox (read-only), finds bank debit/credit alert
emails and order-confirmation emails (Amazon/Swiggy/Zomato/etc.), parses out
amount + merchant + date, and returns them as candidate StartupTransaction
rows with source="auto". Never invents an amount — if a message can't be
confidently parsed, it's skipped rather than guessed.

Bank email formats differ per-bank and change over time; this uses generic
regex patterns that cover the most common phrasing used by major Indian
banks (HDFC, ICICI, SBI, Axis, Kotak). Expect to tune these over time.
"""
import base64
import re
import logging
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/userinfo.email"]


# ---------------------------------------------------------------------------
# OAuth flow helpers
# ---------------------------------------------------------------------------

def build_flow(client_id: str, client_secret: str, redirect_uri: str) -> Flow:
    client_config = {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redirect_uri],
        }
    }
    return Flow.from_client_config(client_config, scopes=GMAIL_SCOPES, redirect_uri=redirect_uri)


def credentials_from_connection(conn, client_id: str, client_secret: str) -> Credentials:
    """Builds a google Credentials object from a stored GmailConnection row,
    refreshing the access token if it's expired."""
    creds = Credentials(
        token=conn.access_token,
        refresh_token=conn.refresh_token,
        token_uri="https://oauth2.googleapis.com/token",
        client_id=client_id,
        client_secret=client_secret,
        scopes=GMAIL_SCOPES,
    )
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        conn.access_token = creds.token
        conn.token_expiry = creds.expiry
    return creds


# ---------------------------------------------------------------------------
# Search query — narrows Gmail search server-side before we even fetch bodies
# ---------------------------------------------------------------------------

BANK_SENDER_HINTS = [
    "alerts@hdfcbank.net", "hdfcbank", "icicibank.com", "sbi.co.in",
    "axisbank.com", "kotak.com", "alerts.yesbank.in", "idfcfirstbank.com",
]
MERCHANT_SENDER_HINTS = [
    "amazon.in", "swiggy.in", "zomato.com", "flipkart.com", "myntra.com",
]
SUBJECT_HINTS = [
    "debited", "credited", "transaction", "payment", "order", 
    "shipped", "spent", "received", "refund", "bill", 
    "invoice", "receipt", "purchase"
]


def build_gmail_query(since: Optional[datetime] = None) -> str:
    since = since or (datetime.utcnow() - timedelta(days=2))
    date_str = since.strftime("%Y/%m/%d")
    sender_part = " OR ".join(f"from:{s}" for s in BANK_SENDER_HINTS + MERCHANT_SENDER_HINTS)
    subject_part = " OR ".join(f'subject:"{s}"' for s in SUBJECT_HINTS)
    return f"(({sender_part}) OR ({subject_part})) after:{date_str}"


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------

def fetch_candidate_messages(creds: Credentials, since: Optional[datetime] = None, max_results: int = 50,
                             query: Optional[str] = None) -> List[Dict[str, Any]]:
    """Returns a list of {id, subject, sender, date, body_text} for messages
    matching our bank/merchant search. Body text is plain-text extracted
    from the email (HTML stripped).

    `query` overrides the default transaction search, so a second reader (the
    deadline detector) can narrow on its own vocabulary through this same
    fetch/decode path instead of duplicating it. Omitted, behaviour is
    unchanged."""
    service = build("gmail", "v1", credentials=creds)
    query = query or build_gmail_query(since)

    results = service.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
    messages = results.get("messages", [])

    out = []
    for m in messages:
        msg = service.users().messages().get(userId="me", id=m["id"], format="full").execute()
        headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
        body_text = _extract_plain_text(msg["payload"])
        out.append({
            "id": m["id"],
            "subject": headers.get("subject", ""),
            "sender": headers.get("from", ""),
            "date": headers.get("date", ""),
            "body_text": body_text,
        })
    return out


def _extract_plain_text(payload: Dict[str, Any]) -> str:
    """Walks the MIME tree and returns the best plain-text body it can find,
    falling back to a stripped version of the HTML part."""
    def _decode(data: str) -> str:
        try:
            return base64.urlsafe_b64decode(data.encode("utf-8")).decode("utf-8", errors="ignore")
        except Exception:
            return ""

    if "parts" in payload:
        text_part, html_part = None, None
        for part in payload["parts"]:
            mime = part.get("mimeType", "")
            data = part.get("body", {}).get("data")
            if mime == "text/plain" and data:
                text_part = _decode(data)
            elif mime == "text/html" and data:
                html_part = _decode(data)
            elif "parts" in part:
                nested = _extract_plain_text(part)
                if nested:
                    text_part = text_part or nested
        if text_part:
            return text_part
        if html_part:
            return re.sub(r"<[^>]+>", " ", html_part)
        return ""

    data = payload.get("body", {}).get("data")
    if data:
        raw = _decode(data)
        if payload.get("mimeType") == "text/html":
            return re.sub(r"<[^>]+>", " ", raw)
        return raw
    return ""


# ---------------------------------------------------------------------------
# Parsing — amount, merchant, direction (debit/credit)
# ---------------------------------------------------------------------------

_AMOUNT_RE = re.compile(r"(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)", re.IGNORECASE)
_DEBIT_WORDS = re.compile(r"\b(debited|spent|paid|payment of|purchase of)\b", re.IGNORECASE)
_CREDIT_WORDS = re.compile(r"\b(credited|received|refund of)\b", re.IGNORECASE)
_MERCHANT_AT_RE = re.compile(r"\bat\s+([A-Z0-9][A-Za-z0-9&.\-\* ]{2,40})", re.IGNORECASE)
_MERCHANT_TO_RE = re.compile(r"\bto\s+([A-Z0-9][A-Za-z0-9&.\-\* ]{2,40})", re.IGNORECASE)

# Category names are the Hisaab ledger's own (twin-app/js/startup.js
# HISAAB_CATEGORIES), so an imported row edits cleanly in the ledger and the
# Compliance Center's GST and TDS estimates recognise it. Rows imported before
# this used short names ("Rent", "Utilities", "Travel"); compliance_config folds
# those onto these.
CATEGORY_KEYWORDS = {
    "Software/Tools": ["aws", "google cloud", "azure", "digitalocean", "github", "notion", "figma", "openai", "vercel"],
    "Travel & Transport": ["uber", "ola", "irctc", "makemytrip", "goibibo", "indigo", "airline"],
    "Marketing": ["google ads", "facebook ads", "meta ads", "linkedin ads"],
    "Payroll": ["salary", "payroll"],
    "Rent / Housing": ["rent", "lease"],
    "Utilities & Bills": ["electricity", "airtel", "jio", "internet", "broadband"],
    "Supplies": ["amazon", "flipkart"],
    "Other expense": ["swiggy", "zomato", "myntra"],
}

# Credits are categorised on the whole message, not the merchant, because the
# signal ("refund", "interest", a payment-gateway settlement) is in the wording.
# Only unambiguous signals are used; anything else stays Uncategorized for the
# founder to decide, since calling a credit a sale changes their GST estimate.
CREDIT_CATEGORY_KEYWORDS = [
    ("Refund", ["refund", "reversal", "chargeback"]),
    ("Interest income", ["interest credited", "interest paid", "interest on"]),
    ("Revenue", ["settlement", "razorpay", "cashfree", "payu", "stripe", "instamojo", "ccavenue", "paypal"]),
]


def _guess_category(merchant: str, direction: str = "out", text: str = "") -> str:
    if direction == "in":
        haystack = f"{merchant} {text}".lower()
        for category, keywords in CREDIT_CATEGORY_KEYWORDS:
            if any(k in haystack for k in keywords):
                return category
        return "Uncategorized"
    m = (merchant or "").lower()
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(k in m for k in keywords):
            return category
    return "Uncategorized"


def parse_transaction_email(msg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Returns a candidate transaction dict, or None if this message doesn't
    confidently look like a transaction (never guesses a number)."""
    text = f"{msg['subject']} {msg['body_text']}"

    amount_match = _AMOUNT_RE.search(text)
    if not amount_match:
        return None
    try:
        amount = float(amount_match.group(1).replace(",", ""))
    except ValueError:
        return None
    if amount <= 0:
        return None

    if _DEBIT_WORDS.search(text):
        direction = "out"
    elif _CREDIT_WORDS.search(text):
        direction = "in"
    else:
        return None  # Can't tell direction confidently — skip rather than guess.

    merchant_match = _MERCHANT_AT_RE.search(text) or _MERCHANT_TO_RE.search(text)
    merchant = merchant_match.group(1).strip() if merchant_match else msg["sender"].split("<")[0].strip()
    merchant = merchant[:60]

    return {
        "gmail_message_id": msg["id"],
        "type": direction,
        "amount": round(amount, 2),
        "category": _guess_category(merchant, direction, text),
        "description": f"Auto-detected: {merchant}",
        "merchant": merchant,
        "raw_subject": msg["subject"],
        "raw_sender": msg["sender"],
    }


def parse_candidate_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    for msg in messages:
        parsed = parse_transaction_email(msg)
        if parsed:
            out.append(parsed)
    return out