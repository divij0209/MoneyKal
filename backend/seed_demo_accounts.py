"""Create the two demo accounts, populated, idempotent.

WHY THIS EXISTS
---------------
A reviewer who signs up live meets an empty product: "Spent this month: nothing
logged", three zero tiles on Hisaab, an empty revenue chart, and a Daily Brief
that says day-over-day comparisons start tomorrow. All of that is correct
behaviour for a brand-new account and all of it reads as a hollow product.

This creates one individual and one startup account with real history behind
them, so there is always a populated account to open. It writes through the same
tables the app writes at runtime — no display-only fixtures — so every figure on
screen is computed by the same code path a real user's would be.

    # from the project root
    $env:PYTHONPATH="."          # PowerShell
    python backend/seed_demo_accounts.py

Re-running replaces only what a previous run created. Passing --reset also
clears the demo accounts' chat history and simulation runs.

The password is read from DEMO_ACCOUNT_PASSWORD (set it in backend/.env and
share it through the password manager). It is not in the repository: a working
login committed next to its username is a credential for every database this
script has ever been run against. Do not create these accounts on a database
that holds anyone's real data.
"""
import os
import sys
from datetime import datetime, timedelta

from backend.database import SessionLocal, describe_target
from backend.models.domain import (
    ChatMessage, ChatSession, Profile, SimulationRun, StartupProfile, User,
)
from backend.routers.auth import MIN_PASSWORD_LENGTH, hash_password

DEMO_INDIVIDUAL_USER = "demo@moneykal.app"
DEMO_STARTUP_USER = "founder@moneykal.app"


def demo_password() -> str:
    """The shared demo password, from the environment. backend.database has
    already loaded backend/.env by the time this runs."""
    password = (os.getenv("DEMO_ACCOUNT_PASSWORD") or "").strip()
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(
            "DEMO_ACCOUNT_PASSWORD is not set (or is shorter than %d characters).\n"
            "Add it to backend/.env -- the same value the rest of the team uses -- "
            "and run this again." % MIN_PASSWORD_LENGTH)
    return password


def _ensure_user(db, username: str, password: str) -> User:
    user = db.query(User).filter(User.username == username).first()
    if user:
        # Reset the password on every run so a forgotten change cannot leave the
        # documented credentials wrong on demo day.
        user.hashed_password = hash_password(password)
        db.commit()
        return user
    user = User(username=username, hashed_password=hash_password(password))
    user.terms_accepted = True
    user.terms_version = "1.0"
    user.terms_accepted_at = datetime.utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _trend(end: float, months: int = 6, growth: float = 0.04):
    """A plausible back-history ending at `end`, oldest first."""
    series = []
    value = end / ((1 + growth) ** (months - 1))
    for _ in range(months):
        series.append(round(value, 2))
        value *= (1 + growth)
    series[-1] = round(end, 2)
    return series


def seed_individual(db) -> User:
    user = _ensure_user(db, DEMO_INDIVIDUAL_USER, demo_password())
    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    if not profile:
        profile = Profile(user_id=user.id)
        db.add(profile)
        db.flush()

    income, expenses, savings, loans = 140000.0, 72000.0, 520000.0, 1800000.0

    profile.key = "individual"
    profile.label = "Individual"
    profile.persona = "Ananya Iyer"
    profile.currency = "₹"
    profile.metrics = [
        {"id": "income", "label": "Monthly income", "value": income, "unit": "/mo",
         "trend": _trend(income, growth=0.012), "isPercent": False},
        {"id": "expenses", "label": "Monthly expenses", "value": expenses, "unit": "/mo",
         "trend": _trend(expenses, growth=0.008), "isPercent": False},
        {"id": "savings", "label": "Total savings", "value": savings, "unit": "",
         "trend": _trend(savings, growth=0.09), "isPercent": False},
        {"id": "loans", "label": "Outstanding loans", "value": loans, "unit": "",
         "trend": _trend(loans, growth=-0.01), "isPercent": False},
        {"id": "goal", "label": "Goal progress", "value": 52, "unit": "%",
         "trend": [28, 33, 38, 43, 48, 52], "isPercent": True},
    ]
    profile.goal = {"title": "Emergency fund: ₹10,00,000", "progress": 52, "target": 1000000}
    profile.raw_inputs = {
        "full_name": "Ananya Iyer",
        "email": DEMO_INDIVIDUAL_USER,
        "mobile": "",
        "occupation": "Product Manager",
        "city": "Bengaluru",
        "monthly_income": income,
        "total_savings": savings,
        "monthly_expenses": expenses,
        "outstanding_loans": loans,
        "existing_investments": 380000.0,
        "insurance_coverage": 5000000.0,
        "dependents": 1,
        "goal_title": "Emergency fund",
        "goal_target_amount": 1000000.0,
        "goal_target_date": (datetime.utcnow() + timedelta(days=300)).date().isoformat(),
    }
    db.commit()
    return user


def seed_startup(db) -> User:
    user = _ensure_user(db, DEMO_STARTUP_USER, demo_password())
    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    if not profile:
        profile = Profile(user_id=user.id)
        db.add(profile)
        db.flush()

    profile.key = "startup"
    profile.label = "Startup"
    profile.persona = "Lumen Analytics"
    profile.currency = "₹"
    profile.metrics = [
        {"id": "revenue", "label": "Monthly revenue", "value": 2800000.0, "unit": "/mo",
         "trend": _trend(2800000.0, growth=0.06), "isPercent": False},
        {"id": "burn", "label": "Gross burn", "value": 4100000.0, "unit": "/mo",
         "trend": _trend(4100000.0, growth=0.02), "isPercent": False},
        {"id": "treasury", "label": "Cash balance", "value": 42000000.0, "unit": "",
         "trend": _trend(42000000.0, growth=-0.02), "isPercent": False},
    ]
    profile.goal = {"title": "Series A: ₹25,00,00,000", "progress": 35, "target": 250000000}
    db.commit()

    sp = db.query(StartupProfile).filter(StartupProfile.profile_id == profile.id).first()
    if not sp:
        sp = StartupProfile(profile_id=profile.id)
        db.add(sp)
        db.flush()

    # Only set attributes the model actually declares, so this keeps working if
    # the startup schema gains or loses a column.
    values = {
        "company_name": "Lumen Analytics",
        "stage": "seed",
        "is_pre_revenue": False,
        "monthly_revenue": 2800000.0,
        "revenue_growth_pct_input": 6.0,
        "paying_customers": 118,
        "fixed_costs": 3200000.0,
        "variable_costs": 900000.0,
        "current_cash": 42000000.0,
        "business_loans_debt": 5000000.0,
        "total_funding": 60000000.0,
        "last_round": "seed",
        "currently_fundraising": True,
        "fundraising_target": 250000000.0,
        "headcount": 24,
        "planned_hires": 6,
        "cost_per_hire": 150000.0,
        "founder_name": "Priya Nair",
    }
    applied = []
    for key, value in values.items():
        if hasattr(sp, key):
            setattr(sp, key, value)
            applied.append(key)
    db.commit()
    return user


def reset_conversations(db, users) -> int:
    """Clear chat and simulation history for the demo accounts only."""
    cleared = 0
    for user in users:
        profile = db.query(Profile).filter(Profile.user_id == user.id).first()
        if not profile:
            continue
        sessions = db.query(ChatSession).filter(ChatSession.profile_id == profile.id).all()
        for session in sessions:
            db.query(ChatMessage).filter(ChatMessage.session_id == session.id).delete(
                synchronize_session=False)
            db.delete(session)
            cleared += 1
        db.query(SimulationRun).filter(SimulationRun.profile_id == profile.id).delete(
            synchronize_session=False)
    db.commit()
    return cleared


def main() -> None:
    reset = "--reset" in sys.argv
    demo_password()          # fail before touching the database, not halfway through
    db = SessionLocal()
    try:
        print("Seeding demo accounts into %s" % describe_target())
        individual = seed_individual(db)
        startup = seed_startup(db)
        if reset:
            n = reset_conversations(db, [individual, startup])
            print("Cleared %d chat session(s) and all simulation runs." % n)

        print("")
        print("  Individual  %s" % DEMO_INDIVIDUAL_USER)
        print("  Startup     %s" % DEMO_STARTUP_USER)
        print("  Password    the DEMO_ACCOUNT_PASSWORD value from backend/.env")
        print("")
        print("For a populated Hisaab ledger, goals and upcoming payments on the")
        print("individual account, also run:")
        print("    python backend/seed_home_demo.py %s" % DEMO_INDIVIDUAL_USER)
    finally:
        db.close()


if __name__ == "__main__":
    main()
