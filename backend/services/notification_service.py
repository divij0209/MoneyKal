"""
Notification service — MoneyKal's notification inbox.

This is general infrastructure, not a Split component. Before it, the codebase
had no stored notification of any kind: `Alert` rows are computed live for the
startup dashboard and never persisted, and `whatsapp_service.send_message` is
fire-and-forget with no record that anything was sent. Anything that needed to
tell a user something after the fact had nowhere to put it.

So this module owns two things and nothing else:

* **Persisting** a notification to the recipient's inbox, with read/unread
  state and a deep link.
* **Fanning it out** to whatever delivery channels that user has enabled,
  reusing the existing `whatsapp_service` rather than adding a second push path.

Preferences are checked here, once, at the point of creation. Putting the check
in the producers instead would mean every future feature that notifies has to
remember to ask — and the one that forgets is the one that spams a user who
opted out.
"""
import logging
from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional

from sqlalchemy.orm import Session

from backend.models.domain import (
    Notification, NotificationPreference, Profile, User,
)

logger = logging.getLogger(__name__)


# Which preference column gates which notification kind. A kind that is absent
# from this map is always delivered — the default is to notify, so forgetting to
# register a new kind fails toward the user hearing about their money rather
# than silently swallowing it.
_KIND_PREFERENCE = {
    "split_expense_added": "split_expense_added",
    "split_expense_updated": "split_expense_updated",
    "split_expense_deleted": "split_expense_updated",
    "split_settlement_received": "split_settlement",
    "split_settlement_recorded": "split_settlement",
    "split_group_invite": "split_group_activity",
    "split_group_member_added": "split_group_activity",
    "split_friend_added": "split_friend_activity",
    "split_friend_request": "split_friend_activity",
    "split_you_are_owed": "split_expense_added",
    "split_you_owe": "split_expense_added",
}

# Kinds that belong to the Split category as a whole, so the single
# `split_enabled` master switch can turn the lot off.
_SPLIT_PREFIX = "split_"

# The Daily AI Insight is not an event and does not belong in an inbox. It is a
# standing reading of the user's money, shown in the Overview's own Daily AI
# Insights section and regenerated on that section's schedule — putting it here
# would light the bell every morning for something the user did not do and
# cannot act on, and would bury the alerts that are events.
#
# Enforced at the single point where notifications are created rather than left
# to each producer to remember, because the producer that forgets is the one
# that floods the inbox. `insight_schedule_service` does not call notify() at
# all; this is the second lock on the same door.
_NEVER_NOTIFY_PREFIXES = ("daily_insight", "insight_")


def get_preferences(db: Session, user_id: int) -> NotificationPreference:
    """Fetch, creating defaults on first use.

    Lazy creation rather than a row per user at registration: it keeps
    /auth/register untouched for the existing web flow, and every account that
    predates this table behaves identically to a new one.
    """
    pref = db.query(NotificationPreference).filter(
        NotificationPreference.user_id == user_id
    ).first()
    if not pref:
        pref = NotificationPreference(user_id=user_id)
        db.add(pref)
        db.flush()
    return pref


def is_insight_kind(kind: str) -> bool:
    """Whether this kind is a Daily AI Insight and so must never be an inbox row."""
    k = str(kind or "").strip().lower()
    return any(k.startswith(p) for p in _NEVER_NOTIFY_PREFIXES)


def _allows(pref: NotificationPreference, kind: str) -> bool:
    if not pref.in_app_enabled:
        return False
    if kind.startswith(_SPLIT_PREFIX) and not pref.split_enabled:
        return False
    column = _KIND_PREFERENCE.get(kind)
    if column is None:
        return True
    return bool(getattr(pref, column, True))


def notify(
    db: Session,
    user_id: Optional[int],
    kind: str,
    title: str,
    body: Optional[str] = None,
    link_type: Optional[str] = None,
    link_id: Optional[Any] = None,
    meta: Optional[Dict] = None,
    whatsapp_text: Optional[str] = None,
) -> Optional[Notification]:
    """Write one notification, respecting the recipient's preferences.

    `user_id` is allowed to be None so callers can pass the result of resolving
    a participant to an account without branching: a guest has no account, so
    there is nobody to notify, and that is a normal outcome rather than an
    error. Returns None in that case.

    Never raises. A notification failing must not roll back the expense that
    triggered it — the money is the point, the message is the courtesy.
    """
    if not user_id:
        return None
    if is_insight_kind(kind):
        logger.warning(
            "Refused to create an inbox notification for insight kind=%s. Daily AI "
            "Insights render in the Overview's own section; see _NEVER_NOTIFY_PREFIXES.",
            kind,
        )
        return None
    try:
        pref = get_preferences(db, user_id)
        if not _allows(pref, kind):
            return None

        note = Notification(
            user_id=user_id,
            kind=kind,
            title=title,
            body=body,
            link_type=link_type,
            link_id=str(link_id) if link_id is not None else None,
            meta=meta or {},
        )
        db.add(note)
        db.flush()

        if pref.whatsapp_enabled and whatsapp_text:
            _send_whatsapp(db, user_id, whatsapp_text)

        return note
    except Exception:
        logger.exception("Failed to create notification kind=%s for user=%s", kind, user_id)
        return None


def notify_once_per_day(
    db: Session,
    user_id: Optional[int],
    kind: str,
    dedupe_key: str,
    **kwargs,
) -> Optional[Notification]:
    """`notify`, but at most once per calendar day for the same subject.

    The scheduler's jobs are polls, not events: the budget check runs seven
    times a day and the bill sweep twice, and each one re-observes the same
    standing condition. Without this, "Groceries budget 92% used" would arrive
    seven times before dinner.

    `dedupe_key` is what identifies the subject — a budget goal id, a payment
    id — and is stored in `meta.dedupe` so the lookup is a single indexed scan
    on (user, kind) plus a cheap JSON comparison in Python. That is deliberate:
    the alternative is a schema change to add a column and an index for
    something only the polling producers need.
    """
    if not user_id:
        return None
    try:
        since = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        recent = db.query(Notification).filter(
            Notification.user_id == user_id,
            Notification.kind == kind,
            Notification.created_at >= since,
        ).all()
        for note in recent:
            if (note.meta or {}).get("dedupe") == dedupe_key:
                return None
    except Exception:
        # A failed dedupe check must not cost the user the notification; the
        # worst case is a duplicate row, which is better than silence.
        logger.exception("Dedupe lookup failed for kind=%s user=%s", kind, user_id)

    meta = dict(kwargs.pop("meta", None) or {})
    meta["dedupe"] = dedupe_key
    return notify(db, user_id, kind, meta=meta, **kwargs)


def notify_many(db: Session, user_ids: Iterable[Optional[int]], **kwargs) -> List[Notification]:
    """Same notification to several recipients. Duplicates and Nones are
    filtered, so callers can hand over a raw list of group members including
    guests and the actor themselves."""
    seen = set()
    out = []
    for uid in user_ids:
        if not uid or uid in seen:
            continue
        seen.add(uid)
        note = notify(db, uid, **kwargs)
        if note:
            out.append(note)
    return out


def _send_whatsapp(db: Session, user_id: int, text: str) -> None:
    """Best-effort push through the existing WhatsApp integration.

    Imported lazily because whatsapp_service reads credentials from the
    environment at import time; keeping it out of module scope means a
    deployment with no WhatsApp configured still imports this module cleanly.
    """
    try:
        profile = db.query(Profile).filter(Profile.user_id == user_id).first()
        if not profile or not profile.whatsapp_phone:
            return
        from backend.services import whatsapp_service
        whatsapp_service.send_message(profile.whatsapp_phone, text)
    except Exception:
        logger.exception("WhatsApp delivery failed for user=%s", user_id)


# ---------------------------------------------------------------------------
# Reading the inbox
# ---------------------------------------------------------------------------

def list_notifications(
    db: Session, user_id: int, unread_only: bool = False,
    limit: int = 50, offset: int = 0,
) -> List[Notification]:
    q = db.query(Notification).filter(Notification.user_id == user_id)
    if unread_only:
        q = q.filter(Notification.is_read == False)  # noqa: E712  (SQL, not Python truthiness)
    return q.order_by(Notification.created_at.desc(), Notification.id.desc()) \
            .offset(max(0, offset)).limit(min(200, max(1, limit))).all()


def unread_count(db: Session, user_id: int) -> int:
    return db.query(Notification).filter(
        Notification.user_id == user_id,
        Notification.is_read == False,  # noqa: E712
    ).count()


def mark_read(db: Session, user_id: int, notification_ids: Optional[List[int]] = None) -> int:
    """Mark some or all of a user's notifications read.

    The user_id filter is not redundant with the id filter — it is the
    authorization check. Without it, passing someone else's notification id
    would let a caller mark another account's inbox read.
    """
    q = db.query(Notification).filter(
        Notification.user_id == user_id,
        Notification.is_read == False,  # noqa: E712
    )
    if notification_ids:
        q = q.filter(Notification.id.in_(notification_ids))
    now = datetime.utcnow()
    count = 0
    for note in q.all():
        note.is_read = True
        note.read_at = now
        count += 1
    return count


def serialize(note: Notification) -> Dict:
    return {
        "id": note.id,
        "kind": note.kind,
        "title": note.title,
        "body": note.body,
        "link_type": note.link_type,
        "link_id": note.link_id,
        "meta": note.meta or {},
        "is_read": bool(note.is_read),
        "created_at": note.created_at.isoformat() if note.created_at else None,
    }
