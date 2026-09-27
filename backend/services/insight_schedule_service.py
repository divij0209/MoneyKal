"""
Daily AI Insight scheduling.

Owns three things and nothing else: what a profile's schedule *is*, whether it
is *due*, and *generating* the insight when it is.

WHY THIS EXISTS
---------------
`profiles.insights_schedule` has held a frequency since ec8170c8e88e, but
nothing acted on it. The scheduler compared it against a hard-coded 9am and
then only logged, and GET /home recomputed the insight from scratch on every
request — so the stored preference changed nothing a user could observe, and
"generate at 08:00" had no moment to happen at.

This module supplies that moment. The scheduler asks `due_profiles()` every
quarter hour and calls `generate_for_profile()` on what comes back, which writes
a `DailyInsight` row. GET /home prefers that row for today and otherwise
computes live, so nothing regresses for a profile that has never been scheduled
or a deployment running with ENABLE_SCHEDULER unset.

NOT A NOTIFICATION
------------------
Generating an insight deliberately does not call notification_service. Daily AI
Insights and the notification inbox are separate systems: an insight is a
standing reading of your money that belongs in the Overview's own section, not
an event addressed to you. `notification_service.notify` also refuses insight
kinds outright, so this holds even if a future caller forgets.
"""
import logging
from datetime import date, datetime, time
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.models.domain import DailyInsight, Profile

logger = logging.getLogger(__name__)


# The frequencies the scheduler can actually honour. 'hourly', 'daily' and
# 'weekly' are the values already in the column and in the Edit Profile select,
# so they keep working untouched; 'weekdays' is new and is the only addition.
# The Overview dialog offers exactly these — a frequency the UI can pick but
# `is_due` cannot interpret would be a setting that silently does nothing.
FREQUENCIES = ("hourly", "daily", "weekdays", "weekly")

DEFAULT_FREQUENCY = "daily"
DEFAULT_TIME = "09:00"          # the hour the old scheduler hard-coded

# How often the scheduler ticks. A profile is due when the tick lands in the
# window starting at its chosen time, so the window must be at least as wide as
# the gap between ticks or a schedule could be stepped over entirely.
TICK_MINUTES = 15

# Monday is 0 in datetime.weekday(); weekly fires on Monday, matching the
# behaviour the old scheduler had for 'weekly'.
WEEKLY_DAY = 0


def parse_time(value: Optional[str]) -> time:
    """'HH:MM' to a time, falling back to the default rather than raising.

    Called on the scheduler's hot path against whatever is in the database,
    which may predate validation or have been written by an older client. A
    malformed value should cost that profile its chosen hour, not the whole
    tick.
    """
    try:
        hh, mm = str(value or DEFAULT_TIME).split(":")[:2]
        return time(hour=max(0, min(23, int(hh))), minute=max(0, min(59, int(mm))))
    except Exception:
        return time(hour=9, minute=0)


def normalize_frequency(value: Optional[str]) -> str:
    v = str(value or "").strip().lower()
    return v if v in FREQUENCIES else DEFAULT_FREQUENCY


def get_schedule(profile: Profile) -> Dict[str, Any]:
    """The schedule as the dialog reads it.

    `insights_enabled` is read with a None-means-true fallback: the column was
    added to a populated table, and a profile whose row predates the default
    should behave as it always has rather than as though the user switched
    insights off.
    """
    enabled = getattr(profile, "insights_enabled", True)
    return {
        "enabled": True if enabled is None else bool(enabled),
        "frequency": normalize_frequency(getattr(profile, "insights_schedule", None)),
        "time": parse_time(getattr(profile, "insights_time", None)).strftime("%H:%M"),
        "frequencies": list(FREQUENCIES),
    }


def save_schedule(
    db: Session,
    profile: Profile,
    enabled: Optional[bool] = None,
    frequency: Optional[str] = None,
    time_str: Optional[str] = None,
) -> Dict[str, Any]:
    """Write the parts the caller sent, validating as we go.

    Each field is optional so the dialog can save a single change, and every
    value is normalized here rather than trusted: `frequency` is snapped to one
    the scheduler can honour and `time` is round-tripped through `parse_time`,
    so nothing reaches the column that `due_profiles` would later have to guess
    about.
    """
    if enabled is not None:
        profile.insights_enabled = bool(enabled)
    if frequency is not None:
        profile.insights_schedule = normalize_frequency(frequency)
    if time_str is not None:
        profile.insights_time = parse_time(time_str).strftime("%H:%M")
    db.flush()
    return get_schedule(profile)


# ---------------------------------------------------------------------------
# Is it due?
# ---------------------------------------------------------------------------

def _matches_day(frequency: str, now: datetime) -> bool:
    if frequency == "daily":
        return True
    if frequency == "weekdays":
        return now.weekday() < 5           # Mon-Fri
    if frequency == "weekly":
        return now.weekday() == WEEKLY_DAY
    return True


def is_due(profile: Profile, now: datetime, last_generated: Optional[date]) -> bool:
    """Whether this profile should have an insight generated on this tick.

    Hourly fires once an hour on the tick that lands in the first window of the
    hour; everything else fires once on the day it matches, in the window that
    starts at the user's chosen time. `last_generated` is what stops a second
    tick inside the same window from writing again — the unique constraint on
    `daily_insights` would reject it anyway, but checking here means the common
    case does no work rather than taking an integrity error.
    """
    schedule = get_schedule(profile)
    if not schedule["enabled"]:
        return False

    frequency = schedule["frequency"]

    if frequency == "hourly":
        # Once per hour, on the first tick of that hour. Hourly deliberately
        # ignores the chosen time: the two settings contradict each other, and
        # a user who picks hourly has said the hour does not matter.
        return now.minute < TICK_MINUTES

    if not _matches_day(frequency, now):
        return False

    if last_generated == now.date():
        return False

    chosen = parse_time(schedule["time"])
    minutes_now = now.hour * 60 + now.minute
    minutes_due = chosen.hour * 60 + chosen.minute

    # A window rather than equality: the scheduler ticks on its own clock, so
    # an exact match would be missed whenever a tick drifts by a minute. The
    # upper bound keeps a profile whose generation failed earlier in the day
    # from firing at every subsequent tick until midnight.
    return 0 <= (minutes_now - minutes_due) < TICK_MINUTES


def last_generated_date(db: Session, profile_id: int) -> Optional[date]:
    row = (
        db.query(DailyInsight.generated_for)
        .filter(DailyInsight.profile_id == profile_id)
        .order_by(DailyInsight.generated_for.desc())
        .first()
    )
    return row[0] if row else None


def due_profiles(db: Session, now: Optional[datetime] = None) -> List[Profile]:
    """Every profile whose schedule says "now"."""
    now = now or datetime.now()
    out = []
    for profile in db.query(Profile).all():
        try:
            if is_due(profile, now, last_generated_date(db, profile.id)):
                out.append(profile)
        except Exception:
            # One unreadable profile must not stop the rest of the tick.
            logger.exception("Could not evaluate insight schedule for profile %s", profile.id)
    return out


# ---------------------------------------------------------------------------
# Generating
# ---------------------------------------------------------------------------

def generate_for_profile(db: Session, profile: Profile, today: Optional[date] = None) -> Optional[DailyInsight]:
    """Compute this profile's insight and store it for `today`.

    The computation is the existing one: the same `home_insights.generate_insight`
    over the same `home_service` context that GET /home has always used. This
    function adds a time at which it happens and a row to put it in — it does
    not introduce a second way of deciding what the insight says.

    Imported inside the function because home_service pulls in a wide slice of
    the domain; keeping it out of module scope means the scheduler can import
    this module cheaply.
    """
    from backend.services import home_insights, home_service

    today = today or date.today()

    existing = (
        db.query(DailyInsight)
        .filter(DailyInsight.profile_id == profile.id, DailyInsight.generated_for == today)
        .first()
    )
    if existing:
        return existing

    ctx = home_service.build_home_context(db, profile, today=today)
    available = home_service.build_available_money(ctx)
    goals = home_service.build_goals(ctx)
    upcoming = home_service.build_upcoming(ctx, limit=5)
    has_data = home_service.has_any_financial_data(ctx)

    insight = home_insights.generate_insight(ctx, upcoming, goals, available, has_data)
    if not insight:
        return None

    row = DailyInsight(profile_id=profile.id, generated_for=today, payload=insight)
    db.add(row)
    db.flush()

    # No notification is created here, and none should be. See the module
    # docstring: the insight's home is the Overview's Daily AI Insights
    # section, not the inbox.
    return row


def get_stored_insight(db: Session, profile_id: int, day: date) -> Optional[Dict[str, Any]]:
    """Today's generated insight, or None to let the caller compute live."""
    row = (
        db.query(DailyInsight)
        .filter(DailyInsight.profile_id == profile_id, DailyInsight.generated_for == day)
        .first()
    )
    return (row.payload or None) if row else None
