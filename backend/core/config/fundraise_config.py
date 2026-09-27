"""
Stage benchmarks for the Startup Fundraise Readiness feature.

EVERY threshold a founder is scored against lives in this file. Nothing in
`services/fundraise_service.py` or the router hardcodes a band — investor
expectations shift with the funding climate, and the point of this module is
that re-tuning them means editing this file and nothing else. Same contract
`config/tax_config.py` holds for statutory rates.

--------------------------------------------------------------------------
WHAT THESE NUMBERS ARE, AND WHAT THEY ARE NOT
--------------------------------------------------------------------------
These are *heuristic bands*, not statutory figures. They encode widely-cited
venture rules of thumb as applied to the Indian market:

  * Burn Multiple bands ......... David Sacks / Craft Ventures framing:
                                  <1 exceptional, 1-1.5 great, 1.5-2 good,
                                  2-3 suspect, >3 bad.
  * Rule of 40 .................. growth% + profit margin% >= 40 for a
                                  healthy growth-stage company.
  * Runway expectations ......... 18 months post-raise is the standard ask;
                                  Indian seed rounds commonly plan to 12-18.
  * Capital efficiency .......... ARR generated per rupee raised; a Series A
                                  company is generally expected to be at or
                                  near 1x cumulative capital.

They are deliberately conservative and are always shown to the founder WITH
the band that produced the judgement, so the verdict is transparent rather
than oracular. A metric is never presented as pass/fail without its threshold.
"""

from typing import Any, Dict, List, Optional


# ---------------------------------------------------------------------------
# Stage normalisation
#
# register.html writes one of: "Pre-Seed", "Seed", "Series A", "Series B+",
# "Bootstrapped". Older rows and free-text edits may carry anything, so the
# normaliser is forgiving and falls back to "seed" — the middle of the range,
# and the least misleading default to score an unknown company against.
# ---------------------------------------------------------------------------
DEFAULT_STAGE = "seed"

STAGE_ALIASES: Dict[str, str] = {
    "pre-seed": "pre_seed", "preseed": "pre_seed", "pre seed": "pre_seed",
    "idea": "pre_seed", "angel": "pre_seed",
    "seed": "seed",
    "series a": "series_a", "seriesa": "series_a", "a": "series_a",
    "series b+": "series_b_plus", "series b": "series_b_plus",
    "seriesb": "series_b_plus", "b": "series_b_plus", "growth": "series_b_plus",
    "late stage": "series_b_plus",
    "bootstrapped": "bootstrapped", "bootstrap": "bootstrapped",
    "self-funded": "bootstrapped", "profitable": "bootstrapped",
}

STAGE_LABELS: Dict[str, str] = {
    "pre_seed": "Pre-Seed",
    "seed": "Seed",
    "series_a": "Series A",
    "series_b_plus": "Series B+",
    "bootstrapped": "Bootstrapped",
}


def is_known_stage(raw: Optional[str]) -> bool:
    """True when a stage string maps onto a benchmark table without falling back."""
    return bool(raw) and str(raw).strip().lower() in STAGE_ALIASES


def normalize_stage(raw: Optional[str]) -> str:
    """Map a founder-entered stage string onto a benchmark key."""
    if not raw:
        return DEFAULT_STAGE
    return STAGE_ALIASES.get(str(raw).strip().lower(), DEFAULT_STAGE)


# ---------------------------------------------------------------------------
# Benchmark bands
#
# `direction` says which way is good. `target` is the band a founder should be
# aiming at, `warn` is where an investor starts asking pointed questions, and
# `critical` is where the metric becomes a blocker for that stage.
#
# For direction "higher": value >= target is strong, >= warn is acceptable,
#                         >= critical is weak, below critical is a blocker.
# For direction "lower":  value <= target is strong, <= warn is acceptable,
#                         <= critical is weak, above critical is a blocker.
# ---------------------------------------------------------------------------

def _band(direction: str, target: float, warn: float, critical: float) -> Dict[str, Any]:
    return {"direction": direction, "target": target, "warn": warn, "critical": critical}


STAGE_BENCHMARKS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "pre_seed": {
        "runway":             _band("higher", 12, 9, 6),
        "burn_multiple":      _band("lower", 2.0, 3.0, 5.0),
        "revenue_growth":     _band("higher", 15, 7, 0),
        "gross_margin":       _band("higher", 50, 30, 10),
        "rule_of_40":         _band("higher", 20, 0, -40),
        "capital_efficiency": _band("higher", 0.3, 0.1, 0.0),
    },
    "seed": {
        "runway":             _band("higher", 18, 12, 6),
        "burn_multiple":      _band("lower", 1.5, 2.0, 3.0),
        "revenue_growth":     _band("higher", 15, 8, 2),
        "gross_margin":       _band("higher", 60, 40, 20),
        "rule_of_40":         _band("higher", 40, 20, -20),
        "capital_efficiency": _band("higher", 0.5, 0.25, 0.1),
    },
    "series_a": {
        "runway":             _band("higher", 18, 12, 6),
        "burn_multiple":      _band("lower", 1.5, 2.0, 3.0),
        "revenue_growth":     _band("higher", 10, 5, 1),
        "gross_margin":       _band("higher", 65, 50, 30),
        "rule_of_40":         _band("higher", 40, 20, 0),
        "capital_efficiency": _band("higher", 1.0, 0.5, 0.2),
    },
    "series_b_plus": {
        "runway":             _band("higher", 24, 15, 9),
        "burn_multiple":      _band("lower", 1.0, 1.5, 2.5),
        "revenue_growth":     _band("higher", 7, 4, 1),
        "gross_margin":       _band("higher", 70, 55, 35),
        "rule_of_40":         _band("higher", 40, 25, 10),
        "capital_efficiency": _band("higher", 1.2, 0.7, 0.3),
    },
    "bootstrapped": {
        "runway":             _band("higher", 12, 6, 3),
        "burn_multiple":      _band("lower", 1.0, 1.5, 2.5),
        "revenue_growth":     _band("higher", 5, 2, 0),
        "gross_margin":       _band("higher", 55, 35, 15),
        "rule_of_40":         _band("higher", 40, 20, 0),
        "capital_efficiency": _band("higher", 1.5, 0.8, 0.3),
    },
}

#: Human-readable note rendered beside each benchmark, so the founder sees the
#: reasoning rather than an unexplained number.
BENCHMARK_NOTES: Dict[str, str] = {
    "runway": "Investors expect roughly 18 months of runway post-raise. Below 6 months you are negotiating from weakness.",
    "burn_multiple": "Net Burn divided by Net New ARR — how many rupees you burn to add one rupee of recurring revenue. Lower is better.",
    "revenue_growth": "Month-on-month revenue growth. Compounded, this is the single strongest signal at seed.",
    "gross_margin": "Revenue left after direct delivery costs. Varies sharply by model — software targets are higher than marketplace or D2C.",
    "rule_of_40": "Annualised growth rate plus profit margin. Above 40 means growth and efficiency are jointly healthy.",
    "capital_efficiency": "ARR generated per rupee of capital raised to date.",
}


# ---------------------------------------------------------------------------
# Readiness score weights.
#
# Renormalised over whichever metrics actually have data — identical policy to
# `_health_score` in startup_engine.py, so a founder with a thin profile is
# never silently scored as if the missing pieces were zero.
# ---------------------------------------------------------------------------
READINESS_WEIGHTS: Dict[str, float] = {
    "runway": 0.25,
    "burn_multiple": 0.20,
    "revenue_growth": 0.20,
    "gross_margin": 0.15,
    "rule_of_40": 0.10,
    "capital_efficiency": 0.10,
}

#: Where each band threshold lands on the 0-100 scale. Values between anchors
#: are linearly interpolated. `beyond_target` is the score a value reaches once
#: it is `taper_ratio` past target (x1.5 for "higher", x0.5 for "lower"); the
#: floor is reached one band-width below critical.
SCORE_ANCHORS: Dict[str, float] = {
    "floor": 0.0,
    "critical": 25.0,
    "warn": 60.0,
    "target": 90.0,
    "beyond_target": 100.0,
}
TAPER_RATIO_HIGHER = 1.5
TAPER_RATIO_LOWER = 0.5

#: Months of recorded revenue before an observed trend is trusted in place of
#: the founder's onboarding estimate (closes the "Verified revenue trend" gap).
MIN_REVENUE_HISTORY_MONTHS = 3

#: Months of recorded marketing spend before CAC can be attempted.
MIN_MARKETING_SPEND_MONTHS = 2

#: How the founder's stated raise is judged against the computed requirement.
#: Below `undersized` x requirement they will be back in market too soon;
#: above `oversized` x requirement the extra dilution needs justifying.
ASK_UNDERSIZED_RATIO = 0.8
ASK_OVERSIZED_RATIO = 1.6

#: Score bands for the headline verdict. Evaluated top-down; first match wins.
READINESS_VERDICTS: List[Dict[str, Any]] = [
    {"min": 75, "label": "Raise-ready", "tone": "good",
     "summary": "Your core metrics sit at or above what investors expect at this stage."},
    {"min": 55, "label": "Nearly ready", "tone": "warn",
     "summary": "The story holds, but one or two metrics will draw questions. Close them before you open a round."},
    {"min": 35, "label": "Needs work", "tone": "warn",
     "summary": "Several metrics are below stage expectations. A raise now would be priced on the weakest of them."},
    {"min": 0, "label": "Not ready to raise", "tone": "critical",
     "summary": "The fundamentals are not where an investor needs them yet. Fix the flagged metrics before raising."},
]


# ---------------------------------------------------------------------------
# Diligence gaps.
#
# The other half of the feature: metrics an investor WILL ask for that this
# product cannot compute from the data currently collected. Each entry names
# the missing inputs and what answering them unlocks, so the gap is actionable
# rather than a shrug. `severity` orders the list in the UI.
#
# `requires` is checked against a set of capability flags the service derives
# from the founder's actual data — a gap that has since been closed simply
# stops being reported.
# ---------------------------------------------------------------------------
DILIGENCE_GAPS: List[Dict[str, Any]] = [
    {
        "id": "cac",
        "label": "Customer Acquisition Cost (CAC) and CAC payback",
        "severity": "high",
        "requires": ["marketing_spend_by_month", "new_customers_by_month"],
        "asked_by": "Asked in essentially every seed and Series A conversation.",
        "missing_inputs": [
            "Marketing and sales spend, separated by month",
            "New paying customers acquired, by month",
        ],
        "unlocks": "CAC, CAC payback period, and the LTV to CAC ratio.",
        "how_to_close": "Record marketing spend separately each month, and how many new paying customers it produced. Connecting Gmail imports spend automatically; customer counts are not captured anywhere yet.",
    },
    {
        "id": "retention",
        "label": "Net Revenue Retention (NRR) and churn",
        "severity": "high",
        "requires": ["customer_level_revenue"],
        "asked_by": "The most scrutinised metric for any subscription or repeat-purchase business.",
        "missing_inputs": [
            "Revenue attributed to each customer, over time",
            "Customer start and churn dates",
        ],
        "unlocks": "NRR, gross churn, expansion revenue, and cohort retention curves.",
        "how_to_close": "Track revenue per customer per month rather than a single company-wide revenue figure.",
    },
    {
        "id": "cogs",
        "label": "True gross margin",
        "severity": "medium",
        "requires": ["cogs_separated"],
        "asked_by": "Determines whether your revenue is worth what you say it is.",
        "missing_inputs": [
            "Cost of goods sold, separated from operating expenses",
        ],
        "unlocks": "An audited-quality gross margin instead of the variable-cost approximation used today.",
        "how_to_close": "Split direct delivery costs (hosting, payment fees, fulfilment) out from general operating expenses.",
    },
    {
        "id": "revenue_history",
        "label": "Verified revenue trend",
        "severity": "medium",
        "requires": ["revenue_history_3m"],
        "asked_by": "Investors discount founder-estimated growth rates heavily.",
        "missing_inputs": [
            "At least three consecutive months of recorded revenue",
        ],
        "unlocks": "An observed growth rate and a real burn multiple, replacing your onboarding estimate.",
        "how_to_close": "Keep your revenue figure current in your startup profile — the twin captures a metric snapshot automatically each day, and three months of those unlock the trend.",
    },
    {
        "id": "pipeline",
        "label": "Sales pipeline and conversion",
        "severity": "low",
        "requires": ["pipeline_tracking"],
        "asked_by": "Supports the forward revenue number in your deck.",
        "missing_inputs": [
            "Qualified leads by month",
            "Lead-to-customer conversion rate",
        ],
        "unlocks": "A bottoms-up forecast an investor can sanity-check.",
        "how_to_close": "Record monthly qualified leads alongside new customers.",
    },
]
