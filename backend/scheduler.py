import logging
import os
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger
from datetime import datetime

from backend.database import SessionLocal
from backend.models.domain import Profile, Alert

logger = logging.getLogger(__name__)

from backend.market_intelligence.service import MarketIntelligenceService
from backend.services.startup_engine import build_context, compute_metrics, compute_goals, generate_alerts, capture_snapshot_if_needed
from backend.models.domain import GmailConnection

def _notify_gmail_sync(db, conn, added, deadlines):
    """Tell the user what their connected inbox just brought in.

    An integration notification rather than a financial one: the event is "your
    Gmail connection did something", and the figures are there so the row is
    worth reading without opening Hisaab. Only fired when the sync actually
    found something, so a quiet inbox stays quiet.
    """
    from backend.services import notification_service
    try:
        profile = db.query(Profile).filter(Profile.id == conn.profile_id).first()
        if not profile or not profile.user_id:
            return
        created = deadlines.get("created", 0) or 0
        review = deadlines.get("review", 0) or 0
        parts = []
        if added:
            parts.append(f"{added} transaction{'s' if added != 1 else ''}")
        if created:
            parts.append(f"{created} upcoming payment{'s' if created != 1 else ''}")
        if review:
            parts.append(f"{review} awaiting your review")
        notification_service.notify_once_per_day(
            db,
            profile.user_id,
            kind="gmail_sync",
            dedupe_key=f"gmail:{conn.id}:{added}:{created}:{review}",
            title="Gmail import found new activity",
            body="Imported " + ", ".join(parts) + ".",
            link_type="hisaab",
            link_id=conn.profile_id,
            meta={"transactions": added, "payments": created, "review": review},
        )
    except Exception:
        logger.exception("Gmail sync notification failed for connection %s", conn.id)


def _notify_gmail_failure(db, conn, error):
    """A connection that stopped working is worth interrupting someone for.

    This is the case the inbox exists for: the sync runs unattended, so without
    a notification a revoked token means transactions quietly stop arriving and
    the user finds out when their ledger is a month stale.
    """
    from backend.services import notification_service
    try:
        profile = db.query(Profile).filter(Profile.id == conn.profile_id).first()
        if not profile or not profile.user_id:
            return
        notification_service.notify_once_per_day(
            db,
            profile.user_id,
            kind="gmail_connection_error",
            dedupe_key=f"gmail_error:{conn.id}",
            title="Gmail import needs attention",
            body="MoneyKal could not read your connected Gmail account. "
                 "Reconnect it to keep importing transactions.",
            link_type="settings",
            link_id=conn.id,
            meta={"error": type(error).__name__},
        )
    except Exception:
        logger.exception("Gmail failure notification failed for connection %s", conn.id)


def _gmail_sync_allowed(db, conn) -> bool:
    """Gmail import is part of ACT, so the hourly pass skips everyone else.

    The connection itself is left in place: it is the user's, and it resumes
    importing the moment they are on ACT again.
    """
    from backend.core.access import has_act
    profile = db.query(Profile).filter(Profile.id == conn.profile_id).first()
    return bool(profile and profile.user_id and has_act(db, profile.user_id))


def evaluate_profiles():
    db = SessionLocal()
    try:
        # Fetch Market Intelligence proactively
        mi_service = MarketIntelligenceService(db)
        usd_inr = mi_service.get_exchange_rate("USDINR=X")
        nifty = mi_service.get_stock_price("^NSEI")
        inflation = mi_service.get_economic_indicator("INFLATION_IN", "INFCPIITM")
        news = mi_service.get_news_sentiment("indian economy")
        
        logger.info(f"Scheduler fetched Market Data - USDINR: {usd_inr}, NIFTY: {nifty}, Inflation: {inflation}, News: {news}")

        profiles = db.query(Profile).all()
        for profile in profiles:
            # Example logic for proactive alert generation
            # In a real scenario, this would call out to the Data Agent to fetch live data
            # and Risk Agent to simulate constraints.
            # Whether this profile's *startup* alert pass should run this hour.
            # The Daily AI Insight is no longer decided here: it has its own
            # job (generate_scheduled_insights) on its own quarter-hourly
            # tick, because this one runs hourly and so could never honour a
            # chosen time like 08:30. This flag now means only "re-evaluate
            # the startup alerts", which is all it ever actually did.
            schedule = getattr(profile, "insights_schedule", "daily") or "daily"
            now = datetime.now()
            
            should_run_insights = False
            if schedule == "hourly":
                should_run_insights = True
            elif schedule in ("daily", "weekdays") and now.hour == 9:
                should_run_insights = True
            elif schedule == "weekly" and now.weekday() == 0 and now.hour == 9:
                should_run_insights = True

            if profile.key == "individual":
                if should_run_insights:
                    # Check goal progress artificially
                    if profile.goal and profile.goal.get("progress", 0) < 50:
                        pass # We could add an alert here
            elif profile.key == "startup":
                try:
                    if not profile.startup_profile:
                        continue
                except Exception as e:
                    logger.error(f"Skipping startup profile {profile.id} — {type(e).__name__}: {e}")
                    continue
                # Capture a daily metric snapshot (idempotent — at most one per day)
                ctx = build_context(profile.startup_profile)
                snapshots = list(profile.startup_snapshots)
                metrics = compute_metrics(ctx, snapshots)
                capture_snapshot_if_needed(db, profile.id, ctx, metrics)
                
                if should_run_insights:
                    goals = compute_goals(ctx, metrics)
                    alerts = generate_alerts(ctx, metrics, goals)
                    if alerts:
                        logger.info(f"Startup profile {profile.id} ({ctx.company_name}) has {len(alerts)} active alert(s): {[a['text'] for a in alerts]}")

            
            # This job no longer generates Daily AI Insights, so the log no
            # longer claims it did — that belongs to generate_scheduled_insights.
            logger.info(f"Evaluated profile {profile.key} at {datetime.now()} (startup alert pass: {should_run_insights})")


        # Gmail auto-import — one pass per connected profile pulls both
        # bank/merchant transactions and upcoming financial deadlines. Same
        # connection, same tokens, same schedule; nothing extra to trigger.
        from backend.routers.gmail import run_sync_for_connection
        connections = db.query(GmailConnection).filter(GmailConnection.is_active == True).all()
        for conn in connections:
            if not _gmail_sync_allowed(db, conn):
                continue
            try:
                result = run_sync_for_connection(db, conn)
                added = result.get("transactions_added", 0)
                deadlines = result.get("deadlines", {})
                if added or deadlines.get("created") or deadlines.get("review"):
                    logger.info(
                        f"Gmail sync: profile {conn.profile_id} — {added} transaction(s), "
                        f"{deadlines.get('created', 0)} payment(s) added, "
                        f"{deadlines.get('review', 0)} awaiting review."
                    )
                    _notify_gmail_sync(db, conn, added, deadlines)
            except Exception as e:
                logger.error(f"Gmail sync failed for profile {conn.profile_id}: {type(e).__name__}: {e}")
                _notify_gmail_failure(db, conn, e)
        db.commit()

    finally:
        db.close()


def check_budget_alerts():
    """Check all active budget goals and fire WhatsApp alerts when thresholds are crossed."""
    from backend.services.budget_service import check_and_fire_alerts
    db = SessionLocal()
    try:
        sent = check_and_fire_alerts(db)
        if sent:
            logger.info(f"Budget alert job: sent {sent} WhatsApp alert(s)")
    except Exception as e:
        logger.error(f"Budget alert job failed: {e}")
    finally:
        db.close()


def send_whatsapp_reminders():
    """Send bill reminders for payments due in 0-3 days to users with WhatsApp linked."""
    from backend.models.domain import UpcomingPayment
    from backend.services.whatsapp_service import send_message, build_bill_reminder
    db = SessionLocal()
    try:
        today = __import__('datetime').date.today()
        cutoff = today + __import__('datetime').timedelta(days=3)
        profiles = db.query(Profile).filter(Profile.whatsapp_phone.isnot(None)).all()
        for profile in profiles:
            due_soon = db.query(UpcomingPayment).filter(
                UpcomingPayment.profile_id == profile.id,
                UpcomingPayment.is_active == True,
                UpcomingPayment.due_date >= today,
                UpcomingPayment.due_date <= cutoff,
            ).all()
            for payment in due_soon:
                msg = build_bill_reminder(payment, profile.currency or "Rs.")
                send_message(profile.whatsapp_phone, msg)
                logger.info(f"Sent WhatsApp bill reminder to profile {profile.id} for '{payment.name}'")
    except Exception as e:
        logger.error(f"WhatsApp reminder job failed: {e}")
    finally:
        db.close()


def send_whatsapp_daily_summaries():
    """Send morning summaries to all users with WhatsApp linked."""
    from backend.services.whatsapp_service import send_message, build_daily_summary
    db = SessionLocal()
    try:
        profiles = db.query(Profile).filter(Profile.whatsapp_phone.isnot(None)).all()
        for profile in profiles:
            summary = build_daily_summary(profile, db)
            send_message(profile.whatsapp_phone, summary)
            logger.info(f"Sent WhatsApp daily summary to profile {profile.id}")
    except Exception as e:
        logger.error(f"WhatsApp daily summary job failed: {e}")
    finally:
        db.close()


def send_monthly_reports():
    """Send a monthly financial report on the 1st of every month at 9am."""
    from backend.services.whatsapp_service import send_message
    from backend.services.monthly_report_service import build_monthly_report, format_monthly_report_whatsapp
    db = SessionLocal()
    try:
        profiles = db.query(Profile).filter(Profile.whatsapp_phone.isnot(None)).all()
        for profile in profiles:
            try:
                report = build_monthly_report(profile, db)
                msg = format_monthly_report_whatsapp(report)
                send_message(profile.whatsapp_phone, msg)
                logger.info(f"Sent monthly report to profile {profile.id} for {report['month']}")
            except Exception as e:
                logger.error(f"Monthly report failed for profile {profile.id}: {e}")
    except Exception as e:
        logger.error(f"Monthly report job failed: {e}")
    finally:
        db.close()

def generate_scheduled_insights():
    """Produce the Daily AI Insight for every profile whose schedule says now.

    This is the job that makes the Overview's Schedule dialog mean something.
    It ticks every INSIGHT_TICK_MINUTES and asks insight_schedule_service which
    profiles are due; that service owns the frequency and time-of-day logic, so
    this function stays a loop with error handling around it.

    Each profile is committed on its own. One profile whose ledger raises must
    not roll back the insights already generated for everyone ahead of it.

    No notification is created here, by design - see the docstrings in
    insight_schedule_service and notification_service.
    """
    from backend.services import insight_schedule_service

    db = SessionLocal()
    try:
        due = insight_schedule_service.due_profiles(db)
        generated = 0
        for profile in due:
            try:
                row = insight_schedule_service.generate_for_profile(db, profile)
                if row:
                    db.commit()
                    generated += 1
                else:
                    db.rollback()
            except Exception as e:
                db.rollback()
                logger.error(
                    f"Daily insight generation failed for profile {profile.id}: "
                    f"{type(e).__name__}: {e}"
                )
        if generated:
            logger.info(f"Daily AI Insights: generated {generated} insight(s) this tick")
    except Exception as e:
        logger.error(f"Daily insight job failed: {e}")
    finally:
        db.close()


def check_budget_notifications():
    """In-app notifications for budgets at or over their limit.

    Separate from check_budget_alerts rather than folded into it: that job
    exists to send WhatsApp messages and only looks at profiles with a phone
    number linked, while the inbox is for every user. Reusing its query would
    have meant either notifying nobody without WhatsApp or widening who gets
    messaged, and silently widening a paid channel is not a side effect this
    change should have.

    Idempotent across the day via notify_once_per_day, because this runs on the
    same seven-times-a-day trigger as the WhatsApp pass.
    """
    from backend.services import notification_service
    from backend.services.budget_service import get_budget_status

    db = SessionLocal()
    try:
        sent = 0
        for profile in db.query(Profile).all():
            if not profile.user_id:
                continue
            try:
                for st in get_budget_status(profile.id, db):
                    if st.get("status") not in ("warning", "over"):
                        continue
                    over = st.get("status") == "over"
                    pct = int(round(st.get("pct_used") or 0))
                    name = st.get("category") or st.get("name") or "Budget"
                    note = notification_service.notify_once_per_day(
                        db,
                        profile.user_id,
                        kind="budget_threshold",
                        dedupe_key=f"budget:{st.get('id')}:{st.get('status')}",
                        title=(f"{name} budget exceeded" if over
                               else f"{name} budget {pct}% used"),
                        body=(f"This month's {name} spending is past the limit you set."
                              if over else
                              f"You have spent {pct}% of this month's {name} budget."),
                        link_type="budgets",
                        link_id=st.get("id"),
                        meta={"category": name, "pct_used": pct, "status": st.get("status")},
                    )
                    if note:
                        sent += 1
            except Exception as e:
                logger.error(f"Budget notification failed for profile {profile.id}: {e}")
        if sent:
            db.commit()
            logger.info(f"Budget notifications: created {sent}")
        else:
            db.rollback()
    except Exception as e:
        db.rollback()
        logger.error(f"Budget notification job failed: {e}")
    finally:
        db.close()


def notify_upcoming_payments():
    """Inbox reminders for payments due within the next three days.

    The same window as the WhatsApp reminder job, deliberately: a user with
    WhatsApp linked should not be told about a different set of bills in the
    app than on their phone.
    """
    from datetime import date as _date, timedelta as _timedelta
    from backend.models.domain import UpcomingPayment
    from backend.services import notification_service

    db = SessionLocal()
    try:
        today = _date.today()
        cutoff = today + _timedelta(days=3)
        sent = 0
        for profile in db.query(Profile).all():
            if not profile.user_id:
                continue
            due_soon = db.query(UpcomingPayment).filter(
                UpcomingPayment.profile_id == profile.id,
                UpcomingPayment.is_active == True,  # noqa: E712
                UpcomingPayment.due_date >= today,
                UpcomingPayment.due_date <= cutoff,
            ).all()
            for payment in due_soon:
                days = (payment.due_date - today).days
                when = "today" if days == 0 else ("tomorrow" if days == 1 else f"in {days} days")
                note = notification_service.notify_once_per_day(
                    db,
                    profile.user_id,
                    kind="payment_due",
                    dedupe_key=f"payment:{payment.id}:{payment.due_date.isoformat()}",
                    title=f"{payment.name} is due {when}",
                    body=(f"{profile.currency or ''}{float(payment.amount or 0):,.0f} due on "
                          f"{payment.due_date.strftime('%d %b')}."),
                    link_type="upcoming",
                    link_id=payment.id,
                    meta={
                        "amount": float(payment.amount or 0),
                        "due_date": payment.due_date.isoformat(),
                    },
                )
                if note:
                    sent += 1
        if sent:
            db.commit()
            logger.info(f"Upcoming payment notifications: created {sent}")
        else:
            db.rollback()
    except Exception as e:
        db.rollback()
        logger.error(f"Upcoming payment notification job failed: {e}")
    finally:
        db.close()


scheduler = BackgroundScheduler()


def _scheduler_enabled() -> bool:
    """Whether this process should run the background jobs.

    Off by default, which is a change, and the reason is the shared database.
    These jobs are not all idempotent: the daily metric snapshot is (it is
    keyed on profile+date), but the WhatsApp jobs are not — they send real
    messages to real people. Three developers each running a backend against
    one database means every user gets their bill reminder three times, their
    daily summary three times, and their Gmail inbox scanned three times.

    So the jobs run only where someone has opted in: one designated machine, a
    staging box, or production. A developer who needs to exercise them locally
    sets ENABLE_SCHEDULER=true, ideally against a local database.
    """
    return os.getenv("ENABLE_SCHEDULER", "").lower() in ("1", "true", "yes")


def start_scheduler():
    if not _scheduler_enabled():
        logger.info(
            "Scheduler disabled (ENABLE_SCHEDULER is not set). Background jobs — "
            "market refresh, WhatsApp reminders, budget alerts, monthly reports — "
            "will not run in this process."
        )
        return
    scheduler.add_job(
        evaluate_profiles,
        trigger=IntervalTrigger(minutes=60), # Run every hour
        id="evaluate_profiles",
        name="Evaluate user financial profiles against live market data",
        replace_existing=True,
    )
    # WhatsApp: bill reminders — check every morning at 9am and evening at 6pm
    from apscheduler.triggers.cron import CronTrigger
    scheduler.add_job(
        send_whatsapp_reminders,
        trigger=CronTrigger(hour="9,18", minute=0),
        id="whatsapp_bill_reminders",
        name="WhatsApp bill reminders for upcoming payments",
        replace_existing=True,
    )
    # WhatsApp: daily morning summary at 8am
    scheduler.add_job(
        send_whatsapp_daily_summaries,
        trigger=CronTrigger(hour=8, minute=0),
        id="whatsapp_daily_summaries",
        name="WhatsApp daily financial summary",
        replace_existing=True,
    )
    # Budget overspend alerts — check every 2 hours during the day
    scheduler.add_job(
        check_budget_alerts,
        trigger=CronTrigger(hour="8,10,12,14,16,18,20", minute=30),
        id="budget_overspend_alerts",
        name="Budget overspend WhatsApp alerts",
        replace_existing=True,
    )
    # Monthly financial report — 1st of every month at 9am
    scheduler.add_job(
        send_monthly_reports,
        trigger=CronTrigger(day=1, hour=9, minute=0),
        id="monthly_financial_reports",
        name="Monthly financial report via WhatsApp",
        replace_existing=True,
    )
    # Daily AI Insights — the job that executes the user's chosen schedule.
    # Ticks on the quarter hour so a time like 08:30 is honoured; the frequency
    # and time matching live in insight_schedule_service, which keeps its own
    # TICK_MINUTES in step with this trigger. Nothing here notifies: insights
    # are not inbox events.
    from backend.services.insight_schedule_service import TICK_MINUTES as INSIGHT_TICK_MINUTES
    scheduler.add_job(
        generate_scheduled_insights,
        trigger=CronTrigger(minute=f"*/{INSIGHT_TICK_MINUTES}"),
        id="daily_ai_insights",
        name="Generate Daily AI Insights on each user's schedule",
        replace_existing=True,
    )
    # In-app notifications. Deliberately on the same triggers as their WhatsApp
    # counterparts so the two channels agree, and idempotent per day so a
    # repeated poll of the same standing condition does not repeat the row.
    scheduler.add_job(
        check_budget_notifications,
        trigger=CronTrigger(hour="8,10,12,14,16,18,20", minute=35),
        id="budget_inbox_notifications",
        name="Budget threshold notifications (in-app)",
        replace_existing=True,
    )
    scheduler.add_job(
        notify_upcoming_payments,
        trigger=CronTrigger(hour="9,18", minute=5),
        id="upcoming_payment_notifications",
        name="Upcoming payment notifications (in-app)",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Background scheduler started")

def stop_scheduler():
    # Shutting down a scheduler that never started raises
    # SchedulerNotRunningError, which would surface as a noisy traceback on
    # every clean exit now that starting is opt-in.
    if scheduler.running:
        scheduler.shutdown()
