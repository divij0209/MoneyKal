from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime
from typing import List
from pydantic import BaseModel

from backend.database import get_db
from backend.core.auth import get_current_user
from backend.models.domain import User, Profile, ExperienceBadge

router = APIRouter(prefix="/gamification", tags=["Gamification"])

class BadgeResponse(BaseModel):
    id: int
    name: str
    icon: str
    description: str
    earned_at: datetime
    
    class Config:
        from_attributes = True

class AwardRequest(BaseModel):
    name: str
    icon: str
    description: str = ""

@router.get("/badges", response_model=List[BadgeResponse])
def get_badges(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
        
    badges = db.query(ExperienceBadge).filter(ExperienceBadge.profile_id == profile.id).order_by(ExperienceBadge.earned_at.desc()).all()
    return badges

@router.post("/badges/award", response_model=BadgeResponse)
def award_badge(req: AwardRequest, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
        
    new_badge = ExperienceBadge(
        profile_id=profile.id,
        name=req.name,
        icon=req.icon,
        description=req.description
    )
    db.add(new_badge)
    db.commit()
    db.refresh(new_badge)
    
    return new_badge
