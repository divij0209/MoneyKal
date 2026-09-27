"""
Financial deadline detection from Gmail.

This is the second reader of the SAME Gmail connection Hisaab already uses. It
adds no OAuth flow, no credentials, no token store and no scopes: the caller
hands it messages fetched with the existing `credentials_from_connection()` /
`gmail.readonly` setup, and this module only decides what those messages mean.

Where the Hisaab importer answers "what did I spend?", this answers "what do I
owe, and when?" — bill due dates, card statements, EMIs, subscription renewals
and insurance premiums.

Two properties matter more than coverage:

*   **It never invents a number.** A due date or amount is either found in the
    text or reported as absent. An email that yields neither is dropped.
*   **It reports how sure it is.** Every detection carries a 0-1 confidence and
    the list of signals behind it. The caller decides what to do with a weak
    one; this module never decides on its own that a guess is good enough.

Deliberately free of database and network imports so it can be unit-tested on
plain dicts, and so the same `DetectedObligation` shape can later be produced
from SMS, WhatsApp or a statement PDF and fed to the same ingest path.

Message fetching and MIME/HTML body extraction are NOT reimplemented here: the
caller obtains messages through the existing `fetch_candidate_messages()`, which
already walks the MIME tree via `_extract_plain_text()`. This module only takes
the {id, subject, sender, date, body_text} dicts that come out of it.
"""
import re
from dataclasses import dataclass, field, asdict
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional

__all__ = [
    "DetectedObligation", "build_deadline_query", "detect_obligation",
    "detect_obligations", "AUTO_CREATE_CONFIDENCE",
]

# At or above this, an obligation is trustworthy enough to appear as a real
# upcoming payment. Below it, the user is asked to confirm. Chosen so that a
# detection needs both a due date and an amount plus a recognised issuer or
# category before it can post itself into someone's finances unattended.
AUTO_CREATE_CONFIDENCE = 0.75


@dataclass
class DetectedObligation:
    """One financial deadline read out of a message.

    `source_ref` and `source_meta` are what gets persisted for provenance. The
    metadata is deliberately thin — sender domain, truncated subject, matched
    signals — never the message body.
    """
    name: str
    amount: Optional[float]
    due_date: Optional[date]
    category: str
    obligation_type: str            # bill | credit_card | emi | subscription | insurance | other
    recurrence: str                 # none | weekly | monthly | quarterly | yearly
    confidence: float
    source: str                     # 'gmail'
    source_ref: str                 # gmail message id
    source_meta: Dict[str, Any] = field(default_factory=dict)
    signals: List[str] = field(default_factory=list)

    @property
    def is_high_confidence(self) -> bool:
        return self.confidence >= AUTO_CREATE_CONFIDENCE

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["due_date"] = self.due_date.isoformat() if self.due_date else None
        d["is_high_confidence"] = self.is_high_confidence
        return d


# ---------------------------------------------------------------------------
# Server-side narrowing
#
# Gmail's `q` does the filtering before anything is downloaded, so a mailbox is
# never walked in bulk — the same approach build_gmail_query() already takes for
# transactions, with the vocabulary of obligations instead of spending.
# ---------------------------------------------------------------------------

BILLER_SENDER_HINTS = [
    # Utilities / telecom
    "tatapower.com", "adanielectricity.com", "bescom.org", "msedcl.in", "torrentpower.com",
    "airtel.com", "jio.com", "vodafoneidea.com", "actcorp.in",
    # Cards / banks (statement + due-date mail, distinct from debit alerts)
    "hdfcbank.net", "hdfcbank.com", "icicibank.com", "sbicard.com", "axisbank.com",
    "kotak.com", "amex.com", "onecard.in", "idfcfirstbank.com",
    # Subscriptions
    "netflix.com", "spotify.com", "primevideo.com", "hotstar.com", "youtube.com",
    "apple.com", "google.com", "adobe.com", "microsoft.com",
    # Insurance
    "licindia.com", "hdfclife.com", "iciciprulife.com", "maxlifeinsurance.com",
    "starhealth.in", "bajajallianz.com", "policybazaar.com",
]

DEADLINE_SUBJECT_HINTS = [
    "due", "due date", "payment due", "bill", "e-bill", "statement",
    "renewal", "renews", "auto-renew", "subscription", "premium",
    "emi", "installment", "instalment", "reminder", "outstanding",
    "pay now", "minimum amount due",
]


def build_deadline_query(since: Optional[datetime] = None, window_days: int = 30) -> str:
    """A Gmail search string restricted to billing-shaped mail in a recent window.

    Mirrors the structure of the existing `build_gmail_query` so both readers
    narrow the same way, and excludes the noisiest non-financial categories
    outright rather than downloading and discarding them."""
    since = since or (datetime.utcnow() - timedelta(days=window_days))
    date_str = since.strftime("%Y/%m/%d")
    sender_part = " OR ".join("from:%s" % s for s in BILLER_SENDER_HINTS)
    subject_part = " OR ".join('subject:"%s"' % s for s in DEADLINE_SUBJECT_HINTS)
    return (
        "((%s) OR (%s)) after:%s "
        "-category:promotions -category:social -in:spam -in:trash"
        % (sender_part, subject_part, date_str)
    )


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

# Ordered: the first match wins, so the more specific types are listed before
# the generic "bill". Each entry maps to (obligation_type, Hisaab category,
# default recurrence).
TYPE_RULES = [
    ("credit_card", "Other expense", "monthly", [
        # Deliberately excludes "total amount due" — utility, telecom and card
        # mail all use that phrase, so it identifies a bill, not a card. It was
        # here originally and misfiled every electricity bill as a card payment.
        # "minimum amount due" carries no such ambiguity.
        r"\bcredit card\b", r"\bcard statement\b", r"\bminimum amount due\b",
        r"\bsbi ?card\b", r"\bamex\b", r"\bonecard\b",
    ]),
    ("emi", "Other expense", "monthly", [
        r"\bemi\b", r"\binstall?ment\b", r"\bloan repayment\b", r"\bloan emi\b",
        r"\bauto ?debit.*loan\b",
    ]),
    ("insurance", "Health & Medical", "yearly", [
        r"\binsurance\b", r"\bpolicy (?:premium|renewal)\b", r"\bpremium due\b",
        r"\bsum assured\b", r"\bmediclaim\b",
    ]),
    ("subscription", "Subscriptions", "monthly", [
        r"\bsubscription\b", r"\brenew(?:s|al|ing)?\b", r"\bauto-?renew\b",
        r"\bmembership\b", r"\bplan will (?:renew|be charged)\b",
    ]),
    ("bill", "Utilities & Bills", "monthly", [
        r"\belectricity\b", r"\bpower bill\b", r"\bwater bill\b", r"\bgas bill\b",
        r"\bbroadband\b", r"\bpostpaid\b", r"\butility bill\b", r"\be-?bill\b",
        r"\bmobile bill\b", r"\bdth\b",
    ]),
]

# A message that looks like a completed payment is not an upcoming obligation.
# These are checked before anything else so a "payment received" receipt for a
# bill can never be turned into a future due date.
SETTLED_RE = re.compile(
    r"\b(payment (?:received|successful|confirmed)|thank you for (?:your )?payment|"
    r"successfully (?:paid|debited)|has been paid|receipt for your payment|"
    r"we have received your payment)\b",
    re.IGNORECASE,
)

DUE_CONTEXT_RE = re.compile(
    r"\b(due|payable|last date|pay by|before|renew(?:s|al)?|expires?|"
    r"charged on|next billing|auto-?debit(?:ed)? on)\b",
    re.IGNORECASE,
)


def classify(text: str) -> tuple:
    """(obligation_type, category, recurrence) — falls back to a generic
    one-off obligation when nothing specific matches."""
    lowered = text.lower()
    for obligation_type, category, recurrence, patterns in TYPE_RULES:
        for pattern in patterns:
            if re.search(pattern, lowered):
                return obligation_type, category, recurrence
    return "other", "Other expense", "none"


# ---------------------------------------------------------------------------
# Amount
# ---------------------------------------------------------------------------

# Same currency vocabulary the Hisaab parser uses. Amounts are only accepted
# when they sit near due/payable language, so a promotional "save Rs 500!" in
# the footer cannot be read as the bill.
_AMOUNT_RE = re.compile(r"(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)", re.IGNORECASE)

_AMOUNT_LABEL_RE = re.compile(
    r"(?:total amount due|amount due|amount payable|total due|bill amount|"
    r"payment due|minimum amount due|premium amount|emi amount|total payable|"
    r"you will be charged|will be charged)\s*[:\-]?\s*"
    r"(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)",
    re.IGNORECASE,
)


def extract_amount(text: str) -> tuple:
    """(amount, signal) — prefers a value sitting behind an explicit
    'amount due'-style label, which is far stronger evidence than any currency
    figure that happens to appear in the mail."""
    labelled = _AMOUNT_LABEL_RE.search(text)
    if labelled:
        try:
            value = float(labelled.group(1).replace(",", ""))
            if value > 0:
                return round(value, 2), "labelled_amount"
        except ValueError:
            pass

    # Otherwise accept a currency amount only if due-language is nearby.
    for match in _AMOUNT_RE.finditer(text):
        window = text[max(0, match.start() - 90): match.end() + 90]
        if DUE_CONTEXT_RE.search(window):
            try:
                value = float(match.group(1).replace(",", ""))
                if value > 0:
                    return round(value, 2), "contextual_amount"
            except ValueError:
                continue
    return None, None


# ---------------------------------------------------------------------------
# Due date
# ---------------------------------------------------------------------------

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# "25 Sep 2026" / "25 September" / "Sep 25, 2026" / "25-09-2026" / "2026-09-25"
_DATE_PATTERNS = [
    re.compile(r"\b(\d{1,2})[\s\-/]+([A-Za-z]{3,9})[\s\-/,]*(\d{4})?\b"),
    re.compile(r"\b([A-Za-z]{3,9})[\s\-/]+(\d{1,2})(?:st|nd|rd|th)?[\s\-/,]*(\d{4})?\b"),
    re.compile(r"\b(\d{4})-(\d{1,2})-(\d{1,2})\b"),
    re.compile(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b"),
]

_RELATIVE_RE = re.compile(r"\b(?:due|renews?|expires?|charged)\s+(today|tomorrow)\b", re.IGNORECASE)


def _build_date(day: int, month: int, year: Optional[int], today: date) -> Optional[date]:
    """Resolves a parsed day/month, inferring the year when the mail omits it.

    A bare '25 Sep' means the next 25 Sep — but a bill dated a few days ago is
    still current, so the previous occurrence is kept when it is recent rather
    than rolling a just-passed date a whole year forward."""
    if not (1 <= month <= 12):
        return None
    try:
        if year:
            return date(year, month, day)
        candidate = date(today.year, month, day)
        if candidate < today - timedelta(days=7):
            candidate = date(today.year + 1, month, day)
        return candidate
    except ValueError:
        return None


def _parse_one(match, pattern_index: int, today: date) -> Optional[date]:
    groups = match.groups()
    try:
        if pattern_index == 0:
            month = _MONTHS.get(groups[1][:4].lower()) or _MONTHS.get(groups[1][:3].lower())
            if not month:
                return None
            return _build_date(int(groups[0]), month, int(groups[2]) if groups[2] else None, today)
        if pattern_index == 1:
            month = _MONTHS.get(groups[0][:4].lower()) or _MONTHS.get(groups[0][:3].lower())
            if not month:
                return None
            return _build_date(int(groups[1]), month, int(groups[2]) if groups[2] else None, today)
        if pattern_index == 2:
            return date(int(groups[0]), int(groups[1]), int(groups[2]))
        # dd/mm/yyyy — Indian convention, matching the rest of the app
        return _build_date(int(groups[0]), int(groups[1]), int(groups[2]), today)
    except (ValueError, TypeError, IndexError):
        return None


def extract_due_date(text: str, today: Optional[date] = None, horizon_days: int = 120) -> tuple:
    """(due_date, signal) — only dates that appear in due-language context and
    fall inside a sensible forward window are accepted.

    A statement mail is full of dates (transaction dates, statement period,
    generated-on); requiring the surrounding words to be about paying is what
    separates the deadline from the rest."""
    today = today or date.today()

    relative = _RELATIVE_RE.search(text)
    if relative:
        offset = 0 if relative.group(1).lower() == "today" else 1
        return today + timedelta(days=offset), "relative_date"

    best = None
    for index, pattern in enumerate(_DATE_PATTERNS):
        for match in pattern.finditer(text):
            window = text[max(0, match.start() - 70): match.end() + 40]
            if not DUE_CONTEXT_RE.search(window):
                continue
            parsed = _parse_one(match, index, today)
            if not parsed:
                continue
            # Accept a slightly-past date (a bill issued last week is still the
            # current one) but never a date beyond the forward horizon.
            if parsed < today - timedelta(days=7):
                continue
            if parsed > today + timedelta(days=horizon_days):
                continue
            if best is None or parsed < best:
                best = parsed
    return (best, "contextual_date") if best else (None, None)


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------

_SENDER_NAME_RE = re.compile(r"^\s*\"?([^\"<]+?)\"?\s*<")
_NOISE_RE = re.compile(r"\b(no[-_ ]?reply|noreply|alerts?|info|mailer|support|billing|statements?)\b", re.IGNORECASE)


def sender_domain(sender: str) -> str:
    match = re.search(r"@([\w.\-]+)", sender or "")
    return match.group(1).lower() if match else ""


def derive_name(msg: Dict[str, Any], obligation_type: str) -> str:
    """A short human label — the biller's display name where the header gives a
    usable one, otherwise the second-level domain, which is nearly always the
    brand ('netflix.com' -> 'Netflix')."""
    raw_sender = msg.get("sender", "") or ""
    display = ""
    name_match = _SENDER_NAME_RE.match(raw_sender)
    if name_match:
        display = _NOISE_RE.sub("", name_match.group(1)).strip(" -_|")

    if not display:
        domain = sender_domain(raw_sender)
        if domain:
            parts = [p for p in domain.split(".") if p not in ("com", "in", "co", "net", "org", "www")]
            display = parts[-1].title() if parts else domain

    display = re.sub(r"\s{2,}", " ", display).strip()
    if not display:
        display = (msg.get("subject") or "Payment").strip()

    suffix = {
        "credit_card": " Card Payment",
        "emi": " EMI",
        "insurance": " Insurance",
        "subscription": "",
        "bill": " Bill",
        "other": " Payment",
    }.get(obligation_type, "")

    name = (display + suffix).strip()
    # Avoid "Netflix Bill Bill" when the brand already says it.
    if suffix and display.lower().endswith(suffix.strip().lower()):
        name = display
    return name[:80]


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def score_confidence(has_amount: bool, has_due_date: bool, amount_signal: Optional[str],
                     date_signal: Optional[str], known_sender: bool,
                     obligation_type: str) -> float:
    """A transparent additive score rather than a learned one, so a low-confidence
    result can always be explained to the user in terms of what was missing.

    The weights are set so that the only way to clear AUTO_CREATE_CONFIDENCE is
    to have BOTH a due date and an amount, plus either a recognised biller or a
    clearly identified obligation type. Anything less goes to review."""
    score = 0.0
    if has_due_date:
        score += 0.34 if date_signal == "contextual_date" else 0.30
    if has_amount:
        score += 0.30 if amount_signal == "labelled_amount" else 0.22
    if known_sender:
        score += 0.20
    if obligation_type != "other":
        score += 0.14
    return round(min(score, 1.0), 2)


def detect_obligation(msg: Dict[str, Any], today: Optional[date] = None) -> Optional[DetectedObligation]:
    """Reads one message into a DetectedObligation, or returns None.

    `msg` is the shape the existing `fetch_candidate_messages()` already
    produces: {id, subject, sender, date, body_text}."""
    today = today or date.today()
    subject = msg.get("subject") or ""
    body = msg.get("body_text") or ""
    sender = msg.get("sender") or ""
    text = "%s\n%s" % (subject, body)

    # A receipt for something already paid is not an upcoming obligation.
    if SETTLED_RE.search(text):
        return None

    # Something in the mail has to be about a deadline at all.
    if not DUE_CONTEXT_RE.search(text):
        return None

    obligation_type, category, recurrence = classify(text)
    amount, amount_signal = extract_amount(text)
    due_date, date_signal = extract_due_date(text, today=today)

    # With neither a date nor an amount there is nothing worth showing, even as
    # a suggestion — a bare "your bill is ready" is not actionable.
    if due_date is None and amount is None:
        return None
    # A due date is the whole point of this feature; an amount alone cannot
    # place an item on a timeline.
    if due_date is None:
        return None

    domain = sender_domain(sender)
    known_sender = any(hint in domain for hint in BILLER_SENDER_HINTS) if domain else False

    signals = [s for s in (amount_signal, date_signal) if s]
    if known_sender:
        signals.append("known_biller")
    if obligation_type != "other":
        signals.append("type:%s" % obligation_type)

    confidence = score_confidence(
        has_amount=amount is not None, has_due_date=due_date is not None,
        amount_signal=amount_signal, date_signal=date_signal,
        known_sender=known_sender, obligation_type=obligation_type,
    )

    return DetectedObligation(
        name=derive_name(msg, obligation_type),
        amount=amount,
        due_date=due_date,
        category=category,
        obligation_type=obligation_type,
        recurrence=recurrence,
        confidence=confidence,
        source="gmail",
        source_ref=msg.get("id") or "",
        # Provenance only. The body is never carried here, and the subject is
        # truncated to what a person needs to recognise the mail.
        source_meta={
            "sender_domain": domain,
            "subject": subject[:140],
            "detected_at": datetime.utcnow().isoformat(),
            "signals": signals,
        },
        signals=signals,
    )


def detect_obligations(messages: List[Dict[str, Any]], today: Optional[date] = None) -> List[DetectedObligation]:
    """Maps a batch of messages to obligations, skipping anything unreadable.

    One malformed message must never abort a whole sync."""
    out: List[DetectedObligation] = []
    for msg in messages or []:
        try:
            detected = detect_obligation(msg, today=today)
        except Exception:
            detected = None
        if detected:
            out.append(detected)
    return out
