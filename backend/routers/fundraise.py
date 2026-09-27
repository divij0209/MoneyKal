"""
Fundraise Readiness API.

Scoped to the Startup persona: every endpoint refuses Individual and
Enterprise/CFO profiles, mirroring how routers/tax.py fences the Individual
Tax Calculator to Individuals. The sidebar hides the feature for other
personas, but that is a UI concern — this is the actual boundary.

Surface:
    GET /startup/fundraise/readiness   full readiness + benchmarks + gaps
    GET /startup/fundraise/benchmarks  the benchmark table on its own
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from backend.core.config import fundraise_config as cfg
from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import (
    Profile,
    StartupMetricSnapshot,
    StartupTransaction,
    User,
)
from backend.services.fundraise_service import build_readiness
from backend.services.startup_engine import build_context, compute_metrics

router = APIRouter(prefix="/startup/fundraise", tags=["Fundraise Readiness"])


def _startup_profile(current_user: User, db: Session) -> Profile:
    """Resolve the caller's profile, refusing anything that is not a Startup.

    Kept local rather than imported from routers/startup.py so this feature
    owns its own guard and cannot be loosened by a change made for another
    reason elsewhere.
    """
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(
            status_code=404,
            detail="Profile not found for this user. Please complete onboarding.",
        )
    if profile.key != "startup":
        raise HTTPException(
            status_code=403,
            detail="Fundraise Readiness is available to Startup profiles only.",
        )
    if not profile.startup_profile:
        raise HTTPException(
            status_code=404,
            detail="Startup profile not found. Please complete Startup onboarding first.",
        )
    return profile


@router.get("/readiness")
def get_readiness(
    stage: str = Query(None, description="Override the benchmark stage, e.g. 'Series A'"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Readiness score, per-metric benchmarks, the ask, and the diligence gaps.

    `stage` lets a founder see how they would be judged one stage up without
    editing their profile — it changes only which benchmark table is applied,
    never the underlying numbers.
    """
    profile = _startup_profile(current_user, db)
    sp = profile.startup_profile

    # An unrecognised override is refused rather than silently scored against
    # the default table — a founder asking "how would Series A judge me?" must
    # never be shown the Seed verdict under a Series A label.
    if stage is not None and not cfg.is_known_stage(stage):
        raise HTTPException(
            status_code=400,
            detail=f"Unknown stage '{stage}'. Use one of: {', '.join(cfg.STAGE_LABELS.values())}.",
        )

    ctx = build_context(sp)
    if stage:
        ctx.stage = stage

    snapshots = (
        db.query(StartupMetricSnapshot)
        .filter(StartupMetricSnapshot.profile_id == profile.id)
        .order_by(StartupMetricSnapshot.snapshot_date)
        .all()
    )
    transactions = (
        db.query(StartupTransaction)
        .filter(StartupTransaction.profile_id == profile.id)
        .order_by(StartupTransaction.txn_date)
        .all()
    )

    base_metrics = compute_metrics(ctx, snapshots)
    return build_readiness(ctx, base_metrics, snapshots, transactions)


@router.get("/benchmarks")
def get_benchmarks(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """The benchmark table itself, for the "how am I judged?" panel.

    Served from the backend so the frontend never hardcodes a threshold — the
    same contract routers/tax.py holds with its statutory figures.
    """
    profile = _startup_profile(current_user, db)
    stage_key = cfg.normalize_stage(profile.startup_profile.stage)
    return {
        "stages": [
            {"key": k, "label": cfg.STAGE_LABELS[k], "is_current": k == stage_key}
            for k in cfg.STAGE_BENCHMARKS
        ],
        "current_stage": stage_key,
        "benchmarks": cfg.STAGE_BENCHMARKS,
        "notes": cfg.BENCHMARK_NOTES,
        "weights": cfg.READINESS_WEIGHTS,
        "verdicts": cfg.READINESS_VERDICTS,
    }
