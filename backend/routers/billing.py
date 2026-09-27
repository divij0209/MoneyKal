"""
Plans & Billing — HTTP surface.

    GET  /billing/me                    the caller's tier, subscription status, usage and services
    GET  /billing/catalog               what the caller can buy, filtered to their persona
    POST /billing/orders                price a purchase (nothing is granted yet)
    POST /billing/orders/{id}/coins     use or stop using Kal Coins on an unpaid order
    POST /billing/orders/{id}/upi-qr    issue the demo UPI QR for an unpaid order
    POST /billing/orders/{id}/pay       take payment and grant the purchase
    GET  /billing/orders                paid orders, newest first
    GET  /billing/coins                 Kal Coins balance, how to earn, and history

Kal Coins can only be earned and spent here against MoneyKal's own fees. There
is intentionally no route that sends, gifts, sells or cashes out coins — see
backend/services/kal_coins_service.py for why none may be added.

Available to every persona. Checkout offers one payment method, a UPI QR, and
it is a demonstration: /upi-qr encodes the order's real total into a UPI intent
URI that no bank can settle, /pay then confirms it and grants the purchase
exactly as a real payment would. Nothing is charged and no payment is verified
with anyone. DEMO_PAYMENTS_ENABLED gates both routes; with it off they refuse
rather than granting anything.

Card, UPI and bank details are never sent here, in any mode. When a real
gateway is connected, its own hosted checkout will collect them.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import User
from backend.services import billing_service, kal_coins_service
from backend.services.billing_service import BillingError

router = APIRouter(prefix="/billing", tags=["Billing"])


class OrderCreate(BaseModel):
    sku: str
    subject_ref: Optional[str] = None
    use_coins: bool = True


class OrderCoins(BaseModel):
    use_coins: bool


class OrderPay(BaseModel):
    # Ignored for an order Kal Coins cover in full.
    payment_method: str = ""
    # The reference the demo UPI QR was issued with. Optional: an order paid
    # entirely in Kal Coins never had a QR.
    transaction_reference: Optional[str] = None


def _raise(err: BillingError):
    raise HTTPException(status_code=err.status,
                        detail={"error": err.code, "message": err.message, **err.extra})


@router.get("/me")
def get_billing_state(current_user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    # Rewards that time has unlocked (a friend's 30 days) are granted as the
    # user looks, so the balance shown is always current.
    kal_coins_service.sync_earnings(db, current_user.id)
    return billing_service.account_state(db, current_user.id)


@router.get("/coins")
def get_coins(current_user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    kal_coins_service.sync_earnings(db, current_user.id)
    return kal_coins_service.coins_state(db, current_user.id)


@router.get("/catalog")
def get_catalog(current_user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    return billing_service.catalog(db, current_user.id)


@router.post("/orders", status_code=201)
def create_order(req: OrderCreate,
                 current_user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    kal_coins_service.sync_earnings(db, current_user.id)
    try:
        order = billing_service.create_order(db, current_user.id, req.sku, req.subject_ref, req.use_coins)
    except BillingError as err:
        _raise(err)
    return billing_service.order_dict(order)


@router.post("/orders/{order_id}/coins")
def set_order_coins(order_id: int, req: OrderCoins,
                    current_user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    try:
        order = billing_service.set_order_coins(db, current_user.id, order_id, req.use_coins)
    except BillingError as err:
        _raise(err)
    return billing_service.order_dict(order)


@router.post("/orders/{order_id}/upi-qr")
def start_upi_payment(order_id: int,
                      current_user: User = Depends(get_current_user),
                      db: Session = Depends(get_db)):
    """The demo UPI QR for an unpaid order. Grants nothing; /pay does that."""
    try:
        return billing_service.start_demo_payment(db, current_user.id, order_id)
    except BillingError as err:
        _raise(err)


@router.post("/orders/{order_id}/pay")
def pay_order(order_id: int, req: OrderPay,
              current_user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    try:
        order = billing_service.pay_order(db, current_user.id, order_id,
                                          req.payment_method, req.transaction_reference)
    except BillingError as err:
        _raise(err)
    # The new account state travels with the receipt, so the page can show the
    # extended plan or the unlocked year without a second round trip.
    return {
        "order": billing_service.order_dict(order),
        "account": billing_service.account_state(db, current_user.id),
    }


@router.get("/orders")
def list_orders(current_user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    return billing_service.list_orders(db, current_user.id)
