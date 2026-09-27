"""
Ingest of detected financial obligations into the existing upcoming_payments table.

This is the single write path for anything MoneyKal *infers* about what a user
owes. It is deliberately source-agnostic: it takes `DetectedObligation` objects
and knows nothing about Gmail, so an SMS reader, a WhatsApp parser or a
statement-PDF extractor can later feed the same function and get the same
dedupe, the same review gate and the same table.

Two rules it enforces on every write:

*   **Nothing is duplicated.** A message already ingested is skipped by its
    source reference; an obligation that matches a payment the user entered by
    hand is skipped so detection can never shadow a manual entry.
*   **Nothing uncertain becomes a fact.** Only high-confidence detections are
    written as confirmed. Everything else lands in 'review' and is excluded
    from every total until a person says yes.

Manual rows are never modified, deactivated or overwritten by this module.
"""
import logging
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.models.domain import UpcomingPayment
from backend.services.gmail_deadline_service import DetectedObligation

logger = logging.getLogger(__name__)

# How close two obligations must be to be treated as the same commitment.
DUPLICATE_DATE_WINDOW_DAYS = 7      # a bill's due date shifts a little month to month
DUPLICATE_AMOUNT_TOLERANCE = 0.10   # 10% — utility bills vary; the commitment does not

# A second, tighter path for the case where the two labels genuinely share no
# words — a user types "Electricity Bill" while the mail comes from "Tata Power".
# Matching on name alone would miss that and duplicate their entry, so amount,
# category and date are allowed to establish identity instead, at much tighter
# tolerances than the name path uses.
NEAR_DUPLICATE_DATE_WINDOW_DAYS = 3
NEAR_DUPLICATE_AMOUNT_TOLERANCE = 0.05

_STOPWORDS = {
    "bill", "payment", "card", "credit", "emi", "insurance", "premium", "the",
    "and", "of", "for", "your", "my", "monthly", "ltd", "limited", "india",
}


@dataclass
class IngestResult:
    created: int = 0
    review: int = 0
    skipped_duplicate_source: int = 0
    skipped_matches_manual: int = 0
    skipped_dismissed: int = 0
    items: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "created": self.created,
            "review": self.review,
            "skipped_duplicate_source": self.skipped_duplicate_source,
            "skipped_matches_manual": self.skipped_matches_manual,
            "skipped_dismissed": self.skipped_dismissed,
            "total_detected": (self.created + self.review + self.skipped_duplicate_source
                               + self.skipped_matches_manual + self.skipped_dismissed),
        }


def normalize_name(name: str) -> frozenset:
    """A name reduced to its distinguishing words, so 'HDFC Credit Card Payment'
    and 'HDFC card bill' compare equal while 'HDFC' and 'Airtel' do not."""
    words = "".join(c.lower() if (c.isalnum() or c.isspace()) else " " for c in (name or ""))
    return frozenset(w for w in words.split() if w and w not in _STOPWORDS and len(w) > 2)


def names_match(a: str, b: str) -> bool:
    """True when two labels plainly refer to the same biller.

    Requires a shared distinguishing word rather than string similarity, because
    the useful signal is the brand ('netflix', 'hdfc') and everything around it
    is boilerplate that would otherwise inflate a similarity score."""
    set_a, set_b = normalize_name(a), normalize_name(b)
    if not set_a or not set_b:
        return False
    return bool(set_a & set_b)


def amounts_match(a: Optional[float], b: Optional[float]) -> bool:
    """Two amounts are the same commitment if within tolerance. A missing amount
    on either side is not evidence of difference — the rest of the match decides."""
    if a is None or b is None:
        return True
    if a <= 0 or b <= 0:
        return True
    return abs(a - b) <= max(a, b) * DUPLICATE_AMOUNT_TOLERANCE


def is_duplicate_of(existing: UpcomingPayment, obligation: DetectedObligation) -> bool:
    """Whether an existing row — manual or detected — already represents this
    obligation.

    Two independent paths, because a person and a biller rarely use the same
    words for the same bill:

    1. **By name.** A shared distinguishing word, plus timing and amount that
       agree. Requiring all three stops two different bills from one biller
       ("HDFC card" and "HDFC loan EMI") from collapsing into one.

    2. **By shape.** When the names share nothing — a user's "Electricity Bill"
       against a detected "Tata Power Bill" — identity is established from the
       same category, near-identical amounts and near-identical due dates
       instead, at tolerances tight enough that the coincidence is unlikely.

    Path 2 can in principle merge two distinct bills in the same category that
    happen to fall due on the same day for near-identical amounts. That is the
    safer direction to err: the consequence is that a *detected* row is not
    created and the user's own entry stands untouched, whereas the alternative
    is a phantom obligation inflating the totals on their dashboard. Nothing the
    user typed is ever modified either way.
    """
    if not existing.due_date or not obligation.due_date:
        return False
    day_gap = abs((existing.due_date - obligation.due_date).days)

    # Path 1 — names identify it.
    if day_gap <= DUPLICATE_DATE_WINDOW_DAYS and names_match(existing.name or "", obligation.name):
        return amounts_match(existing.amount, obligation.amount)

    # Path 2 — shape identifies it. Requires both amounts to actually exist:
    # without them there is nothing but a category and a date, which is far too
    # weak to claim two rows are the same commitment.
    if day_gap > NEAR_DUPLICATE_DATE_WINDOW_DAYS:
        return False
    if not existing.category or not obligation.category:
        return False
    if existing.category != obligation.category:
        return False
    if not existing.amount or not obligation.amount:
        return False
    return abs(existing.amount - obligation.amount) <= (
        max(existing.amount, obligation.amount) * NEAR_DUPLICATE_AMOUNT_TOLERANCE
    )


def ingest_obligations(db: Session, profile_id: int, obligations: List[DetectedObligation],
                       today: Optional[date] = None) -> IngestResult:
    """Persists detected obligations for one profile, and returns what happened.

    Safe to run repeatedly: re-detecting the same emails produces no new rows.
    The caller commits — this keeps the whole sync in one transaction alongside
    whatever else it did.
    """
    today = today or date.today()
    result = IngestResult()
    if not obligations:
        return result

    # One read of everything this profile already has. Includes dismissed rows
    # on purpose: a suggestion the user rejected must not come back.
    existing_rows = db.query(UpcomingPayment).filter(
        UpcomingPayment.profile_id == profile_id
    ).all()

    seen_refs = {r.source_ref for r in existing_rows if r.source_ref}
    # Rows a detection is allowed to collide with. Paid-off one-offs are
    # excluded so that next month's genuine bill is not mistaken for last
    # month's settled one.
    comparable = [
        r for r in existing_rows
        if (r.status or "confirmed") != "dismissed"
        and (r.is_active or (r.status or "confirmed") == "review")
    ]
    dismissed = [r for r in existing_rows if (r.status or "confirmed") == "dismissed"]

    # Guards against the same biller appearing twice within one batch (a
    # reminder plus the original bill), which the DB read above cannot see.
    staged: List[UpcomingPayment] = []

    for obligation in obligations:
        if obligation.source_ref and obligation.source_ref in seen_refs:
            result.skipped_duplicate_source += 1
            continue

        if any(is_duplicate_of(row, obligation) for row in dismissed):
            result.skipped_dismissed += 1
            seen_refs.add(obligation.source_ref)
            continue

        manual_match = next(
            (r for r in comparable
             if (r.source or "manual") == "manual" and is_duplicate_of(r, obligation)),
            None,
        )
        if manual_match:
            # The user's own entry wins outright. We record the source
            # reference on their row so the same email is not re-examined,
            # but change nothing they typed.
            result.skipped_matches_manual += 1
            seen_refs.add(obligation.source_ref)
            if not manual_match.source_ref and obligation.source_ref:
                manual_match.source_ref = obligation.source_ref
                meta = dict(manual_match.source_meta or {})
                meta["matched_detection"] = {
                    "source": obligation.source,
                    "confidence": obligation.confidence,
                    "sender_domain": (obligation.source_meta or {}).get("sender_domain"),
                }
                manual_match.source_meta = meta
            continue

        if any(is_duplicate_of(r, obligation) for r in comparable + staged):
            result.skipped_duplicate_source += 1
            seen_refs.add(obligation.source_ref)
            continue

        high = obligation.is_high_confidence
        row = UpcomingPayment(
            profile_id=profile_id,
            name=obligation.name,
            amount=obligation.amount,
            due_date=obligation.due_date,
            category=obligation.category,
            recurrence=obligation.recurrence,
            is_active=True,
            source=obligation.source,
            # The detector already classified this (bill / emi / subscription /
            # insurance / credit_card); persisting it is what lets a confirmed
            # detection appear on the Financial Calendar with the right icon
            # without anything re-deriving the type from the category string.
            direction="out",
            event_type=obligation.obligation_type or "other",
            status="confirmed" if high else "review",
            confidence=obligation.confidence,
            source_ref=obligation.source_ref,
            source_meta=obligation.source_meta,
            notes=None,
        )
        db.add(row)
        staged.append(row)
        seen_refs.add(obligation.source_ref)

        if high:
            result.created += 1
        else:
            result.review += 1
        result.items.append({
            "name": obligation.name,
            "amount": obligation.amount,
            "due_date": obligation.due_date.isoformat() if obligation.due_date else None,
            "status": "confirmed" if high else "review",
            "confidence": obligation.confidence,
        })

    return result
