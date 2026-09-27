"""
Opt-in demo data for the Daily Home dashboard.

Deliberately a separate, explicitly-run script rather than part of seed.py or
any request path: the Daily Home is built to show real user data, and a seeder
that ran automatically would put invented figures in front of real people. Run
this only to populate a development account.

    # from the project root, with the venv active
    $env:PYTHONPATH="."          # PowerShell
    python backend/seed_home_demo.py <username>

Everything it writes goes through the same tables the app writes at runtime —
the Hisaab ledger, financial_goals and upcoming_payments — so the dashboard
computes the demo figures with exactly the same code path it uses in production.
Re-running it for the same user replaces only the rows it created.
"""
import sys
from datetime import date, timedelta

from backend.database import SessionLocal
from backend.models.domain import (
    FinancialGoal, Profile, StartupTransaction, UpcomingPayment, User,
)
from backend.services.home_service import sync_legacy_profile_goal

DEMO_TAG = "[demo:home]"     # lets a re-run clean up after itself


def seed(username: str) -> None:
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if not user:
            print("No user named %r. Register that account first." % username)
            return

        profile = db.query(Profile).filter(Profile.user_id == user.id).first()
        if not profile:
            print("%r has no profile yet. Complete onboarding first." % username)
            return

        pid = profile.id
        today = date.today()

        # --- Clear anything a previous run of this script created ---
        removed = (db.query(StartupTransaction)
                   .filter(StartupTransaction.profile_id == pid,
                           StartupTransaction.description.like("%" + DEMO_TAG + "%"))
                   .delete(synchronize_session=False))
        db.query(UpcomingPayment).filter(
            UpcomingPayment.profile_id == pid,
            UpcomingPayment.notes == DEMO_TAG).delete(synchronize_session=False)
        db.query(FinancialGoal).filter(
            FinancialGoal.profile_id == pid,
            FinancialGoal.icon.in_(["🛡️", "✈️"])).delete(synchronize_session=False)
        db.commit()
        if removed:
            print("Cleared %d demo transactions from a previous run." % removed)

        # --- Ledger: ten weeks of plausible salaried activity ---
        # Spread across two calendar months so the month-over-month and
        # weekly-average insight rules have real baselines to compare against.
        pattern = [
            ("out", "Groceries", 2200, [1, 8, 15, 22, 29, 36, 43, 50, 57, 64]),
            ("out", "Food & Dining", 850, [0, 3, 6, 11, 17, 24, 31, 38, 45, 52]),
            ("out", "Travel & Transport", 480, [2, 9, 16, 23, 30, 44, 58]),
            ("out", "Utilities & Bills", 2400, [12, 42]),
            ("out", "Subscriptions", 649, [10, 40]),
            ("out", "Shopping", 6400, [4, 33]),
            ("out", "Health & Medical", 1800, [26]),
            ("out", "Entertainment", 1200, [5, 19, 47]),
            ("in", "Salary", 118000, [7, 37]),
            ("in", "Freelance / Business", 15000, [21]),
        ]
        created = 0
        for kind, category, amount, offsets in pattern:
            for offset in offsets:
                db.add(StartupTransaction(
                    profile_id=pid, type=kind, category=category, amount=float(amount),
                    description="%s %s" % (category, DEMO_TAG),
                    txn_date=today - timedelta(days=offset), source="manual",
                ))
                created += 1

        # --- Goals ---
        db.add(FinancialGoal(
            profile_id=pid, name="Emergency Fund", icon="🛡️", category="emergency_fund",
            target_amount=100000.0, current_amount=68000.0,
            target_date=today + timedelta(days=210), is_primary=True, status="active",
        ))
        db.add(FinancialGoal(
            profile_id=pid, name="Goa Trip", icon="✈️", category="travel",
            target_amount=80000.0, current_amount=57600.0,
            target_date=today + timedelta(days=95), is_primary=False, status="active",
        ))

        # --- Upcoming obligations ---
        for name, amount, days, recurrence, category in [
            ("Netflix", 649, 1, "monthly", "Subscriptions"),
            ("Electricity Bill", 2400, 3, "monthly", "Utilities & Bills"),
            ("Credit Card Payment", 12000, 8, "monthly", "Other expense"),
            ("Home Rent", 26000, 12, "monthly", "Rent / Housing"),
            ("Car Insurance", 18400, 74, "yearly", "Other expense"),
        ]:
            db.add(UpcomingPayment(
                profile_id=pid, name=name, amount=float(amount),
                due_date=today + timedelta(days=days), category=category,
                recurrence=recurrence, is_active=True, source="manual", notes=DEMO_TAG,
            ))

        db.commit()

        # Keep the legacy Profile.goal blob (read by What-If and Ask Twin)
        # pointed at the new primary goal.
        sync_legacy_profile_goal(db, profile)
        db.commit()

        print("Seeded %s: %d transactions, 2 goals, 5 upcoming payments." % (username, created))
        print("Open the dashboard and the Daily Home will compute every figure from these rows.")
    finally:
        db.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    seed(sys.argv[1])
