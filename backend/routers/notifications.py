"""
Notifications router — the user's inbox.

General MoneyKal infrastructure rather than a Split endpoint set, so it lives
under its own prefix and knows nothing about groups or expenses. Split is
simply its first producer.

Every route resolves the recipient from the bearer token and filters on that
user id. No route accepts a user id from the client, so there is no shape of
request that reads or mutates somebody else's inbox.
"""
from typing import List, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import User
from backend.services import notification_service

router = APIRouter(prefix="/notifications", tags=["Notifications"])


class MarkReadRequest(BaseModel):
    # Omitted or empty means "mark everything read", which is what the
    # inbox's own header button does.
    notification_ids: Optional[List[int]] = None


class PreferencesRequest(BaseModel):
    in_app_enabled: Optional[bool] = None
    whatsapp_enabled: Optional[bool] = None
    split_enabled: Optional[bool] = None
    split_expense_added: Optional[bool] = None
    split_expense_updated: Optional[bool] = None
    split_settlement: Optional[bool] = None
    split_group_activity: Optional[bool] = None
    split_friend_activity: Optional[bool] = None


@router.get("")
def list_notifications(
    unread_only: bool = False,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    rows = notification_service.list_notifications(
        db, current_user.id, unread_only=unread_only, limit=limit, offset=offset
    )
    db.commit()
    return {
        "notifications": [notification_service.serialize(n) for n in rows],
        "unread_count": notification_service.unread_count(db, current_user.id),
    }


@router.get("/unread-count")
def get_unread_count(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Polled by the topbar bell, so it is kept as cheap as a COUNT."""
    return {"unread_count": notification_service.unread_count(db, current_user.id)}


@router.post("/read")
def mark_read(
    req: MarkReadRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    count = notification_service.mark_read(db, current_user.id, req.notification_ids)
    db.commit()
    return {"marked": count, "unread_count": notification_service.unread_count(db, current_user.id)}


@router.get("/preferences")
def get_preferences(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pref = notification_service.get_preferences(db, current_user.id)
    db.commit()
    return {
        "in_app_enabled": pref.in_app_enabled,
        "whatsapp_enabled": pref.whatsapp_enabled,
        "split_enabled": pref.split_enabled,
        "split_expense_added": pref.split_expense_added,
        "split_expense_updated": pref.split_expense_updated,
        "split_settlement": pref.split_settlement,
        "split_group_activity": pref.split_group_activity,
        "split_friend_activity": pref.split_friend_activity,
    }


@router.put("/preferences")
def update_preferences(
    req: PreferencesRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pref = notification_service.get_preferences(db, current_user.id)
    for field, value in req.model_dump(exclude_unset=True).items():
        if value is not None:
            setattr(pref, field, bool(value))
    db.commit()
    return {"status": "saved"}
