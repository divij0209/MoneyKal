"""
Subscription and entitlements — MoneyKal's plan gate.

Also general infrastructure rather than a Split component. The codebase had no
concept of a plan before this, so rather than build a Split-only paywall this
models the account-level subscription that any feature can ask about.

The design rule that matters here: **no row means free, and free is a complete,
working product.** Every account that exists today has no subscription row, and
must keep working exactly as it does now. Entitlement is therefore resolved by
asking "does this user have a live premium subscription?" and defaulting to no,
never by requiring a row to be present.

What is *not* gated is as much a decision as what is. The Split loop — groups,
friends, invitations, expenses, every split mode, balances, settlements — is
free on purpose: it is the part of the product that spreads, and a paywall on
an invite is a paywall on growth. Premium buys analysis and automation on top.
"""
import logging
from datetime import datetime
from typing import Dict, Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from backend.core.config import pricing_config as pricing
from backend.models.domain import Subscription

logger = logging.getLogger(__name__)

PLAN_FREE = "free"
PLAN_PREMIUM = "premium"


# Every gated capability in the product, in one place. A feature asks for a key
# from this map rather than checking `plan == "premium"` inline, so the answer
# to "what does Premium actually buy?" is readable in a single screen and a
# future plan tier does not mean hunting for string comparisons.
PREMIUM_FEATURES: Dict[str, str] = {
    "split_ai_receipt":        "Scan a receipt and have MoneyKal itemize the split for you",
    "split_advanced_charts":   "Category, member and trend analytics across your groups",
    "split_multi_currency":    "Expenses in a currency other than the group's own",
    "split_advanced_search":   "Search every expense by amount, member, category and date range",
    "split_recurring":         "Recurring shared expenses — rent, subscriptions, bills",
    "split_smart_settlement":  "Settlement suggestions and automatic reminders",
    "split_export":            "Export a group's expenses and balances to CSV",
    "split_insights":          "AI spending insights across your shared expenses",
}

# Named so the free tier is a stated promise rather than an accident of which
# checks happen to have been written. Read by /split/entitlements, which the web
# client renders directly, so this list is what the user is actually shown.
FREE_FEATURES = [
    "Create unlimited groups",
    "Invite friends, including people without MoneyKal",
    "Add and edit expenses",
    "Every split mode — equal, exact, percentage, shares, itemized, multiple payers",
    "Live balances and debt simplification",
    "Record full, partial and custom settlements",
    "Activity feed and notifications",
]


def get_subscription(db: Session, user_id: int) -> Optional[Subscription]:
    return db.query(Subscription).filter(Subscription.user_id == user_id).first()


def is_premium(db: Session, user_id: int) -> bool:
    """True only for a live premium subscription.

    Checks `expires_at` as well as status rather than trusting `plan` alone: a
    lapsed row that was never cleaned up should stop granting access on its
    expiry date, not whenever a job gets round to it.
    """
    sub = get_subscription(db, user_id)
    if not sub or sub.plan != PLAN_PREMIUM or sub.status != "active":
        return False
    if sub.expires_at and sub.expires_at < datetime.utcnow():
        return False
    return True


def tier(db: Session, user_id: int) -> str:
    """'act' while a premium subscription is live, otherwise 'see'.

    The stored plan stays "free" / "premium"; SEE and ACT are the business
    model's names for them (backend/core/config/pricing_config.py).
    """
    return pricing.TIER_ACT if is_premium(db, user_id) else pricing.TIER_SEE


def subscription_status(db: Session, user_id: int) -> str:
    """none | active | cancelled | expired.

    'none' covers both "no row" and a row still on the free plan — neither has
    ever had anything to lapse. Expiry is judged from `expires_at`, the same
    way `is_premium` judges it, so the two can never disagree.
    """
    sub = get_subscription(db, user_id)
    if not sub or sub.plan != PLAN_PREMIUM:
        return "none"
    if sub.status == "cancelled":
        return "cancelled"
    if sub.status == "expired" or (sub.expires_at and sub.expires_at < datetime.utcnow()):
        return "expired"
    return "active"


def require_premium(db: Session, user_id: int, feature: str) -> None:
    """Guard for a premium-only endpoint.

    Raises 402 Payment Required rather than 403: the caller is properly
    authenticated and authorized, they simply are not on the plan. The client
    keys the upgrade prompt off that status, so a genuine permission failure
    (403) never gets rendered as a sales pitch.
    """
    if is_premium(db, user_id):
        return
    raise HTTPException(
        status_code=402,
        detail={
            "error": "premium_required",
            "feature": feature,
            "message": PREMIUM_FEATURES.get(feature, "This is a MoneyKal Premium feature"),
        },
    )


def entitlements(db: Session, user_id: int) -> Dict:
    """Everything the client needs to render plan state and gate its own UI.

    The client uses this to grey out premium affordances up front; the server
    still enforces `require_premium` on the endpoints themselves, because a UI
    flag is a courtesy and not a control.
    """
    sub = get_subscription(db, user_id)
    premium = is_premium(db, user_id)
    return {
        "plan": PLAN_PREMIUM if premium else PLAN_FREE,
        "is_premium": premium,
        "status": sub.status if sub else "active",
        "expires_at": sub.expires_at.isoformat() if sub and sub.expires_at else None,
        "features": {key: premium for key in PREMIUM_FEATURES},
        "premium_features": [
            {"key": k, "description": v} for k, v in PREMIUM_FEATURES.items()
        ],
        "free_features": FREE_FEATURES,
    }
