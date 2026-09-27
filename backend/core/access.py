"""
Access control for paid actions — the one place every gate goes through.

MoneyKal is free to SEE and paid to ACT. So nothing here ever hides a figure,
an insight or a finding: it only stands in front of the *action* — automation,
imports, going past a free monthly allowance, or a pay-per-use service. A
route that shows data must never depend on anything in this module.

Three kinds of gate, all answering with 402 Payment Required so the client can
tell "you're not on the plan" apart from a genuine 403 and show an upgrade
prompt instead of an error:

    require_act(feature)         ACT-only actions         error: upgrade_required
    require_allowance(feature)   free monthly allowances  error: quota_exceeded
    require_service(...)         pay-per-use services     error: purchase_required

Prices, limits and what ACT includes live in backend/core/config/pricing_config.py;
whether a user is on ACT is decided by subscription_service. This module only
combines the two, so a gate cannot drift from what the Plans & Billing page
tells the user.
"""
import logging
from dataclasses import dataclass
from datetime import datetime

from fastapi import Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.core.config import pricing_config as pricing
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import UsageCounter, User
from backend.services import billing_service, subscription_service

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# ACT-only actions
# ---------------------------------------------------------------------------

def upgrade_required(feature: str) -> HTTPException:
    return HTTPException(
        status_code=402,
        detail={
            "error": "upgrade_required",
            "feature": feature,
            "message": f"{pricing.ACT_FEATURES.get(feature, 'This')} is part of MoneyKal ACT.",
        },
    )


def has_act(db: Session, user_id: int) -> bool:
    return subscription_service.is_premium(db, user_id)


def check_act(db: Session, user_id: int, feature: str) -> None:
    """For callers outside a route (a redirect, a webhook, a job)."""
    if not has_act(db, user_id):
        raise upgrade_required(feature)


def require_act(feature: str):
    """Route dependency: the caller must be on ACT."""
    if feature not in pricing.ACT_FEATURES:
        raise ValueError(f"Unknown ACT feature {feature!r}; add it to pricing_config.ACT_FEATURES.")

    def dependency(current_user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)) -> User:
        check_act(db, current_user.id, feature)
        return current_user

    return dependency


# ---------------------------------------------------------------------------
# Free monthly allowances
# ---------------------------------------------------------------------------

@dataclass
class Allowance:
    """Permission for one use of a metered feature, handed to the route.

    The route calls `record()` only once the work has actually succeeded, so a
    question that fails on our side never costs the user part of their
    allowance. Uses on ACT are recorded too — the count is what the Plans &
    Billing page shows — they are just never limited.
    """
    db: Session
    user_id: int
    feature_key: str
    unlimited: bool

    def record(self) -> None:
        # Counting must never cost the user an answer they already have: a
        # failure here is logged and the response still goes out.
        try:
            record_usage(self.db, self.user_id, self.feature_key)
        except Exception:
            self.db.rollback()
            logger.exception("Could not record %s usage for user %s", self.feature_key, self.user_id)


def quota_exceeded(feature_key: str, used: int) -> HTTPException:
    quota = pricing.FREE_QUOTAS[feature_key]
    now = datetime.utcnow()
    return HTTPException(
        status_code=402,
        detail={
            "error": "quota_exceeded",
            "feature": feature_key,
            "limit": quota["limit"],
            "used": used,
            "period": billing_service.current_period(now),
            "resets_on": billing_service.next_period_start(now).isoformat(),
            "message": f"You have used this month's free {quota['label']}.",
        },
    )


def require_allowance(feature_key: str):
    """Route dependency: SEE users must have allowance left this month."""
    if feature_key not in pricing.FREE_QUOTAS:
        raise ValueError(f"Unknown allowance {feature_key!r}; add it to pricing_config.FREE_QUOTAS.")

    def dependency(current_user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)) -> Allowance:
        unlimited = has_act(db, current_user.id)
        if not unlimited:
            used = billing_service.usage_used(db, current_user.id, feature_key)
            if used >= pricing.FREE_QUOTAS[feature_key]["limit"]:
                raise quota_exceeded(feature_key, used)
        return Allowance(db=db, user_id=current_user.id, feature_key=feature_key, unlimited=unlimited)

    return dependency


def record_usage(db: Session, user_id: int, feature_key: str, amount: int = 1) -> None:
    """Add to this month's count.

    An in-place UPDATE (count = count + 1) rather than read-then-write, so two
    requests finishing together both count. Call it after the route's own
    commit: it commits, and on the first use of a month it may roll back a
    losing insert race.
    """
    period = billing_service.current_period()

    def bump() -> int:
        return (
            db.query(UsageCounter)
            .filter(
                UsageCounter.user_id == user_id,
                UsageCounter.feature_key == feature_key,
                UsageCounter.period == period,
            )
            .update(
                {UsageCounter.count: UsageCounter.count + amount,
                 UsageCounter.updated_at: datetime.utcnow()},
                synchronize_session=False,
            )
        )

    if bump():
        db.commit()
        return
    db.add(UsageCounter(user_id=user_id, feature_key=feature_key, period=period, count=amount))
    try:
        db.commit()
    except IntegrityError:
        # Another request created this month's row first; count onto it.
        db.rollback()
        bump()
        db.commit()


# ---------------------------------------------------------------------------
# Pay-per-use services
# ---------------------------------------------------------------------------

def purchase_required(sku: str, subject_ref: str) -> HTTPException:
    service = pricing.SERVICES[sku]
    return HTTPException(
        status_code=402,
        detail={
            "error": "purchase_required",
            "sku": sku,
            "subject_ref": subject_ref,
            "price_minor": service["price_minor"],
            "included_in_act": service["included_in_act"],
            "message": f"Unlock the {service['label']} for {subject_ref}.",
        },
    )


def has_service(db: Session, user_id: int, sku: str, subject_ref: str) -> bool:
    return billing_service.has_service(db, user_id, sku, subject_ref)


def require_service(db: Session, user_id: int, sku: str, subject_ref: str) -> None:
    """The caller must have bought this subject, or be on ACT where it is included.

    Called inside the route rather than as a dependency, because the subject
    (e.g. which tax year) usually comes from the request body.
    """
    if not has_service(db, user_id, sku, subject_ref):
        raise purchase_required(sku, subject_ref)
