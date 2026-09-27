"""Market Pulse endpoint — personalized view over the existing news service."""

import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import Profile, User
from backend.services.market_pulse_service import get_market_pulse

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/market-pulse", tags=["Market Pulse"])


@router.get("")
def market_pulse(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found.")
    try:
        return get_market_pulse(profile, db)
    except Exception as e:
        # The Overview must never fail because the news upstream did.
        logger.error(f"Market Pulse failed: {type(e).__name__}: {e}")
        return {"signals": [], "personalized": False,
                "message": "Market intelligence is temporarily unavailable."}
