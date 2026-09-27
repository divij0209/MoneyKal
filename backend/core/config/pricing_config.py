"""
MoneyKal pricing — the one place prices, plans and free limits are written down.

Follows the MoneyKal Business Model v2 ("free to SEE, paid to ACT"), with the
product decisions taken since that document:

  * Two tiers a user can be *on*: SEE (free forever) and ACT (Premium).
  * ACT is sold as a prepaid pass — 30 days for ₹199 or 365 days for ₹1,499 —
    rather than an auto-renewing mandate, so Kal Coins can be applied to every
    purchase. A pass never renews by itself.
  * Pay-per-use services are bought per subject, not subscribed to. The only
    one today is the Tax Calculator: ₹200 unlocks one tax year, and it is
    included in ACT at no extra charge. Individual profiles only, matching the
    boundary in backend/routers/tax.py.
  * Clarity Dividend is not part of the model.

Every amount is an integer count of paise, named `*_minor`, for the same reason
Money Splits does it (see backend/services/split_math.py): floats are not used
for money.

The existing plan column stores "free" / "premium" (backend/services/
subscription_service.py). Those stored values are unchanged so every existing
account and the Split premium gate keep working; SEE and ACT are the names the
API and the UI use for them.
"""
import os
from typing import Dict, List

CURRENCY = "INR"

# How checkout collects money. Only "demo" exists today: payment is simulated,
# nothing is charged, and the purchase is granted exactly as a real one would
# be. Any other value means a real gateway is expected, and until one is
# connected checkout refuses to take payment rather than granting it for free.
PAYMENT_MODE_DEMO = "demo"
# One method, because the demo checkout shows one: a UPI QR the user scans.
# Card and net banking were dropped with the method picker — a demo cannot
# collect card or bank details, and offering them only implied it could. Orders
# paid before that change keep their stored method; PAYMENT_METHOD_LABELS still
# names those values so history reads correctly.
PAYMENT_METHOD_UPI_QR = "upi_qr"
PAYMENT_METHODS = (PAYMENT_METHOD_UPI_QR,)
# How an order that Kal Coins cover in full is "paid". No money moves, so no
# gateway is involved in any payment mode.
PAYMENT_METHOD_COINS = "coins"

PAYMENT_METHOD_LABELS: Dict[str, str] = {
    PAYMENT_METHOD_UPI_QR: "UPI QR",
    PAYMENT_METHOD_COINS: "Kal Coins",
    # Retired methods, kept only so an older order's receipt still reads.
    "upi": "UPI",
    "card": "Card",
    "netbanking": "Net banking",
}


def payment_mode() -> str:
    # Read at call time, not import time, so it always reflects backend/.env
    # regardless of which module happened to load first.
    return (os.getenv("PAYMENT_MODE") or PAYMENT_MODE_DEMO).strip().lower()


# ---------------------------------------------------------------------------
# Demo payments
# ---------------------------------------------------------------------------

# The simulated UPI checkout: a QR is drawn from the real payable amount, the
# order really moves through the billing tables, and the ACT pass is really
# granted — but no money moves and nothing is verified with any bank. Every
# screen that shows it says so.
#
# This is a switch that hands out paid plans for free, so it is off wherever
# the deployment looks like production unless someone turns it on by name.
# PAYMENT_MODE alone is not enough of a guard: it defaults to "demo", so a
# deployment that simply never set it would otherwise be giving ACT away.
DEMO_UPI_VPA = "demo@moneykal"
DEMO_UPI_PAYEE = "MoneyKal"
DEMO_TXN_PREFIX = "MK-DEMO-"

_TRUE = ("1", "true", "yes", "on")
# NODE_ENV is deliberately not here: it describes a JavaScript build, not this
# deployment, and a shell that happened to export it would switch the demo off
# for reasons that have nothing to do with where the API is running.
_PRODUCTION_ENV_VARS = (
    "APP_ENV", "ENVIRONMENT", "ENV",
    "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_ENVIRONMENT", "VERCEL_ENV",
)


def looks_like_production() -> bool:
    return any((os.getenv(var) or "").strip().lower() in ("production", "prod")
               for var in _PRODUCTION_ENV_VARS)


def demo_payments_enabled() -> bool:
    """Whether the simulated UPI checkout may grant a purchase.

    Set DEMO_PAYMENTS_ENABLED explicitly and that answer is used, either way.
    Left unset, demo payments run everywhere except a deployment that names
    itself production, where they stay off until someone opts in.
    """
    raw = os.getenv("DEMO_PAYMENTS_ENABLED")
    if raw is not None and raw.strip():
        return raw.strip().lower() in _TRUE
    return payment_mode() == PAYMENT_MODE_DEMO and not looks_like_production()


# ---------------------------------------------------------------------------
# Tiers
# ---------------------------------------------------------------------------

TIER_SEE = "see"
TIER_ACT = "act"

TIER_LABELS = {
    TIER_SEE: "SEE — free forever",
    TIER_ACT: "ACT — Premium",
}


# ---------------------------------------------------------------------------
# ACT passes
# ---------------------------------------------------------------------------

ACT_PASSES: Dict[str, Dict] = {
    "act_monthly": {
        "label": "ACT Monthly",
        "billing_cycle": "monthly",
        "duration_days": 30,
        "price_minor": 19900,
    },
    "act_yearly": {
        "label": "ACT Yearly",
        "billing_cycle": "yearly",
        "duration_days": 365,
        "price_minor": 149900,
    },
}


# ---------------------------------------------------------------------------
# Pay-per-use services
# ---------------------------------------------------------------------------

# `subject` says what one purchase covers. For the Tax Calculator that is a tax
# year key from backend/core/config/tax_config.py (e.g. "FY2026-27"): pay once and
# recalculate as often as you like for that year.
SERVICES: Dict[str, Dict] = {
    "tax_calculator": {
        "label": "Tax Calculator",
        "description": "Your full tax calculation, regime comparison and ITR form "
                       "suggestion for one tax year. Recalculate as often as you like.",
        "price_minor": 20000,
        "subject": "tax_year",
        "included_in_act": True,
        "personas": ["individual"],
    },
}


# ---------------------------------------------------------------------------
# What each tier gets
# ---------------------------------------------------------------------------

# Monthly allowances on SEE. ACT removes the limit. Tathya (typed) and Varta
# (voice) draw from one shared pool; a whole Varta conversation counts as one
# question.
FREE_QUOTAS: Dict[str, Dict] = {
    "ask_twin": {
        "label": "Tathya & Varta questions",
        "limit": 10,
    },
    "simulations": {
        "label": "Simulations",
        "limit": 3,
    },
}

# Named so the free tier is a stated promise, not an accident of which checks
# happen to exist. Detection, insights and findings are never paywalled.
SEE_FEATURES: List[str] = [
    "Hisaab — your income and expense ledger",
    "Financial health score",
    "One AI insight every day",
    "Budgets and goals",
    "Market Pulse",
    "Money Splits with friends",
    "10 Tathya & Varta questions a month",
    "3 simulations a month",
]

ACT_FEATURES: Dict[str, str] = {
    "auto_sweep":            "Auto-sweep unspent budget into your goals",
    "unlimited_ask_twin":    "Unlimited Tathya & Varta questions",
    "unlimited_simulations": "Unlimited simulations",
    "analytics":             "Money Splits analytics and CSV export",
    "reports":               "Weekly health and spend reports, with PDF download",
    "gmail_ingest":          "Import bills and payments from Gmail",
    "whatsapp_ingest":       "Log expenses over WhatsApp",
    "tax_calculator":        "Tax Calculator for every tax year, included",
}

# ---------------------------------------------------------------------------
# Kal Coins
# ---------------------------------------------------------------------------

# A reward and discount layer, deliberately NOT a wallet. Coins have a fixed
# value, are earned only for the actions below, are redeemable only against
# MoneyKal's own fees, and can never be bought, sent, gifted or cashed out.
# Those four properties are what keep them outside PPI (Prepaid Payment
# Instrument) licensing, so nothing may be added that breaks any of them.
COIN_VALUE_MINOR = 10  # 1 coin = ₹0.10

# Only rewards the app can verify from its own records. Rewards based on typed
# figures (budgets, goals, streaks) were left out because they can be faked.
COIN_RULES: Dict[str, Dict] = {
    "profile_completed": {
        "label": "Complete your profile",
        "coins": 50,
    },
    "friend_invite": {
        "label": "Invite a friend who joins and uses MoneyKal for 30 days",
        "coins": 50,
        # Invitations live in Money Splits, which is Individual-only.
        "personas": ["individual"],
        # Credited only after the friend has had an account this long ...
        "wait_days": 30,
        # ... and has really used it in that time: active on this many
        # different days (added an entry, a shared expense, or asked Tathya) ...
        "min_active_days": 5,
        # ... and added this many entries (Hisaab entries or shared expenses).
        "min_entries": 10,
        "monthly_limit": 10,
    },
    "act_yearly": {
        "label": "Buy ACT Yearly",
        "coins": 100,
    },
}


# ACT features that only exist for some personas, so the Upgrade page never
# advertises something a user cannot reach. Money Splits and the Tax
# Calculator are Individual-only. Anything not listed applies to every persona.
ACT_FEATURE_PERSONAS: Dict[str, List[str]] = {
    "analytics":      ["individual"],
    "tax_calculator": ["individual"],
}
