"""
Kal Coins — the reward and discount ledger.

What coins are, and must stay (MoneyKal Business Model v2):
  * earned only for actions the app can verify from its own records;
  * worth a fixed ₹0.10 each (pricing_config.COIN_VALUE_MINOR);
  * redeemable only against MoneyKal's own fees, at checkout;
  * never bought, sent to another user, gifted, or turned into cash.

Those last two lines are what keep coins outside PPI (Prepaid Payment
Instrument) licensing. This module therefore has no function that moves coins
between users or out of MoneyKal, and none should ever be added. A refund of an
order paid partly in coins must return the coins to the ledger and only the
cash part to the payment method; coins are never converted to money.

Every balance change goes through `_apply`, which updates users.kal_coin_balance
and appends one CoinTransaction row in the same database transaction. The
ledger is the record; the balance column is a cache of its sum, and
`ledger_balance` exists so the two can be reconciled.

Earning rules (pricing_config.COIN_RULES):
  profile_completed  once per account, when onboarding has been filled in
  friend_invite      per friend who joined through your Money Splits invite and
                     then really used MoneyKal for 30 days; at most 10 a month
  act_yearly         per paid ACT Yearly order (granted inside checkout)

Rewards that depend on time passing (a friend's 30 days) are checked when the
user's billing state is read, rather than by a background job: the scheduler is
off on most machines, and a check that runs when the user looks is both prompt
enough and idempotent.
"""
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.core.config import pricing_config as pricing
from backend.models.domain import (
    ChatMessage, ChatSession, CoinTransaction, Profile, SplitExpense, SplitInvitation,
    SplitPerson, StartupTransaction, User,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Balance and ledger
# ---------------------------------------------------------------------------

def balance(db: Session, user_id: int) -> int:
    return db.query(User.kal_coin_balance).filter(User.id == user_id).scalar() or 0


def ledger_balance(db: Session, user_id: int) -> int:
    """The balance the ledger adds up to. Must always equal `balance`."""
    return db.query(func.coalesce(func.sum(CoinTransaction.coins), 0)).filter(
        CoinTransaction.user_id == user_id).scalar() or 0


def value_minor(coins: int) -> int:
    return coins * pricing.COIN_VALUE_MINOR


def _apply(db: Session, user_id: int, coins: int, type_: str, reason: str, key: str,
           source_type: Optional[str] = None, source_id: Optional[int] = None,
           meta: Optional[Dict] = None, require_funds: bool = False) -> Optional[CoinTransaction]:
    """Change the balance and append its ledger row, in the caller's transaction.

    Does not commit. The balance moves with an in-place UPDATE, and a debit
    carries `balance >= amount` in its WHERE clause, so two checkouts spending
    the same coins at once cannot both succeed and a balance can never go
    below zero. Returns None when `require_funds` and the balance is short.

    Flushing a duplicate `key` raises IntegrityError; the caller must roll
    back, which also undoes the balance change above.
    """
    query = db.query(User).filter(User.id == user_id)
    if require_funds:
        query = query.filter(User.kal_coin_balance >= -coins)
    if not query.update({User.kal_coin_balance: User.kal_coin_balance + coins}, synchronize_session=False):
        return None

    row = CoinTransaction(
        user_id=user_id,
        type=type_,
        reason=reason,
        coins=coins,
        balance_after=balance(db, user_id),
        source_type=source_type,
        source_id=source_id,
        idempotency_key=key,
        meta=meta or {},
    )
    db.add(row)
    db.flush()
    return row


def _granted(db: Session, key: str) -> bool:
    return db.query(CoinTransaction.id).filter(CoinTransaction.idempotency_key == key).first() is not None


def _earn_and_commit(db: Session, user_id: int, reason: str, key: str,
                     source_type: str, source_id: int, meta: Optional[Dict] = None) -> int:
    """Grant a reward in its own commit. Returns coins credited (0 if already granted).

    Call only with nothing else pending on the session: a lost race on the
    idempotency key rolls the session back.
    """
    if _granted(db, key):
        return 0
    coins = pricing.COIN_RULES[reason]["coins"]
    try:
        _apply(db, user_id, coins, "earn", reason, key, source_type, source_id, meta)
        db.commit()
    except IntegrityError:
        db.rollback()
        return 0
    return coins


# ---------------------------------------------------------------------------
# Checkout
# ---------------------------------------------------------------------------

def quote(gross_minor: int, available: int) -> Tuple[int, int]:
    """(coins to use, discount in paise) for a price, never more than the price."""
    most = gross_minor // pricing.COIN_VALUE_MINOR
    coins = max(0, min(available, most))
    return coins, value_minor(coins)


def redeem_for_order(db: Session, user_id: int, order_id: int, coins: int) -> bool:
    """Spend coins on an order, in the caller's transaction. False if the balance is short."""
    if coins <= 0:
        return True
    return _apply(
        db, user_id, -coins, "redeem", "checkout", f"redeem:order:{order_id}",
        source_type="billing_order", source_id=order_id, require_funds=True,
    ) is not None


def reward_act_yearly(db: Session, user_id: int, order_id: int) -> None:
    """ACT Yearly reward, in the caller's (checkout) transaction."""
    _apply(
        db, user_id, pricing.COIN_RULES["act_yearly"]["coins"], "earn", "act_yearly",
        f"act_yearly:order:{order_id}", source_type="billing_order", source_id=order_id,
    )


# ---------------------------------------------------------------------------
# Earning checks
# ---------------------------------------------------------------------------

def _persona(db: Session, user_id: int) -> Tuple[Optional[Profile], Optional[str]]:
    from backend.services.billing_service import persona_for
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    return profile, persona_for(profile)


def _profile_complete(profile: Optional[Profile], persona: Optional[str]) -> bool:
    """Onboarding has actually been filled in, not just a profile row created."""
    if not profile:
        return False
    if persona == "individual":
        return bool(profile.raw_inputs or profile.metrics)
    if profile.key == "startup":
        return profile.startup_profile is not None
    return False


def _friend_candidates(db: Session, user_id: int) -> List[Tuple[User, SplitInvitation]]:
    """Friends who joined MoneyKal through this user's invitation.

    "Joined through" is strict: the invitation was accepted by that account, it
    is the earliest accepted invitation that account has (so only one inviter
    is ever credited for a friend), and the account was created after the
    invitation. Accounts older than the invitation — or so old their creation
    date is unknown — are people who already had MoneyKal, and never count.
    """
    me = db.query(SplitPerson).filter(SplitPerson.user_id == user_id).first()
    if not me:
        return []

    invites = (
        db.query(SplitInvitation)
        .filter(
            SplitInvitation.invited_by_person_id == me.id,
            SplitInvitation.status == "accepted",
            SplitInvitation.accepted_by_user_id.isnot(None),
            SplitInvitation.accepted_by_user_id != user_id,
        )
        .order_by(SplitInvitation.created_at)
        .all()
    )

    out, seen = [], set()
    for inv in invites:
        friend_id = inv.accepted_by_user_id
        if friend_id in seen:
            continue
        seen.add(friend_id)

        first = (
            db.query(SplitInvitation)
            .filter(SplitInvitation.accepted_by_user_id == friend_id, SplitInvitation.status == "accepted")
            .order_by(SplitInvitation.created_at, SplitInvitation.id)
            .first()
        )
        if not first or first.invited_by_person_id != me.id:
            continue

        friend = db.query(User).filter(User.id == friend_id).first()
        if not friend or not friend.created_at or not first.created_at:
            continue
        if friend.created_at < first.created_at:
            continue
        out.append((friend, first))
    return out


def _friend_activity(db: Session, friend_user_id: int, since: datetime) -> Tuple[int, int]:
    """(active days, entries) for a friend since they joined.

    Built only from rows the friend created: Hisaab entries and shared expenses
    count as entries and as active days; Tathya questions count as active days.
    Sign-ins are not recorded anywhere, so they cannot be used.
    """
    days, entries = set(), 0

    profile_ids = [pid for (pid,) in db.query(Profile.id).filter(Profile.user_id == friend_user_id).all()]
    if profile_ids:
        for (ts,) in db.query(StartupTransaction.created_at).filter(
                StartupTransaction.profile_id.in_(profile_ids), StartupTransaction.created_at >= since).all():
            entries += 1
            days.add(ts.date())
        for (ts,) in (db.query(ChatMessage.created_at)
                      .join(ChatSession, ChatSession.id == ChatMessage.session_id)
                      .filter(ChatSession.profile_id.in_(profile_ids), ChatMessage.role == "user",
                              ChatMessage.created_at >= since).all()):
            days.add(ts.date())

    person = db.query(SplitPerson).filter(SplitPerson.user_id == friend_user_id).first()
    if person:
        for (ts,) in db.query(SplitExpense.created_at).filter(
                SplitExpense.created_by_person_id == person.id,
                SplitExpense.is_deleted == False,  # noqa: E712
                SplitExpense.created_at >= since).all():
            entries += 1
            days.add(ts.date())

    return len(days), entries


def _month_start(now: datetime) -> datetime:
    return datetime(now.year, now.month, 1)


def sync_earnings(db: Session, user_id: int, now: Optional[datetime] = None) -> int:
    """Grant any reward this user has become entitled to. Returns coins credited.

    Idempotent: safe to call on every read. Commits per reward, so call it
    before any other work on the session.
    """
    now = now or datetime.utcnow()
    credited = 0
    profile, persona = _persona(db, user_id)

    if _profile_complete(profile, persona):
        credited += _earn_and_commit(db, user_id, "profile_completed", f"profile_completed:user:{user_id}",
                                     "profile", profile.id)

    rule = pricing.COIN_RULES["friend_invite"]
    if persona in rule["personas"]:
        this_month = db.query(func.count(CoinTransaction.id)).filter(
            CoinTransaction.user_id == user_id,
            CoinTransaction.reason == "friend_invite",
            CoinTransaction.created_at >= _month_start(now),
        ).scalar() or 0

        for friend, _invite in _friend_candidates(db, user_id):
            if this_month >= rule["monthly_limit"]:
                break  # the rest stay eligible and are credited next month
            key = f"friend_invite:user:{friend.id}"
            if _granted(db, key):
                continue
            if now < friend.created_at + timedelta(days=rule["wait_days"]):
                continue
            active_days, entries = _friend_activity(db, friend.id, friend.created_at)
            if active_days < rule["min_active_days"] or entries < rule["min_entries"]:
                continue
            got = _earn_and_commit(db, user_id, "friend_invite", key, "user", friend.id)
            if got:
                credited += got
                this_month += 1

    return credited


# ---------------------------------------------------------------------------
# What the client reads
# ---------------------------------------------------------------------------

def _earned_count(db: Session, user_id: int, reason: str) -> int:
    return db.query(func.count(CoinTransaction.id)).filter(
        CoinTransaction.user_id == user_id, CoinTransaction.reason == reason,
        CoinTransaction.type == "earn").scalar() or 0


def coins_state(db: Session, user_id: int, limit: int = 50) -> Dict:
    """Balance, how to earn (with this user's progress) and recent history.

    Friend progress is reported only as counts. How much a friend has used the
    app is theirs, so no per-friend activity is ever shown to the inviter.
    """
    profile, persona = _persona(db, user_id)
    bal = balance(db, user_id)

    rules = []
    rule = pricing.COIN_RULES["profile_completed"]
    rules.append({
        "key": "profile_completed",
        "label": rule["label"],
        "coins": rule["coins"],
        "status": "earned" if _earned_count(db, user_id, "profile_completed") else "available",
    })

    rule = pricing.COIN_RULES["friend_invite"]
    if persona in rule["personas"]:
        earned = _earned_count(db, user_id, "friend_invite")
        credited = {
            k for (k,) in db.query(CoinTransaction.idempotency_key).filter(
                CoinTransaction.user_id == user_id, CoinTransaction.reason == "friend_invite").all()
        }
        waiting = sum(1 for friend, _ in _friend_candidates(db, user_id)
                      if f"friend_invite:user:{friend.id}" not in credited)
        rules.append({
            "key": "friend_invite",
            "label": rule["label"],
            "coins": rule["coins"],
            "earned_count": earned,
            "waiting_count": waiting,
            "wait_days": rule["wait_days"],
            "min_active_days": rule["min_active_days"],
            "min_entries": rule["min_entries"],
            "monthly_limit": rule["monthly_limit"],
        })

    rule = pricing.COIN_RULES["act_yearly"]
    rules.append({
        "key": "act_yearly",
        "label": rule["label"],
        "coins": rule["coins"],
        "earned_count": _earned_count(db, user_id, "act_yearly"),
    })

    rows = (
        db.query(CoinTransaction)
        .filter(CoinTransaction.user_id == user_id)
        .order_by(CoinTransaction.created_at.desc(), CoinTransaction.id.desc())
        .limit(limit)
        .all()
    )
    return {
        "balance": bal,
        "value_minor": value_minor(bal),
        "coin_value_minor": pricing.COIN_VALUE_MINOR,
        "rules": rules,
        "history": [
            {
                "id": r.id,
                "type": r.type,
                "reason": r.reason,
                "coins": r.coins,
                "balance_after": r.balance_after,
                "source_type": r.source_type,
                "source_id": r.source_id,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }
