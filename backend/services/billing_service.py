"""
Billing — what a user is on, what they have used, what they can buy, and
checkout.

Prices and limits come from backend/core/config/pricing_config.py; the
plan itself is still resolved by subscription_service, so there is exactly one
answer to "is this user on ACT?" across Split, billing and every future gate.

Persona boundaries are kept, not bridged: a service offered to one persona is
neither listed nor reported for another. The Tax Calculator uses the same
Individual test as backend/routers/tax.py, so the price list can never offer it
to someone that router would refuse.

Checkout takes payment one way: a demo UPI QR. `start_demo_payment` draws the
QR from the order's real payable amount and moves it to 'processing';
`pay_order` confirms it and grants the purchase through the same code path a
real payment would use, so the database ends up in exactly the state a real
one would leave. Nothing is charged and no bank is asked — see
pricing_config.demo_payments_enabled for the switch that keeps that from being
a way to give ACT away.
"""
import math
import uuid
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional
from urllib.parse import quote

from sqlalchemy.orm import Session

from backend.core import qr
from backend.core.config import pricing_config as pricing
from backend.core.config import tax_config
from backend.models.domain import (
    BillingOrder, Profile, ServiceEntitlement, Subscription, UsageCounter,
)
from backend.services import kal_coins_service, subscription_service


# ---------------------------------------------------------------------------
# Periods and personas
# ---------------------------------------------------------------------------

def current_period(now: Optional[datetime] = None) -> str:
    """The usage month a moment falls in, as 'YYYY-MM' (UTC)."""
    now = now or datetime.utcnow()
    return f"{now.year:04d}-{now.month:02d}"


def next_period_start(now: datetime) -> date:
    if now.month == 12:
        return date(now.year + 1, 1, 1)
    return date(now.year, now.month + 1, 1)


def persona_for(profile: Optional[Profile]) -> Optional[str]:
    """'individual' for any Individual key, otherwise the profile's own key."""
    if not profile:
        return None
    # Imported here, not at module level: the tax router gates on
    # backend/core/access.py, which imports this module, so a top-level import
    # would be circular.
    from backend.routers.tax import is_individual_key
    return "individual" if is_individual_key(profile.key) else profile.key


def _subjects_for(service: Dict) -> List[str]:
    if service["subject"] == "tax_year":
        return list(tax_config.TAX_YEARS.keys())
    return []


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

def usage_used(db: Session, user_id: int, feature_key: str, period: Optional[str] = None) -> int:
    row = (
        db.query(UsageCounter)
        .filter(
            UsageCounter.user_id == user_id,
            UsageCounter.feature_key == feature_key,
            UsageCounter.period == (period or current_period()),
        )
        .first()
    )
    return row.count if row else 0


def quota_state(db: Session, user_id: int, is_act: bool) -> Dict[str, Dict]:
    now = datetime.utcnow()
    period = current_period(now)
    resets_on = next_period_start(now).isoformat()
    out = {}
    for key, quota in pricing.FREE_QUOTAS.items():
        used = usage_used(db, user_id, key, period)
        limit = None if is_act else quota["limit"]
        out[key] = {
            "label": quota["label"],
            "used": used,
            "limit": limit,
            "remaining": None if limit is None else max(0, limit - used),
            "unlimited": is_act,
            "period": period,
            "resets_on": resets_on,
        }
    return out


# ---------------------------------------------------------------------------
# Pay-per-use services
# ---------------------------------------------------------------------------

def service_access(db: Session, user_id: int, sku: str, subject_ref: str,
                   is_act: Optional[bool] = None) -> str:
    """included_in_act | purchased | locked, for one service and subject.

    A purchase is reported as 'purchased' even while ACT also covers it, so a
    user who bought a year before upgrading still sees that they own it.
    """
    service = pricing.SERVICES[sku]
    owned = (
        db.query(ServiceEntitlement.id)
        .filter(
            ServiceEntitlement.user_id == user_id,
            ServiceEntitlement.sku == sku,
            ServiceEntitlement.subject_ref == subject_ref,
            ServiceEntitlement.status == "active",
        )
        .first()
    )
    if owned:
        return "purchased"
    if is_act is None:
        is_act = subscription_service.is_premium(db, user_id)
    if is_act and service.get("included_in_act"):
        return "included_in_act"
    return "locked"


def has_service(db: Session, user_id: int, sku: str, subject_ref: str) -> bool:
    return service_access(db, user_id, sku, subject_ref) != "locked"


def _services_state(db: Session, user_id: int, persona: Optional[str], is_act: bool) -> List[Dict]:
    out = []
    for sku, service in pricing.SERVICES.items():
        if persona not in service["personas"]:
            continue
        for subject in _subjects_for(service):
            out.append({
                "sku": sku,
                "label": service["label"],
                "subject_ref": subject,
                "access": service_access(db, user_id, sku, subject, is_act),
            })
    return out


# ---------------------------------------------------------------------------
# What the client reads
# ---------------------------------------------------------------------------

def _plan_state(sub: Optional[Subscription], is_act: bool) -> Dict:
    if not sub or sub.plan != subscription_service.PLAN_PREMIUM:
        return {"sku": None, "billing_cycle": None, "started_at": None,
                "expires_at": None, "days_left": None}
    days_left = None
    if sub.expires_at:
        seconds = (sub.expires_at - datetime.utcnow()).total_seconds()
        days_left = max(0, math.ceil(seconds / 86400)) if is_act else 0
    sku = next((k for k, p in pricing.ACT_PASSES.items()
                if p["billing_cycle"] == sub.billing_cycle), None)
    return {
        "sku": sku,
        "billing_cycle": sub.billing_cycle,
        "started_at": sub.started_at.isoformat() if sub.started_at else None,
        "expires_at": sub.expires_at.isoformat() if sub.expires_at else None,
        "days_left": days_left,
    }


def account_state(db: Session, user_id: int) -> Dict:
    """Everything the Plans & Billing page needs about the caller.

    A UI flag is a courtesy, not a control: endpoints still enforce access on
    the server.
    """
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    persona = persona_for(profile)
    sub = subscription_service.get_subscription(db, user_id)
    is_act = subscription_service.is_premium(db, user_id)
    return {
        "tier": pricing.TIER_ACT if is_act else pricing.TIER_SEE,
        "tier_label": pricing.TIER_LABELS[pricing.TIER_ACT if is_act else pricing.TIER_SEE],
        "subscription_status": subscription_service.subscription_status(db, user_id),
        "persona": persona,
        "plan": _plan_state(sub, is_act),
        "quotas": quota_state(db, user_id, is_act),
        "services": _services_state(db, user_id, persona, is_act),
        "currency": pricing.CURRENCY,
        "payment_mode": pricing.payment_mode(),
        # The methods checkout may offer, so the page renders the list the
        # server will actually accept rather than one of its own.
        "payment_methods": [
            {"key": key, "label": pricing.PAYMENT_METHOD_LABELS[key]}
            for key in pricing.PAYMENT_METHODS
        ],
        "demo_payments": pricing.demo_payments_enabled(),
        "kal_coins": {
            "balance": kal_coins_service.balance(db, user_id),
            "value_minor": kal_coins_service.value_minor(kal_coins_service.balance(db, user_id)),
        },
    }


def catalog(db: Session, user_id: int) -> Dict:
    """What this user can buy, filtered to their persona."""
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    persona = persona_for(profile)
    return {
        "currency": pricing.CURRENCY,
        "tiers": {
            pricing.TIER_SEE: {
                "label": pricing.TIER_LABELS[pricing.TIER_SEE],
                "price_minor": 0,
                "features": pricing.SEE_FEATURES,
                "quotas": {k: {"label": q["label"], "limit": q["limit"]}
                           for k, q in pricing.FREE_QUOTAS.items()},
            },
            pricing.TIER_ACT: {
                "label": pricing.TIER_LABELS[pricing.TIER_ACT],
                "features": [
                    {"key": k, "description": v}
                    for k, v in pricing.ACT_FEATURES.items()
                    # Only advertise what this persona can actually use.
                    if persona in pricing.ACT_FEATURE_PERSONAS.get(k, [persona])
                ],
                "passes": [
                    {"sku": sku, **p} for sku, p in pricing.ACT_PASSES.items()
                ],
            },
        },
        "services": [
            {
                "sku": sku,
                "label": s["label"],
                "description": s["description"],
                "price_minor": s["price_minor"],
                "subject": s["subject"],
                "subjects": _subjects_for(s),
                "included_in_act": s["included_in_act"],
            }
            for sku, s in pricing.SERVICES.items()
            if persona in s["personas"]
        ],
    }


# ---------------------------------------------------------------------------
# Checkout
# ---------------------------------------------------------------------------

# An order can be paid from either: 'created' is priced but untouched,
# 'processing' means a demo UPI QR has been issued for it and it is waiting to
# be confirmed. Neither has granted anything.
PAYABLE_STATUSES = ("created", "processing")


class BillingError(Exception):
    """A checkout request that cannot proceed, with the HTTP status it maps to."""

    def __init__(self, status: int, code: str, message: str, extra: Optional[Dict] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.extra = extra or {}


def _item_label(order: BillingOrder) -> str:
    if order.kind == "act_pass":
        return pricing.ACT_PASSES[order.sku]["label"]
    label = pricing.SERVICES[order.sku]["label"]
    return f"{label} · {order.subject_ref}" if order.subject_ref else label


def _duration_days(order: BillingOrder) -> Optional[int]:
    """How long an ACT pass runs, from the price list. None for a service."""
    pass_ = pricing.ACT_PASSES.get(order.sku) if order.kind == "act_pass" else None
    return pass_["duration_days"] if pass_ else None


def order_dict(order: BillingOrder) -> Dict:
    return {
        "id": order.id,
        "sku": order.sku,
        "kind": order.kind,
        "label": _item_label(order),
        "subject_ref": order.subject_ref,
        "duration_days": _duration_days(order),
        "gross_minor": order.gross_minor,
        "coins_redeemed": order.coins_redeemed,
        "coin_discount_minor": order.coin_discount_minor,
        "payable_minor": order.payable_minor,
        "currency": order.currency,
        "status": order.status,
        # `payment_mode` is the column; `provider` and `is_demo` are the same
        # fact said plainly, so a client never has to know that "demo" is a
        # mode rather than a gateway name.
        "payment_mode": order.payment_mode,
        "provider": order.payment_mode,
        "is_demo": order.payment_mode == pricing.PAYMENT_MODE_DEMO,
        "payment_method": order.payment_method,
        "payment_method_label": pricing.PAYMENT_METHOD_LABELS.get(order.payment_method or ""),
        "transaction_reference": order.gateway_order_id,
        "created_at": order.created_at.isoformat() if order.created_at else None,
        "paid_at": order.paid_at.isoformat() if order.paid_at else None,
    }


def _apply_coin_quote(db: Session, order: BillingOrder, use_coins: bool) -> None:
    """Price an order's Kal Coins discount against the user's current balance.

    Coins are only quoted here; they are spent when the order is paid, so an
    abandoned checkout never holds any.
    """
    available = kal_coins_service.balance(db, order.user_id) if use_coins else 0
    coins, discount = kal_coins_service.quote(order.gross_minor, available)
    order.coins_redeemed = coins
    order.coin_discount_minor = discount
    order.payable_minor = order.gross_minor - discount
    order.meta = {**(order.meta or {}), "use_coins": bool(use_coins)}


def set_order_coins(db: Session, user_id: int, order_id: int, use_coins: bool) -> BillingOrder:
    """Turn Kal Coins on or off for an order that has not been paid yet."""
    order = (
        db.query(BillingOrder)
        .filter(BillingOrder.id == order_id, BillingOrder.user_id == user_id)
        .first()
    )
    if not order:
        raise BillingError(404, "order_not_found", "Order not found.")
    if order.status not in PAYABLE_STATUSES:
        raise BillingError(409, "order_not_payable", f"This order is {order.status}.")
    _apply_coin_quote(db, order, use_coins)
    # Changing the total invalidates a QR issued for the old one. The order
    # goes back to waiting for payment; the reference it was given is kept, so
    # the next QR is the same transaction at the corrected amount.
    if order.status == "processing":
        order.status = "created"
    order.meta = {k: v for k, v in (order.meta or {}).items() if k != "demo_upi"}
    db.commit()
    db.refresh(order)
    return order


def create_order(db: Session, user_id: int, sku: str, subject_ref: Optional[str] = None,
                 use_coins: bool = True) -> BillingOrder:
    """Price a purchase and record it as 'created'. Nothing is granted yet.

    Kal Coins are applied by default, up to the full price.

    Refuses anything the user could not actually use or already has, so a
    checkout can never sell a second copy of the same tax year or a service
    outside the user's persona.
    """
    if sku in pricing.ACT_PASSES:
        sub = subscription_service.get_subscription(db, user_id)
        if subscription_service.is_premium(db, user_id) and not sub.expires_at:
            # A grant with no end date cannot be extended, and selling a pass
            # would only shorten it.
            raise BillingError(409, "already_has_access", "Your ACT plan has no end date.")
        kind, gross, subject_ref = "act_pass", pricing.ACT_PASSES[sku]["price_minor"], None

    elif sku in pricing.SERVICES:
        service = pricing.SERVICES[sku]
        profile = db.query(Profile).filter(Profile.user_id == user_id).first()
        if persona_for(profile) not in service["personas"]:
            raise BillingError(403, "not_offered", f"{service['label']} is not available for your account.")
        if subject_ref not in _subjects_for(service):
            raise BillingError(400, "invalid_subject", f"Choose a valid {service['subject'].replace('_', ' ')}.")
        access = service_access(db, user_id, sku, subject_ref)
        if access != "locked":
            message = ("Already included in your ACT plan." if access == "included_in_act"
                       else "You have already bought this.")
            raise BillingError(409, "already_has_access", message)
        kind, gross = "service", service["price_minor"]

    else:
        raise BillingError(404, "unknown_sku", "That item is not for sale.")

    order = BillingOrder(
        user_id=user_id,
        sku=sku,
        kind=kind,
        subject_ref=subject_ref,
        gross_minor=gross,
        coins_redeemed=0,
        coin_discount_minor=0,
        payable_minor=gross,
        currency=pricing.CURRENCY,
        status="created",
        payment_mode=pricing.payment_mode(),
        meta={},
    )
    _apply_coin_quote(db, order, use_coins)
    db.add(order)
    db.commit()
    db.refresh(order)
    return order


# ---------------------------------------------------------------------------
# Demo UPI payment
# ---------------------------------------------------------------------------

def _new_reference(db: Session) -> str:
    """A fresh MK-DEMO-XXXXXXXX transaction reference.

    Stored in billing_orders.gateway_order_id, which is UNIQUE, so the column
    itself is what makes a reference single-use — this loop only saves the
    round trip of hitting that constraint.
    """
    for _ in range(5):
        reference = pricing.DEMO_TXN_PREFIX + uuid.uuid4().hex[:8].upper()
        taken = (
            db.query(BillingOrder.id)
            .filter(BillingOrder.gateway_order_id == reference)
            .first()
        )
        if not taken:
            return reference
    raise BillingError(503, "reference_unavailable",
                       "Could not start the payment. Please try again.")


def demo_upi_uri(order: BillingOrder, reference: str) -> str:
    """The UPI intent URI the QR encodes, built from the order's real total.

    `pa` is a demonstration string, not a registered VPA: no UPI app can
    actually pay it, and nothing in MoneyKal reads a bank for confirmation.
    The QR exists so the checkout looks like what a real one will, and the
    amount in it is the amount the order actually charges.
    """
    amount = "%.2f" % (order.payable_minor / 100)
    params = (
        ("pa", pricing.DEMO_UPI_VPA),
        ("pn", pricing.DEMO_UPI_PAYEE),
        ("am", amount),
        ("cu", order.currency),
        ("tn", _item_label(order)),
        ("tr", reference),
    )
    return "upi://pay?" + "&".join("%s=%s" % (k, quote(str(v), safe="@")) for k, v in params)


def start_demo_payment(db: Session, user_id: int, order_id: int) -> Dict:
    """Issue the demo UPI QR for an unpaid order and move it to 'processing'.

    Grants nothing: only `pay_order` does that. Calling this twice for one
    order returns the same reference rather than a second one, so a
    double-tapped Pay button cannot leave two references pointing at one
    purchase.
    """
    if not pricing.demo_payments_enabled():
        raise BillingError(503, "payments_unavailable", "Online payments are not connected yet.")

    order = (
        db.query(BillingOrder)
        .filter(BillingOrder.id == order_id, BillingOrder.user_id == user_id)
        .first()
    )
    if not order:
        raise BillingError(404, "order_not_found", "Order not found.")
    if order.payment_mode != pricing.PAYMENT_MODE_DEMO:
        raise BillingError(503, "payments_unavailable", "Online payments are not connected yet.")
    if order.status not in PAYABLE_STATUSES:
        raise BillingError(409, "order_not_payable", f"This order is {order.status}.")
    if order.payable_minor <= 0:
        raise BillingError(400, "no_payment_needed",
                           "Kal Coins cover the full price. No payment is needed.")

    reference = order.gateway_order_id or _new_reference(db)
    uri = demo_upi_uri(order, reference)
    order.gateway_order_id = reference
    order.status = "processing"
    order.meta = {
        **(order.meta or {}),
        "demo_upi": {
            "reference": reference,
            "uri": uri,
            "amount_minor": order.payable_minor,
            "issued_at": datetime.utcnow().isoformat(),
        },
    }
    db.commit()
    db.refresh(order)

    rows = qr.rows(uri)
    return {
        "order": order_dict(order),
        "transaction_reference": reference,
        "upi_uri": uri,
        "amount_minor": order.payable_minor,
        "currency": order.currency,
        "qr": {"size": len(rows), "rows": rows},
        "is_demo": True,
        "notice": "Demo payment. No real money will be charged.",
    }


def _grant_act_pass(db: Session, user_id: int, sku: str, source: str) -> None:
    """Start or extend ACT by the pass's length.

    Buying while a pass is still running adds the days on top of the current
    end date, so paying early never throws away days already paid for.
    """
    pass_ = pricing.ACT_PASSES[sku]
    now = datetime.utcnow()
    sub = subscription_service.get_subscription(db, user_id)
    live = subscription_service.is_premium(db, user_id)

    if not sub:
        sub = Subscription(user_id=user_id)
        db.add(sub)

    starts_from = sub.expires_at if (live and sub.expires_at and sub.expires_at > now) else now
    if not live:
        sub.started_at = now
    sub.plan = subscription_service.PLAN_PREMIUM
    sub.status = "active"
    sub.source = source
    sub.billing_cycle = pass_["billing_cycle"]
    sub.expires_at = starts_from + timedelta(days=pass_["duration_days"])


def pay_order(db: Session, user_id: int, order_id: int, payment_method: str,
              transaction_reference: Optional[str] = None) -> BillingOrder:
    """Take payment for an unpaid order and grant what it bought.

    Demo mode simulates a successful payment. Paying an order that is already
    paid returns it unchanged, so a double-click or a retried request can never
    grant the purchase twice.

    Kal Coins quoted on the order are spent in the same transaction as the
    purchase is granted: either both happen or neither does. An order that
    coins cover in full moves no money, so it needs no payment method and no
    gateway, in any payment mode.

    `transaction_reference` is the one the demo UPI QR was issued with. It is
    checked against the order when supplied, so a client cannot confirm one
    order with another's reference; it is not required, because an order paid
    entirely in Kal Coins never had a QR.
    """
    order = (
        db.query(BillingOrder)
        .filter(BillingOrder.id == order_id, BillingOrder.user_id == user_id)
        .first()
    )
    if not order:
        raise BillingError(404, "order_not_found", "Order not found.")
    if order.status == "paid":
        return order
    if order.status not in PAYABLE_STATUSES:
        raise BillingError(409, "order_not_payable", f"This order is {order.status}.")
    if transaction_reference and transaction_reference != order.gateway_order_id:
        raise BillingError(409, "reference_mismatch",
                           "This payment does not match the order. Please start again.")

    demo = pricing.payment_mode() == pricing.PAYMENT_MODE_DEMO and order.payment_mode == pricing.PAYMENT_MODE_DEMO

    if order.payable_minor == 0:
        payment_method = pricing.PAYMENT_METHOD_COINS
    else:
        if payment_method not in pricing.PAYMENT_METHODS:
            raise BillingError(400, "invalid_payment_method", "UPI QR is the only payment method.")
        # Demo mode is what grants a purchase nothing was charged for, so it
        # has to be on twice over: the mode the order was priced in, and the
        # flag that says this deployment may do it at all.
        if not demo or not pricing.demo_payments_enabled():
            raise BillingError(503, "payments_unavailable", "Online payments are not connected yet.")

    if order.kind == "service":
        # Re-checked at payment time: the same year may have been bought from
        # another tab since this order was priced.
        owned = (
            db.query(ServiceEntitlement.id)
            .filter(
                ServiceEntitlement.user_id == user_id,
                ServiceEntitlement.sku == order.sku,
                ServiceEntitlement.subject_ref == order.subject_ref,
            )
            .first()
        )
        if owned:
            order.status = "cancelled"
            db.commit()
            raise BillingError(409, "already_has_access", "You have already bought this.")

    # Every demo order carries a reference, whether or not a QR was issued for
    # it, so history and support have one name for the transaction.
    reference = order.gateway_order_id
    if not reference and demo:
        reference = _new_reference(db)

    # Claim the order with a conditional UPDATE rather than read-then-write, so
    # two requests racing on the same order cannot both pass the status check
    # above and extend ACT twice. Only the request whose UPDATE matched grants.
    claimed = (
        db.query(BillingOrder)
        .filter(BillingOrder.id == order.id, BillingOrder.status.in_(PAYABLE_STATUSES))
        .update({
            BillingOrder.status: "paid",
            BillingOrder.payment_method: payment_method,
            BillingOrder.paid_at: datetime.utcnow(),
            BillingOrder.gateway_order_id: reference,
            BillingOrder.gateway_payment_id: (
                None if payment_method == pricing.PAYMENT_METHOD_COINS else f"demo_{uuid.uuid4().hex[:16]}"
            ),
        }, synchronize_session=False)
    )
    if not claimed:
        db.rollback()
        db.refresh(order)
        if order.status == "paid":
            return order
        raise BillingError(409, "order_not_payable", f"This order is {order.status}.")

    if not kal_coins_service.redeem_for_order(db, user_id, order.id, order.coins_redeemed):
        # The balance dropped since this order was priced (coins spent in
        # another tab). Undo the claim, re-price against what is left, and let
        # the user confirm the new total rather than charging a different one.
        db.rollback()
        order = db.query(BillingOrder).filter(BillingOrder.id == order_id).first()
        _apply_coin_quote(db, order, (order.meta or {}).get("use_coins", True))
        # Any QR already issued names the old total, so it is withdrawn with
        # the old price. The reference stays on the order; a new QR reuses it.
        if order.status == "processing":
            order.status = "created"
        order.meta = {k: v for k, v in (order.meta or {}).items() if k != "demo_upi"}
        db.commit()
        db.refresh(order)
        raise BillingError(409, "coins_changed",
                           "Your Kal Coins balance changed. Please check the new total.",
                           extra={"order": order_dict(order)})

    if order.kind == "act_pass":
        _grant_act_pass(db, user_id, order.sku, source=order.payment_mode)
        if order.sku == "act_yearly":
            kal_coins_service.reward_act_yearly(db, user_id, order.id)
    else:
        db.add(ServiceEntitlement(
            user_id=user_id,
            sku=order.sku,
            subject_ref=order.subject_ref,
            order_id=order.id,
            status="active",
        ))

    db.commit()
    db.refresh(order)
    return order


def list_orders(db: Session, user_id: int) -> List[Dict]:
    """Paid orders, newest first. Abandoned checkouts are not history."""
    orders = (
        db.query(BillingOrder)
        .filter(BillingOrder.user_id == user_id, BillingOrder.status == "paid")
        .order_by(BillingOrder.paid_at.desc(), BillingOrder.id.desc())
        .all()
    )
    return [order_dict(o) for o in orders]
