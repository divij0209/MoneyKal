from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, Date, ForeignKey, JSON, Text, UniqueConstraint, Index
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from datetime import datetime

from backend.database import Base

class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True)
    hashed_password = Column(String)

    # Terms & Conditions acceptance. Recorded when the client sends it with
    # /auth/register or /auth/login, so an account carries evidence of which
    # version of the document was accepted and when.
    #
    # Rows that predate this default to False rather than to a version nobody
    # actually saw; they are filled in on the account's next sign-in, because
    # the login route records acceptance too.
    terms_accepted = Column(Boolean, default=False, nullable=False, server_default="0")
    terms_version = Column(String, nullable=True)
    terms_accepted_at = Column(DateTime, nullable=True)

    # When the account was created. NULL for accounts that predate the column:
    # their real sign-up date is unknown, and a guess would be worse than none.
    # Read by Kal Coins to tell a friend who joined through an invite apart
    # from someone who already had an account.
    created_at = Column(DateTime, nullable=True, default=datetime.utcnow)

    # Kal Coins balance — a cache of SUM(coin_transactions.coins) for this user,
    # updated in the same transaction as every ledger row. The ledger is the
    # record; this column only saves summing it on every read.
    kal_coin_balance = Column(Integer, nullable=False, default=0, server_default="0")

    # --- MoneyKal PIN -------------------------------------------------------
    # A device-unlock PIN, not a second password: it can only turn a valid,
    # unexpired device token into an access token, and it is useless on its own.
    #
    # bcrypt, via the same hash_password/verify_password helpers the account
    # password uses. It lives here rather than in Profile.raw_inputs for two
    # reasons: raw_inputs is returned verbatim by GET /profile/me, and a bcrypt
    # hash of a four-digit PIN in the browser is ten thousand guesses offline;
    # and POST /onboard/confirm reassigns raw_inputs wholesale, which would
    # silently destroy it. Both columns are nullable — a NULL pin_hash means the
    # account has no PIN, which is every account that existed before this.
    pin_hash = Column(String, nullable=True)
    pin_set_at = Column(DateTime, nullable=True)

    profile = relationship("Profile", back_populates="user", uselist=False)

class Profile(Base):
    __tablename__ = "profiles"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    key = Column(String, default="individual")
    label = Column(String, default="Individual")
    persona = Column(String, default="")
    currency = Column(String, default="₹")
    
    # We store these as JSON to easily adapt to the frontend's dynamic structure
    metrics = Column(JSON, default=[])
    goal = Column(JSON, default={})
    decisionTypes = Column(JSON, default=[])
    raw_inputs = Column(JSON, default={})
    
    auto_sweep_enabled = Column(Boolean, default=False)
    sweep_rules = Column(JSON, default={})
    
    # --- Daily AI Insight scheduling ---------------------------------------
    # `insights_schedule` predates the scheduling UI and already held the
    # frequency, so it is reused rather than replaced; 'weekdays' joins the
    # values it accepts. The two columns beside it are what the Overview's
    # Schedule dialog needed and the column could not express: a time of day,
    # and an off switch that does not require inventing a fourth frequency.
    insights_schedule = Column(String, default="daily")  # hourly|daily|weekdays|weekly
    insights_enabled = Column(Boolean, default=True)
    insights_time = Column(String, default="09:00")      # 'HH:MM', 24-hour
    whatsapp_phone = Column(String, nullable=True)  # E.164 format e.g. 919876543210
    
    user = relationship("User", back_populates="profile")
    alerts = relationship("Alert", back_populates="profile")
    history = relationship("DecisionHistory", back_populates="profile")
    audit_traces = relationship("AuditTrace", back_populates="profile")
    simulations = relationship("SimulationRun", back_populates="profile", cascade="all, delete-orphan")
    chat_sessions = relationship("ChatSession", back_populates="profile")
    startup_profile = relationship("StartupProfile", back_populates="profile", uselist=False, cascade="all, delete-orphan")
    enterprise_profile = relationship("EnterpriseProfile", back_populates="profile", uselist=False, cascade="all, delete-orphan")
    startup_snapshots = relationship("StartupMetricSnapshot", back_populates="profile", cascade="all, delete-orphan")
    startup_transactions = relationship("StartupTransaction", back_populates="profile", cascade="all, delete-orphan")
    startup_decisions = relationship("StartupDecisionLog", back_populates="profile", cascade="all, delete-orphan")
    startup_weekly_reports = relationship("StartupWeeklyReport", back_populates="profile", cascade="all, delete-orphan")

class Alert(Base):
    __tablename__ = "alerts"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"))
    level = Column(String) # 'warn', 'info'
    text = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    profile = relationship("Profile", back_populates="alerts")

class DecisionHistory(Base):
    __tablename__ = "decision_history"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"))
    title = Column(String)
    date_str = Column(String)
    outcome = Column(String)
    tag = Column(String) # 'good', 'warn'
    
    profile = relationship("Profile", back_populates="history")

class SimulationRun(Base):
    """One completed run of POST /twin/simulate-scenario, kept whole.

    `decision_history` above stores a one-line summary for the Overview list.
    That is enough to say *that* a decision was explored, but not enough to
    show it again — so this table keeps the entire ScenarioSimulateResponse in
    `result`, and the Simulate tab reopens a past run by rendering that payload
    through the same component that rendered it live. The scalar columns are
    denormalised copies of fields inside `result`, so the history list can be
    built without deserialising every stored run.
    """
    __tablename__ = "simulation_runs"
    # The history list is always "this profile's runs, newest first", so the
    # composite index serves that ordering directly. Declared here to match
    # what migration b4d7f2a91c53 actually created — without it, every
    # `alembic revision --autogenerate` quietly proposes dropping that index
    # and adding a single-column one, and that drift rides along into whatever
    # unrelated migration a teammate happens to be generating.
    __table_args__ = (
        Index("ix_simulation_runs_profile_created", "profile_id", "created_at"),
    )
    id = Column(String, primary_key=True, index=True)  # uuid4 hex
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    scenario = Column(Text)
    scenario_type = Column(String)
    mode = Column(String, default="scenario")  # 'scenario' | 'informational'
    headline = Column(String)  # trimmed recommendation, for the list row
    result = Column(JSON)      # the full ScenarioSimulateResponse
    created_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("Profile", back_populates="simulations")

class AuditTrace(Base):
    __tablename__ = "audit_traces"
    id = Column(String, primary_key=True) # UUID for request_id
    profile_id = Column(Integer, ForeignKey("profiles.id"))
    timestamp = Column(DateTime, default=datetime.utcnow)
    query = Column(String)
    response = Column(JSON)
    reasoning_trace = Column(JSON)
    sources = Column(JSON)
    
    profile = relationship("Profile", back_populates="audit_traces")

class MarketData(Base):
    __tablename__ = "market_data"
    id = Column(Integer, primary_key=True, index=True)
    symbol = Column(String, index=True)
    asset_type = Column(String) # 'stock', 'forex', 'mutual_fund'
    price = Column(Float)
    timestamp = Column(DateTime, default=datetime.utcnow)

class NewsItem(Base):
    __tablename__ = "news_items"
    id = Column(Integer, primary_key=True, index=True)
    headline = Column(String)
    summary = Column(String)
    sentiment = Column(String) # 'positive', 'neutral', 'negative'
    category = Column(String)
    timestamp = Column(DateTime, default=datetime.utcnow)

class EconomicIndicator(Base):
    __tablename__ = "economic_indicators"
    id = Column(Integer, primary_key=True, index=True)
    indicator_name = Column(String, index=True)
    value = Column(Float)
    timestamp = Column(DateTime, default=datetime.utcnow)

class ChatSession(Base):
    __tablename__ = "chat_sessions"
    id = Column(String, primary_key=True) # UUID
    profile_id = Column(Integer, ForeignKey("profiles.id"))
    title = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    profile = relationship("Profile", back_populates="chat_sessions")
    messages = relationship("ChatMessage", back_populates="session", order_by="ChatMessage.created_at", cascade="all, delete-orphan")

class ChatMessage(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("chat_sessions.id"))
    role = Column(String) # 'user' or 'twin'
    content = Column(String)
    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("ChatSession", back_populates="messages")


class ChatDiscoveryState(Base):
    """The Financial Discovery layer's memory for one conversation.

    ChatMessage stores what was said; this stores what was *established* — the
    decision being explored, the slots filled in so far, which questions have
    already been spent, and whether a challenge has been issued. Keeping that
    in a row rather than re-deriving it from the transcript on every turn is
    what makes "never ask the same question twice" a guarantee instead of a
    prompt instruction the model may ignore.

    One row per session, created lazily on the first turn that discovers
    anything. A conversation with no row behaves exactly as conversations did
    before this layer existed, which is what keeps every pre-existing session
    working untouched.
    """
    __tablename__ = "chat_discovery_states"
    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, ForeignKey("chat_sessions.id"), unique=True, index=True)

    decision_type = Column(String, default="none")
    user_intent = Column(String, nullable=True)
    # The full ConversationDiscoveryState (backend/schemas/discovery_models.py)
    # as JSON. Stored whole rather than as columns because the slot vocabulary
    # is expected to grow with the decision types the twin understands.
    state = Column(JSON, default={})
    # The last structured DecisionContext handed to Simulation, so the CTA
    # still works if the user taps it after reopening the conversation.
    decision_context = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    session = relationship("ChatSession")


# ---------------------------------------------------------------------------
# Startup journey — kept fully separate from the Individual profile's
# metrics/goal/decisionTypes JSON blobs above. All financial fields are
# nullable: onboarding never fabricates a value the founder didn't provide.
# ---------------------------------------------------------------------------

class StartupProfile(Base):
    __tablename__ = "startup_profiles"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), unique=True, index=True)

    # Founder
    founder_name = Column(String)
    founder_email = Column(String)
    founder_mobile = Column(String)
    preferred_language = Column(String)

    # Company
    company_name = Column(String)
    industry = Column(String)
    business_model = Column(String)
    founded_year = Column(Integer)
    stage = Column(String)
    location = Column(String)
    website = Column(String)
    headcount = Column(Integer)  # current headcount — also Team > Current Headcount
    gst_number = Column(String, nullable=True)

    # Revenue
    is_pre_revenue = Column(Boolean, default=False)
    monthly_revenue = Column(Float)
    revenue_streams = Column(JSON, default=[])
    revenue_growth_pct_input = Column(Float)  # founder-estimated MoM growth %, used until real history exists
    paying_customers = Column(Integer)

    # Expenses
    fixed_costs = Column(Float)
    variable_costs = Column(Float)

    # Cash
    current_cash = Column(Float)
    monthly_burn_input = Column(Float)  # fallback gross burn if fixed/variable costs weren't itemized

    # Debt
    business_loans_debt = Column(Float)

    # Funding
    total_funding = Column(Float)
    last_round = Column(String)
    currently_fundraising = Column(Boolean, default=False)
    fundraising_target = Column(Float)

    # Team
    planned_hires = Column(Integer)
    cost_per_hire = Column(Float)  # fully-loaded monthly cost per hire

    # Goals — list of {type, label, target_value, target_unit, target_date}
    goals = Column(JSON, default=[])

    # Current financial decision the founder is weighing at onboarding time
    current_decision = Column(String)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile", back_populates="startup_profile")


class EnterpriseProfile(Base):
    __tablename__ = "enterprise_profiles"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), unique=True, index=True)

    # Executive details
    cfo_name = Column(String, nullable=True)
    corporate_email = Column(String, nullable=True)
    corporate_mobile = Column(String, nullable=True)

    # Organization details
    org_name = Column(String, nullable=True)
    industry = Column(String, nullable=True)
    headcount = Column(Integer, nullable=True)
    gst_number = Column(String, nullable=True)

    # Financial details
    treasury_balance = Column(Float, nullable=True)
    annual_turnover = Column(Float, nullable=True)
    quarterly_cash_flow = Column(Float, nullable=True)
    operating_expenses = Column(Float, nullable=True)
    fx_exposure_pct = Column(Float, nullable=True)
    currently_fundraising = Column(Boolean, default=False)
    debt_amount = Column(Float, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile", back_populates="enterprise_profile")


class StartupMetricSnapshot(Base):
    __tablename__ = "startup_metric_snapshots"
    __table_args__ = (UniqueConstraint("profile_id", "snapshot_date", name="uq_startup_snapshot_profile_date"),)
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    snapshot_date = Column(Date, index=True)
    cash = Column(Float)
    gross_burn = Column(Float)
    net_burn = Column(Float)
    revenue = Column(Float)
    runway_months = Column(Float)
    financial_health_score = Column(Float)
    raw = Column(JSON, default={})  # full computed metric bundle, for report reuse
    created_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("Profile", back_populates="startup_snapshots")


class StartupTransaction(Base):
    """Hisaab ledger — money in / money out, categorized."""
    __tablename__ = "startup_transactions"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    type = Column(String)  # 'in' | 'out'
    category = Column(String)
    amount = Column(Float)
    description = Column(String)
    txn_date = Column(Date, default=lambda: datetime.utcnow().date())
    source = Column(String, default="manual")  # 'manual' | 'auto' (Gmail, later)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile", back_populates="startup_transactions")


class StartupDecisionLog(Base):
    """Recent Decisions — every onboarded/simulated startup decision, with its computed outcome."""
    __tablename__ = "startup_decision_log"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    title = Column(String)
    decision_type = Column(String)
    scenario_text = Column(String)
    result_summary = Column(JSON, default={})
    tag = Column(String)  # 'good' | 'warn' | 'neutral'
    created_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("Profile", back_populates="startup_decisions")


class GmailConnection(Base):
    """One row per profile that has connected Gmail for auto-import.
    Stores OAuth tokens so the scheduler can pull mail on their behalf."""
    __tablename__ = "gmail_connections"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    email_address = Column(String)
    access_token = Column(Text)
    refresh_token = Column(Text)
    token_expiry = Column(DateTime)
    last_synced_at = Column(DateTime)
    last_history_id = Column(String)  # Gmail's cursor, avoids re-scanning old mail
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile")


class StartupWeeklyReport(Base):
    """A saved snapshot of a Mon-Sun weekly spend + suggestions report. One row
    per (profile, week_start) — idempotent, generated on-demand and cached here
    so past weeks' reports stay stable even as new transactions get logged."""
    __tablename__ = "startup_weekly_reports"
    __table_args__ = (UniqueConstraint("profile_id", "week_start", name="uq_weekly_report_profile_week"),)
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    week_start = Column(Date, index=True)  # Monday
    week_end = Column(Date)                # Sunday
    currency = Column(String, default="₹")
    category_spend = Column(JSON, default={})
    flags = Column(JSON, default=[])
    suggestions = Column(JSON, default=[])
    created_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("Profile", back_populates="startup_weekly_reports")


# ---------------------------------------------------------------------------
# Daily Home — the Individual's day-to-day layer.
#
# Deliberately additive: neither table duplicates a balance, a transaction or a
# metric that already exists. Money movement stays in StartupTransaction (the
# Hisaab ledger, which is keyed on profile_id and already shared by both
# personas); the stated position stays in Profile.raw_inputs/metrics. These two
# tables only add what the codebase genuinely had no structure for — what the
# user is saving *towards*, and what is about to leave their account.
# ---------------------------------------------------------------------------

class FinancialGoal(Base):
    """A savings target the user is working towards.

    `Profile.goal` (a single JSON blob) predates this and is still read by
    What-If, Ask Twin and Market Pulse, so it is kept in sync as a mirror of
    whichever goal is primary rather than being torn out — see
    `home_service.sync_legacy_profile_goal`."""
    __tablename__ = "financial_goals"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)

    name = Column(String)
    icon = Column(String, nullable=True)           # a single emoji, optional
    category = Column(String, nullable=True)       # emergency_fund | travel | purchase | investment | custom
    target_amount = Column(Float)
    # What the user has actually put aside. Never inferred from their total
    # savings — a goal pot and a bank balance are different things, and
    # conflating them would show a number the user never agreed to.
    current_amount = Column(Float, default=0.0)
    target_date = Column(Date, nullable=True)

    is_primary = Column(Boolean, default=False)
    status = Column(String, default="active")      # active | achieved | archived
    shared_with_profile_ids = Column(JSON, default=[])

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile")


class UpcomingPayment(Base):
    """A known future outflow — a bill, subscription, EMI or one-off obligation.

    `due_date` always holds the *next* occurrence. For recurring items the next
    occurrence is derived on read (see `home_service.next_occurrence`) rather
    than by mutating rows on a schedule, so the list is correct even if nothing
    has rolled it forward. Kept intentionally small: this is what the Daily Home
    needs, not a standalone bill-management product."""
    __tablename__ = "upcoming_payments"
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)

    name = Column(String)
    amount = Column(Float)
    due_date = Column(Date, index=True)
    category = Column(String, nullable=True)       # reuses the Hisaab 'out' category vocabulary
    recurrence = Column(String, default="none")    # none | weekly | monthly | quarterly | yearly

    is_active = Column(Boolean, default=True)
    source = Column(String, default="manual")      # 'manual' | 'gmail' (extensible: 'sms', 'whatsapp')
    notes = Column(String, nullable=True)
    last_paid_on = Column(Date, nullable=True)

    # --- Unified financial-event fields -------------------------------------
    # This table is the single store for dated money events, so the Financial
    # Calendar has one place to read from rather than a parallel deadline
    # system. Both columns default to the table's existing meaning, so every
    # row written before they existed keeps behaving exactly as it did.
    #
    # direction widens the row from "a future outflow" to "a future cash event"
    # — an expected salary is a calendar event too, and it has nowhere else to
    # live. Totals that mean "money leaving" must filter on this.
    direction = Column(String, default="out")      # out | in
    # What kind of event this is, for the calendar's icon and grouping. The
    # Gmail detector already classifies this (bill / credit_card / emi /
    # subscription / insurance) and used to discard it; persisting it avoids
    # re-deriving the type from the category string later.
    event_type = Column(String, nullable=True)     # bill | credit_card | emi | subscription
                                                   # | insurance | tax | investment | salary | other

    # --- Review state -------------------------------------------------------
    # Detected obligations are not allowed to silently become financial facts.
    # 'confirmed' rows behave exactly as manually-added ones always have (and is
    # the default, so every pre-existing row keeps its behaviour); 'review' rows
    # are suggestions awaiting the user's yes/no and are kept out of every total;
    # 'dismissed' rows are remembered only so the same email is never re-suggested.
    status = Column(String, default="confirmed")   # confirmed | review | dismissed
    confidence = Column(Float, nullable=True)      # 0-1, set by the detector; null when manual

    # --- Source metadata ----------------------------------------------------
    # Enough to prove where a row came from and to dedupe re-syncs, and no more:
    # source_ref holds the Gmail message id, source_meta the sender domain, a
    # truncated subject and what the detector matched on. The email body is
    # never stored.
    source_ref = Column(String, nullable=True, index=True)
    source_meta = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile")



# ---------------------------------------------------------------------------
# Budget Goals - monthly spending limits per category
# ---------------------------------------------------------------------------

class BudgetGoal(Base):
    """Monthly spending limit for a specific expense category.

    When a user's spending in a category approaches or exceeds the limit,
    the scheduler fires a WhatsApp alert. `last_alerted_at` prevents duplicate
    alerts being sent within the same day."""
    __tablename__ = "budget_goals"

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)

    category = Column(String, nullable=False)        # matches Hisaab category vocab
    monthly_limit = Column(Float, nullable=False)    # max spend for the month in profile currency
    is_active = Column(Boolean, default=True)
    notes = Column(String, nullable=True)

    # Alert throttling - set to now() when a warning is sent so the scheduler
    # won't fire again until the next calendar day.
    last_alerted_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile")


class TaxProfile(Base):
    """
    Saved inputs for the Individual Tax Calculator.

    One row per profile per tax year, so a user can keep a working set for the
    current year without losing last year's. The income-head inputs live in a
    single JSON blob rather than fifty columns: the shape is owned by
    backend/schemas/tax_models.py and changes with the Finance Act every year,
    which is exactly the kind of churn a rigid schema handles badly.

    Nothing here is authoritative for filing - see the disclaimer surfaced with
    every computation.
    """
    __tablename__ = "tax_profiles"
    __table_args__ = (UniqueConstraint("profile_id", "tax_year", name="uq_tax_profile_year"),)

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)

    # e.g. "FY2026-27" - matches a key in backend/core/config/tax_config.TAX_YEARS
    tax_year = Column(String, nullable=False)

    # Serialised TaxProfileInput
    inputs = Column(JSON, default={})

    # Last computed result, cached so the UI can render without recomputing.
    # Always regenerated from `inputs` on demand; never trusted as a source of truth.
    last_result = Column(JSON, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    profile = relationship("Profile")



class GSTProfile(Base):
    """
    Saved inputs for the Startup GST Calculator.

    One row per profile per financial year, mirroring TaxProfile on the
    Individual side, so a founder keeps a working set for the current year
    without losing last year's. The invoice lines and settings live in a single
    JSON blob rather than a rigid schema: the shape is owned by
    backend/schemas/gst_models.py and moves whenever the GST Council changes
    the rate structure.

    Nothing here is authoritative for filing - see the disclaimer surfaced with
    every computation.
    """
    __tablename__ = "gst_profiles"
    __table_args__ = (UniqueConstraint("profile_id", "fy", name="uq_gst_profile_fy"),)

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)

    # e.g. "FY2026-27"
    fy = Column(String, nullable=False)

    inputs = Column(JSON, default={})
    last_result = Column(JSON, default={})

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ComplianceFiling(Base):
    """
    What a founder has told the Compliance Center about one statutory deadline.

    Without this the calendar could only say a deadline had PASSED, never that
    it had been MET, so every company older than a month showed overdue filings
    and a penalty bill it did not owe. One row per profile per obligation per
    due date:

      * status 'filed' with `filed_on` — met; a date after the due date is
        reported as filed late, with the fee actually incurred.
      * status 'not_applicable' — the obligation does not apply this period
        (e.g. DIR-3 KYC outside the director's three-year cycle).
      * status 'pending' — not filed; kept only to hold `amount`.

    `amount` is the tax or contribution due for the period, as the founder
    knows it. It replaces the transaction-based estimate as the base for
    interest, and is what makes PF, ESI and advance-tax interest computable at
    all. The obligation's rules live in config/compliance_config.py; this row
    only records facts about one occurrence of it.
    """
    __tablename__ = "compliance_filings"
    __table_args__ = (
        UniqueConstraint("profile_id", "obligation_id", "due_date", name="uq_compliance_filing_occurrence"),
    )

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True, nullable=False)
    obligation_id = Column(String, nullable=False)   # key into compliance_config.OBLIGATIONS
    due_date = Column(Date, nullable=False)
    status = Column(String, nullable=False, default="filed")  # filed | not_applicable | pending
    filed_on = Column(Date, nullable=True)
    amount = Column(Float, nullable=True)
    note = Column(String, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ExperienceBadge(Base):
    """Gamification: Badges awarded for completing Live Life Fully itineraries on budget."""
    __tablename__ = "experience_badges"
    
    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    name = Column(String, nullable=False)
    icon = Column(String, nullable=False)
    description = Column(String, nullable=True)
    earned_at = Column(DateTime, default=datetime.utcnow)
    
    profile = relationship("Profile")


class SharedGoal(Base):
    """Multiplayer: Tracks users sharing a single budget goal."""
    __tablename__ = "shared_goals"
    
    id = Column(Integer, primary_key=True, index=True)
    # The owner who created the stash/goal
    owner_profile_id = Column(Integer, ForeignKey("profiles.id"), index=True)
    # The exact JSON structure of a FinancialGoal for the shared stash
    goal_data = Column(JSON, default={})
    # List of phone numbers or email addresses sharing this goal
    participants = Column(JSON, default=[])
    split_count = Column(Integer, default=1)
    
    created_at = Column(DateTime, default=datetime.utcnow)
    
    owner_profile = relationship("Profile")


# ===========================================================================
# Notifications — general MoneyKal infrastructure
#
# The codebase had no stored notification of any kind before this: `Alert` is
# computed live for the startup dashboard and never persisted, and WhatsApp
# messages are fire-and-forget. Split needs an inbox with read/unread state and
# deep links, and so will everything after it, so this table is deliberately
# domain-agnostic — nothing about its shape is specific to splitting.
# ===========================================================================

class Notification(Base):
    """One entry in a user's notification inbox.

    Keyed on user_id rather than profile_id, unlike most of this schema. A
    notification is addressed to a *person* — "Harshit added you to Goa Trip" —
    and has to be deliverable before the recipient has finished onboarding a
    profile, which the profile-scoped tables cannot express.

    `link_type`/`link_id` are a deliberate loose coupling instead of a nullable
    FK per target kind: the inbox must be able to point at a group, an expense,
    a settlement or a friend without this table growing a column every time
    something new becomes notifiable. The client maps the pair to a route.
    """
    __tablename__ = "notifications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)

    # Machine-readable kind, e.g. split_expense_added, split_settlement_received.
    # Prefixed by domain so a future non-Split producer cannot collide.
    kind = Column(String, nullable=False, index=True)
    title = Column(String, nullable=False)
    body = Column(String, nullable=True)

    link_type = Column(String, nullable=True)   # split_group | split_expense | split_friend | split_settlement
    link_id = Column(String, nullable=True)

    # Extra display payload (amounts, actor name) so the inbox can render a rich
    # row without re-querying the domain object that produced it — which may by
    # then have been deleted.
    meta = Column(JSON, default={})

    is_read = Column(Boolean, default=False, index=True)
    read_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)


class NotificationPreference(Base):
    """Per-user delivery switches.

    A row is created lazily on first read; absence means "all defaults on",
    so a user who has never opened settings still gets notified.
    """
    __tablename__ = "notification_preferences"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, index=True, nullable=False)

    in_app_enabled = Column(Boolean, default=True)
    whatsapp_enabled = Column(Boolean, default=False)   # opt-in: costs money and is intrusive

    # Category switches. Split is one category today; more will follow.
    split_enabled = Column(Boolean, default=True)
    split_expense_added = Column(Boolean, default=True)
    split_expense_updated = Column(Boolean, default=True)
    split_settlement = Column(Boolean, default=True)
    split_group_activity = Column(Boolean, default=True)
    split_friend_activity = Column(Boolean, default=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DailyInsight(Base):
    """The Daily AI Insight the scheduler produced for one profile on one day.

    Deliberately NOT a notification, and it must never become one. The two are
    separate systems: an insight is a reading of your money that lives in the
    Overview's Daily AI Insights section, while `Notification` is an inbox of
    events addressed to a person. Putting insights in the inbox would mean the
    bell lit up every morning with something that is not an event.

    It exists because GET /home computed the insight fresh on every request,
    which made `profiles.insights_schedule` decorative — there was no moment at
    which anything was "generated", so a time of day had nothing to attach to.
    The scheduler now writes a row here when a profile is due, and /home reads
    it back. When no row exists the endpoint falls through to computing live,
    so a user who never opens the dialog, or a deployment with no scheduler
    running, sees exactly what they saw before.

    One row per profile per day, enforced by a unique constraint rather than
    read-then-write, so two scheduler ticks racing cannot double-write.
    """
    __tablename__ = "daily_insights"
    __table_args__ = (
        UniqueConstraint("profile_id", "generated_for", name="uq_daily_insight_profile_day"),
    )

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True, nullable=False)

    # The date this insight speaks for, in the schedule's own reckoning.
    generated_for = Column(Date, nullable=False, index=True)

    # The serialized Insight exactly as home_insights produced it, so /home can
    # hand it to the client without recomputing — and so the row still renders
    # after the figures behind it have moved on.
    payload = Column(JSON, default={})

    created_at = Column(DateTime, default=datetime.utcnow)

    profile = relationship("Profile")


# ===========================================================================
# Subscription — general MoneyKal infrastructure
#
# Also new. There was no plan/entitlement concept anywhere in the codebase, so
# rather than inventing a Split-only paywall this models the account-level
# subscription that any feature can gate against.
# ===========================================================================

class Subscription(Base):
    """The plan a user is on.

    No row means free — the absence of a subscription is a valid, fully
    functional state, which is what keeps every existing account working and
    the viral Split loop unpaywalled.
    """
    __tablename__ = "subscriptions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, index=True, nullable=False)

    plan = Column(String, default="free")            # free | premium
    status = Column(String, default="active")        # active | cancelled | expired
    started_at = Column(DateTime, default=datetime.utcnow)
    # NULL = no expiry. A past date means the entitlement has lapsed; the
    # resolver checks this rather than trusting `plan` alone, so a stale row
    # cannot keep granting access.
    expires_at = Column(DateTime, nullable=True)

    source = Column(String, default="manual")        # manual | promo | payment_gateway | demo
    meta = Column(JSON, default={})

    # Which ACT pass the current period came from. NULL for rows granted by
    # hand or by promo, which have no cycle. Passes are prepaid and never
    # renew by themselves, so there is no gateway mandate id to keep here.
    billing_cycle = Column(String, nullable=True)    # monthly | yearly

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ===========================================================================
# Billing — orders, pay-per-use services and free-tier usage
#
# See backend/core/config/pricing_config.py for the prices and limits these rows
# refer to. Amounts are integer paise (`*_minor`), as in Money Splits.
# ===========================================================================

class BillingOrder(Base):
    """One checkout: an ACT pass or a pay-per-use service.

    Written before payment and moved to 'paid' only once payment is confirmed,
    so an abandoned checkout leaves a 'created' or 'processing' row rather than
    an entitlement.

    `payment_mode` is 'demo' until a real gateway is connected — it is the
    order's provider. In demo mode `gateway_order_id` holds the MK-DEMO-…
    reference the UPI QR was issued with: it is UNIQUE, which is what stops one
    transaction being confirmed as two, and `gateway_payment_id` stands in for
    the settlement id a gateway would return.
    """
    __tablename__ = "billing_orders"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)

    sku = Column(String, nullable=False)             # key into pricing_config
    kind = Column(String, nullable=False)            # act_pass | service
    subject_ref = Column(String, nullable=True)      # e.g. 'FY2026-27' for the Tax Calculator

    gross_minor = Column(Integer, nullable=False)
    coins_redeemed = Column(Integer, nullable=False, default=0, server_default="0")
    coin_discount_minor = Column(Integer, nullable=False, default=0, server_default="0")
    payable_minor = Column(Integer, nullable=False)
    currency = Column(String, nullable=False, default="INR", server_default="INR")

    # created (priced) | processing (QR issued) | paid | failed | cancelled
    status = Column(String, nullable=False, default="created", server_default="created")
    payment_mode = Column(String, nullable=False, default="demo", server_default="demo")  # the provider
    # upi_qr | coins. Rows written before the method picker was removed may
    # also hold upi, card or netbanking.
    payment_method = Column(String, nullable=True)
    gateway_order_id = Column(String, nullable=True, unique=True)   # the transaction reference
    gateway_payment_id = Column(String, nullable=True)
    meta = Column(JSON, default={})

    paid_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ServiceEntitlement(Base):
    """A paid right to one pay-per-use service for one subject.

    Only purchases are stored. Access that comes with ACT is resolved at read
    time instead, so it ends the moment the pass does and never leaves a row
    behind that has to be cleaned up.
    """
    __tablename__ = "service_entitlements"
    __table_args__ = (
        UniqueConstraint("user_id", "sku", "subject_ref", name="uq_service_entitlement_subject"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    sku = Column(String, nullable=False)
    subject_ref = Column(String, nullable=False)
    order_id = Column(Integer, ForeignKey("billing_orders.id"), nullable=True)
    status = Column(String, nullable=False, default="active", server_default="active")  # active | revoked

    created_at = Column(DateTime, default=datetime.utcnow)


class UsageCounter(Base):
    """How much of a free monthly allowance a user has used.

    One row per user, allowance and calendar month ('2026-09'). A new month
    simply has no row yet, which reads as zero, so nothing has to reset them.
    """
    __tablename__ = "usage_counters"
    __table_args__ = (
        UniqueConstraint("user_id", "feature_key", "period", name="uq_usage_counter_period"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    feature_key = Column(String, nullable=False)     # key into pricing_config.FREE_QUOTAS
    period = Column(String, nullable=False)          # 'YYYY-MM', UTC
    count = Column(Integer, nullable=False, default=0, server_default="0")

    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CoinTransaction(Base):
    """One entry in a user's Kal Coins ledger. Rows are never updated or deleted.

    `coins` is signed: positive when earned, negative when redeemed. Every
    change to users.kal_coin_balance has exactly one row here, written in the
    same transaction, and `balance_after` records the balance it produced, so
    the history can be audited line by line.

    `idempotency_key` is unique and names the event a row is for (e.g.
    "friend_invite:42"), so the same reward or redemption can never be recorded
    twice however often the check that grants it runs.

    There is deliberately no counterparty column: coins only ever move between
    a user and MoneyKal, never between users.
    """
    __tablename__ = "coin_transactions"
    __table_args__ = (
        Index("ix_coin_transactions_user_created", "user_id", "created_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    type = Column(String, nullable=False)             # earn | redeem | reversal
    reason = Column(String, nullable=False)           # a COIN_RULES key, or 'checkout'
    coins = Column(Integer, nullable=False)           # signed
    balance_after = Column(Integer, nullable=False)

    source_type = Column(String, nullable=True)       # billing_order | user | profile
    source_id = Column(Integer, nullable=True)
    idempotency_key = Column(String, nullable=False, unique=True)
    meta = Column(JSON, default={})

    created_at = Column(DateTime, default=datetime.utcnow)


# ===========================================================================
# Money Splits
#
# Every amount below is an integer count of minor units (paise for INR) and is
# named `*_minor` to make that impossible to miss at a call site. See
# backend/services/split_math.py for why floats are not used for money.
# ===========================================================================

class SplitPerson(Base):
    """The universal participant identity — the hinge the whole feature turns on.

    Expenses, shares, settlements and group memberships all point here and
    never directly at `users.id`. That indirection is what makes the guest
    story work: a person you invite who has no MoneyKal account is simply a row
    with `user_id IS NULL`, and they can be on expenses, owe money and be owed
    money exactly like anyone else.

    When that person later registers with the same email, `claim_person_for_user`
    sets `user_id` on this existing row. No expense is rewritten, no share is
    migrated, no second user is created — their entire history and balance is
    already attached to the identity they just claimed. Doing it the other way
    round (guests as rows in a separate table, merged on signup) would mean a
    data migration on every registration, which is exactly where duplicates
    come from.

    `email` is the merge key and is stored lowercased, matching how
    auth.normalize_username treats usernames, so "Divij@x.com" signing up
    claims the guest invited as "divij@x.com".
    """
    __tablename__ = "split_persons"

    id = Column(Integer, primary_key=True, index=True)
    # Set once, when a real account claims this identity. Unique so two users
    # can never resolve to the same participant.
    user_id = Column(Integer, ForeignKey("users.id"), unique=True, nullable=True, index=True)

    email = Column(String, unique=True, index=True, nullable=True)
    display_name = Column(String, nullable=False)
    phone = Column(String, nullable=True, index=True)
    avatar_color = Column(String, nullable=True)    # deterministic chip colour, assigned at creation

    # Who first created this identity as a guest. Kept for provenance and so an
    # orphan guest can be cleaned up by its creator; NULL for self-registered users.
    created_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    claimed_at = Column(DateTime, nullable=True)

    user = relationship("User", foreign_keys=[user_id])

    @property
    def is_guest(self) -> bool:
        return self.user_id is None


class SplitFriendship(Base):
    """A symmetric friend link between two participants.

    Stored once per pair with `person_a_id < person_b_id` enforced by the
    service layer, so "are we friends" is a single lookup and the pair cannot
    exist twice in opposite orders.
    """
    __tablename__ = "split_friendships"
    __table_args__ = (
        UniqueConstraint("person_a_id", "person_b_id", name="uq_split_friend_pair"),
    )

    id = Column(Integer, primary_key=True, index=True)
    person_a_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    person_b_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)

    # accepted covers both "they added me back" and "I added a guest", since a
    # guest has no way to accept. pending is for a real user who has not yet
    # responded, so an unwanted contact never appears in their friend list.
    status = Column(String, default="accepted")     # pending | accepted | blocked
    requested_by_person_id = Column(Integer, ForeignKey("split_persons.id"), nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    person_a = relationship("SplitPerson", foreign_keys=[person_a_id])
    person_b = relationship("SplitPerson", foreign_keys=[person_b_id])


class SplitGroup(Base):
    """A shared expense container — a trip, a flat, a dinner series."""
    __tablename__ = "split_groups"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    group_type = Column(String, default="other")     # trip | home | couple | friends | other
    emoji = Column(String, nullable=True)
    currency = Column(String, default="INR")

    created_by_person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)

    # Settings
    simplify_debts = Column(Boolean, default=True)
    is_archived = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    members = relationship("SplitGroupMember", back_populates="group", cascade="all, delete-orphan")
    expenses = relationship("SplitExpense", back_populates="group")


class SplitGroupMember(Base):
    """Membership. This table *is* the authorization boundary for a group —
    every group-scoped endpoint resolves the caller through it rather than
    trusting a group id from the client."""
    __tablename__ = "split_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "person_id", name="uq_split_group_member"),
    )

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("split_groups.id"), index=True, nullable=False)
    person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)

    role = Column(String, default="member")          # owner | member
    is_active = Column(Boolean, default=True)
    joined_at = Column(DateTime, default=datetime.utcnow)

    group = relationship("SplitGroup", back_populates="members")
    person = relationship("SplitPerson")


class SplitExpense(Base):
    """One shared expense.

    `total_minor` is stored, but it is *not* the source of truth for who owes
    what — the shares are. It is kept because it is what the user typed, and
    because a stored total lets the service assert on every write that the
    shares still sum to it.

    An expense can exist without a group (a one-to-one split with a friend), in
    which case `group_id` is NULL and authorization runs off participation
    instead of membership.
    """
    __tablename__ = "split_expenses"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("split_groups.id"), index=True, nullable=True)

    description = Column(String, nullable=False)
    total_minor = Column(Integer, nullable=False)
    currency = Column(String, default="INR")
    expense_date = Column(Date, default=lambda: datetime.utcnow().date(), index=True)
    category = Column(String, nullable=True)
    notes = Column(String, nullable=True)
    receipt_url = Column(String, nullable=True)

    # equal | exact | percent | shares | itemized. Persisted so the edit screen
    # can reopen in the mode the user actually used, rather than reverse-
    # engineering intent from the numbers.
    split_mode = Column(String, default="equal")

    created_by_person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    is_deleted = Column(Boolean, default=False, index=True)
    deleted_at = Column(DateTime, nullable=True)

    # Idempotency key from the client. Unique, so a double-tapped Save or a
    # retried request cannot book the same expense twice.
    client_token = Column(String, unique=True, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    group = relationship("SplitGroup", back_populates="expenses")
    shares = relationship("SplitExpenseShare", back_populates="expense", cascade="all, delete-orphan")
    payers = relationship("SplitExpensePayer", back_populates="expense", cascade="all, delete-orphan")
    items = relationship("SplitExpenseItem", back_populates="expense", cascade="all, delete-orphan")


class SplitExpensePayer(Base):
    """Who actually paid, and how much.

    A separate table rather than a `paid_by` column on the expense, because
    multiple payers is a first-class requirement — two people splitting a
    hotel bill on two cards is ordinary. A single-payer expense is just one row
    here, so there is no special case anywhere in the balance engine.
    """
    __tablename__ = "split_expense_payers"
    __table_args__ = (
        UniqueConstraint("expense_id", "person_id", name="uq_split_expense_payer"),
    )

    id = Column(Integer, primary_key=True, index=True)
    expense_id = Column(Integer, ForeignKey("split_expenses.id"), index=True, nullable=False)
    person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    amount_minor = Column(Integer, nullable=False)

    expense = relationship("SplitExpense", back_populates="payers")
    person = relationship("SplitPerson")


class SplitExpenseShare(Base):
    """What one participant owes for this expense.

    `share_minor` is always the final, rounded, authoritative figure. The
    `weight` column records the input that produced it (a percentage, a number
    of shares) purely so the edit screen can show the user what they typed —
    the balance engine never reads it.
    """
    __tablename__ = "split_expense_shares"
    __table_args__ = (
        UniqueConstraint("expense_id", "person_id", name="uq_split_expense_share"),
    )

    id = Column(Integer, primary_key=True, index=True)
    expense_id = Column(Integer, ForeignKey("split_expenses.id"), index=True, nullable=False)
    person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    share_minor = Column(Integer, nullable=False)
    weight = Column(String, nullable=True)   # Decimal as text: percentage or share count

    expense = relationship("SplitExpense", back_populates="shares")
    person = relationship("SplitPerson")


class SplitExpenseItem(Base):
    """A line on an itemized bill, with its own participants.

    Only present for split_mode='itemized'. Shares are still computed up-front
    and written to SplitExpenseShare, so the balance engine reads one uniform
    structure regardless of how an expense was built.
    """
    __tablename__ = "split_expense_items"

    id = Column(Integer, primary_key=True, index=True)
    expense_id = Column(Integer, ForeignKey("split_expenses.id"), index=True, nullable=False)

    name = Column(String, nullable=False)
    amount_minor = Column(Integer, nullable=False)
    # Person ids sharing this line, equally. JSON rather than a join table: an
    # item is always read as part of its expense and never queried across
    # expenses, so a join table would add a query for no gain.
    participant_person_ids = Column(JSON, default=[])
    position = Column(Integer, default=0)

    expense = relationship("SplitExpense", back_populates="items")


class SplitSettlement(Base):
    """A payment from one person to another.

    Kept in its own table rather than modelled as a negative expense, because
    the two answer different questions: an expense is a cost being shared, a
    settlement is a debt being cleared. Conflating them would put "Harshit paid
    you Rs 500" into the group's spending totals, which is wrong.
    """
    __tablename__ = "split_settlements"

    id = Column(Integer, primary_key=True, index=True)
    group_id = Column(Integer, ForeignKey("split_groups.id"), index=True, nullable=True)

    from_person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    to_person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    amount_minor = Column(Integer, nullable=False)
    currency = Column(String, default="INR")

    method = Column(String, default="cash")          # cash | upi | bank | other
    note = Column(String, nullable=True)
    settled_on = Column(Date, default=lambda: datetime.utcnow().date(), index=True)

    recorded_by_person_id = Column(Integer, ForeignKey("split_persons.id"), nullable=False)
    is_deleted = Column(Boolean, default=False, index=True)
    client_token = Column(String, unique=True, nullable=True, index=True)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    from_person = relationship("SplitPerson", foreign_keys=[from_person_id])
    to_person = relationship("SplitPerson", foreign_keys=[to_person_id])


class SplitInvitation(Base):
    """An outstanding invite, addressed by token.

    The token is the deep link. It is looked up on registration so that signing
    up through an invite lands the new account straight into the group that
    invited them, with the guest identity already claimed.
    """
    __tablename__ = "split_invitations"

    id = Column(Integer, primary_key=True, index=True)
    token = Column(String, unique=True, index=True, nullable=False)

    invited_by_person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    # The guest identity minted for the invitee. Always set, so the invitee can
    # be put on expenses the moment they are invited rather than once they join.
    person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)

    email = Column(String, nullable=True, index=True)
    phone = Column(String, nullable=True)
    group_id = Column(Integer, ForeignKey("split_groups.id"), nullable=True, index=True)

    status = Column(String, default="pending")       # pending | accepted | revoked | expired
    accepted_by_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    accepted_at = Column(DateTime, nullable=True)
    expires_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow)

    person = relationship("SplitPerson", foreign_keys=[person_id])
    invited_by = relationship("SplitPerson", foreign_keys=[invited_by_person_id])
    group = relationship("SplitGroup")


class SplitActivity(Base):
    """The audit trail behind the Activity feed.

    Written on every mutation. Denormalised on purpose: `actor_name` and the
    amount are copied in at write time so a deleted expense still reads as
    "Divij deleted Dinner" rather than collapsing to a dangling id. The feed is
    history, and history should not change when the present does.
    """
    __tablename__ = "split_activities"

    id = Column(Integer, primary_key=True, index=True)

    # expense_added | expense_updated | expense_deleted | settlement_added
    # | settlement_deleted | group_created | member_added | member_left
    # | friend_added | invite_sent | invite_accepted
    kind = Column(String, nullable=False, index=True)

    actor_person_id = Column(Integer, ForeignKey("split_persons.id"), index=True, nullable=False)
    actor_name = Column(String, nullable=True)

    group_id = Column(Integer, ForeignKey("split_groups.id"), index=True, nullable=True)
    expense_id = Column(Integer, ForeignKey("split_expenses.id"), index=True, nullable=True)
    settlement_id = Column(Integer, ForeignKey("split_settlements.id"), index=True, nullable=True)

    summary = Column(String, nullable=False)         # "Divij added Dinner in Goa Trip"
    amount_minor = Column(Integer, nullable=True)
    currency = Column(String, default="INR")
    meta = Column(JSON, default={})

    # Everyone this activity should surface for. JSON list of person ids —
    # the feed filters on it so a user only ever sees activity from groups and
    # expenses they are part of.
    audience_person_ids = Column(JSON, default=[])

    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    actor = relationship("SplitPerson", foreign_keys=[actor_person_id])


class VoiceCallLog(Base):
    """Voice Call Logs for both Vapi and Omnidim AI call sessions."""
    __tablename__ = "voice_call_logs"

    id = Column(Integer, primary_key=True, index=True)
    profile_id = Column(Integer, ForeignKey("profiles.id"), index=True, nullable=True)
    provider = Column(String, default="vapi", index=True)  # 'vapi' or 'omnidim'
    session_id = Column(String, index=True, nullable=True)
    call_type = Column(String, default="inbound")  # 'inbound' or 'outbound'
    phone_number = Column(String, nullable=True)
    status = Column(String, default="completed")  # 'completed', 'failed', 'ongoing'
    duration_seconds = Column(Integer, default=0)
    summary = Column(Text, nullable=True)
    transcript = Column(JSON, default=[])
    ended_reason = Column(String, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, index=True)

    profile = relationship("Profile")

