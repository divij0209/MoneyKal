"""
Fundraise Readiness and Diligence Gap analysis for the Startup journey.

Two halves, and the second is the point of the feature.

  1. READINESS. Compute the metrics an investor actually asks for, score each
     against the benchmark band for the company's stage, and roll them into a
     single readiness verdict.

  2. DILIGENCE GAPS. Report the metrics that CANNOT be computed from the data
     the product currently holds, naming the missing inputs and what supplying
     them would unlock. Every tool shows metrics; almost none tell a founder
     what they are missing, and "we cannot answer that yet" is the honest and
     more useful output.

DESIGN NOTE — why this module does not touch startup_engine.py
--------------------------------------------------------------
Every metric here follows `MetricResult` and reuses `_calc_meta`, so the
frontend renders these cards with exactly the same components (status chip,
"How is this calculated?" toggle) it already uses on the Overview. But nothing
here is registered into `compute_metrics()`, so `/startup/overview` returns
precisely what it returned before. The feature is additive by construction.

Like the rest of the Startup engine, no number here is produced by an LLM.
"""

from backend.core.money import group_indian
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

from backend.core.config import fundraise_config as cfg
from backend.models.domain import StartupMetricSnapshot, StartupTransaction
from backend.services.startup_engine import (
    MetricResult,
    StartupContext,
    _calc_meta,
    combine_status,
    monthly_points,
)

#: Keys a metric's `calculation` blob may carry under "undefined" when its value
#: is None for a reason other than missing data. Scoring reads these explicitly
#: rather than guessing from the value, so an undefined ratio is never scored in
#: the wrong direction.
UNDEFINED_FAVOURABLE = "favourable"        # e.g. burn multiple while cash-flow positive
UNDEFINED_UNFAVOURABLE = "unfavourable"    # e.g. burning cash while revenue shrinks
UNDEFINED_NOT_APPLICABLE = "not_applicable"  # e.g. capital efficiency with nothing raised


# ---------------------------------------------------------------------------
# Formatting helpers (local — the engine's are private to its own display
# conventions and these metrics carry different units).
# ---------------------------------------------------------------------------

def _money(currency: str, v: Optional[float]) -> str:
    if v is None:
        return "Insufficient data"
    if abs(v) >= 10000000:
        return f"{currency}{v / 10000000:.2f} Cr"
    if abs(v) >= 100000:
        return f"{currency}{v / 100000:.2f} L"
    return f"{currency}{group_indian(v)}"


def _ratio(v: Optional[float]) -> str:
    return "Insufficient data" if v is None else f"{v:.2f}x"


def _pct(v: Optional[float]) -> str:
    return "Insufficient data" if v is None else f"{v:.1f}%"


def _gap_meta(
    inputs: Dict[str, Any],
    formula: str,
    data_source: str,
    last_updated: Optional[datetime],
    missing_inputs: List[str],
) -> Dict[str, Any]:
    """`_calc_meta` plus the reason a metric could not be computed.

    The extra key rides inside the existing `calculation` blob, so the response
    shape is unchanged and the diligence gap needs no separate data structure —
    it is just a filter over metrics whose value is None.
    """
    meta = _calc_meta(inputs, formula, data_source, last_updated)
    meta["missing_inputs"] = missing_inputs
    return meta


# ---------------------------------------------------------------------------
# Revenue history — the input several metrics depend on.
# ---------------------------------------------------------------------------

def _monthly_revenue_points(snapshots: List[StartupMetricSnapshot]) -> List[Tuple[str, float]]:
    """One revenue point per calendar month (last of month).

    The same helper the engine uses for Revenue Growth, so Net New ARR here and
    the growth rate on the Overview are always measured over the same months.
    """
    return monthly_points(snapshots, "revenue")


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _arr(ctx: StartupContext, revenue: MetricResult) -> MetricResult:
    inputs = {"monthly_revenue": revenue.value}
    formula = "ARR = Current Monthly Revenue x 12"
    if revenue.status == "insufficient_data" or revenue.value is None:
        return MetricResult(
            "arr", "ARR (annualised)", None, "", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "Depends on Monthly Revenue, which is unavailable",
                      ctx.updated_at, ["Current monthly revenue"]))
    value = revenue.value * 12
    return MetricResult(
        "arr", "ARR (annualised)", round(value, 2), "", _money(ctx.currency, value), revenue.status,
        _calc_meta(inputs, formula, "Annualised from current monthly revenue", ctx.updated_at))


def _gross_margin(ctx: StartupContext, revenue: MetricResult) -> MetricResult:
    """Approximated from variable costs, because COGS is not collected.

    Variable cost is the closest proxy the model holds for cost of delivery.
    The status is deliberately 'estimated' rather than 'actual', and the
    corresponding diligence gap tells the founder what a true figure needs.
    """
    inputs = {"monthly_revenue": revenue.value, "variable_costs": ctx.variable_costs}
    formula = "Gross Margin % = (Revenue - Variable Costs) / Revenue x 100, using variable costs as a proxy for COGS"
    if ctx.is_pre_revenue:
        return MetricResult(
            "gross_margin", "Gross Margin", None, "%", "Not applicable - pre-revenue", "insufficient_data",
            _gap_meta(inputs, formula, "Company is pre-revenue, so there is no margin to compute",
                      ctx.updated_at, ["Revenue"]))
    if revenue.value is None or not revenue.value:
        return MetricResult(
            "gross_margin", "Gross Margin", None, "%", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "Monthly revenue is unavailable or zero",
                      ctx.updated_at, ["Current monthly revenue"]))
    if ctx.variable_costs is None:
        return MetricResult(
            "gross_margin", "Gross Margin", None, "%", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "Variable costs were not itemised at onboarding",
                      ctx.updated_at, ["Variable costs, or cost of goods sold"]))
    value = (revenue.value - ctx.variable_costs) / revenue.value * 100
    return MetricResult(
        "gross_margin", "Gross Margin", round(value, 1), "%", _pct(value), "estimated",
        _calc_meta(inputs, formula,
                   "Approximated from founder-entered variable costs - true COGS is not collected",
                   ctx.updated_at))


def _net_new_arr(snapshots: List[StartupMetricSnapshot]) -> Tuple[Optional[float], Dict[str, Any]]:
    """Net New ARR between the two most recent months of recorded revenue."""
    pts = _monthly_revenue_points(snapshots)
    detail: Dict[str, Any] = {"months_of_history": len(pts)}
    if len(pts) < 2:
        return None, detail
    prev_month, prev_rev = pts[-2]
    latest_month, latest_rev = pts[-1]
    detail.update({
        "previous_month": prev_month, "previous_revenue": prev_rev,
        "latest_month": latest_month, "latest_revenue": latest_rev,
    })
    return (latest_rev - prev_rev) * 12, detail


def _burn_multiple(ctx: StartupContext, net_burn: MetricResult,
                   snapshots: List[StartupMetricSnapshot]) -> MetricResult:
    net_new_arr, detail = _net_new_arr(snapshots)
    inputs = {"net_burn": net_burn.value, "net_new_arr": net_new_arr, **detail}
    formula = "Burn Multiple = Net Burn (annualised) / Net New ARR added over the same period"

    if net_burn.status == "insufficient_data" or net_burn.value is None:
        return MetricResult(
            "burn_multiple", "Burn Multiple", None, "x", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "Depends on Net Burn, which is unavailable",
                      ctx.updated_at, ["Net burn"]))
    if net_burn.value <= 0:
        return MetricResult(
            "burn_multiple", "Burn Multiple", 0.0, "x", "Not burning - cash-flow positive", "actual",
            _calc_meta(inputs, formula, "Net Burn is zero or negative, so no capital is consumed per rupee of new revenue",
                       ctx.updated_at))
    if net_new_arr is None:
        return MetricResult(
            "burn_multiple", "Burn Multiple", None, "x", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula,
                      f"Needs at least 2 months of recorded revenue - {detail['months_of_history']} found",
                      ctx.updated_at, ["At least two months of recorded revenue"]))
    if net_new_arr <= 0:
        # Not a data gap: the data is there and it says capital is being burned
        # while recurring revenue stands still or shrinks. The ratio is
        # mathematically undefined, but it is undefined in the WORST direction —
        # an investor reads it as an infinite burn multiple — so it is scored as
        # a blocker rather than quietly dropped from the score.
        meta = _calc_meta(inputs, formula,
                          "Net New ARR was zero or negative over the last recorded month while the company "
                          "burned cash, so no recurring revenue was added for the capital consumed",
                          ctx.updated_at)
        meta["undefined"] = UNDEFINED_UNFAVOURABLE
        return MetricResult(
            "burn_multiple", "Burn Multiple", None, "x", "Burning cash with no revenue growth", "actual", meta)
    value = (net_burn.value * 12) / net_new_arr
    return MetricResult(
        "burn_multiple", "Burn Multiple", round(value, 2), "x", _ratio(value), "actual",
        _calc_meta(inputs, formula, "Computed from Net Burn and month-on-month recorded revenue", ctx.updated_at))


def _rule_of_40(ctx: StartupContext, revenue: MetricResult, gross: MetricResult,
                revenue_growth: MetricResult) -> MetricResult:
    """Annualised growth rate plus profit margin.

    Growth is monthly in this engine, so it is compounded to an annual figure
    before being added to margin - adding a monthly rate to an annual margin
    would flatter the score by roughly an order of magnitude.
    """
    inputs = {
        "revenue_growth_mom_pct": revenue_growth.value,
        "monthly_revenue": revenue.value,
        "gross_burn": gross.value,
    }
    formula = ("Rule of 40 = Annualised Revenue Growth % + Profit Margin %, where growth is compounded "
               "((1 + monthly growth)^12 - 1) and margin = (Revenue - Gross Burn) / Revenue")
    missing: List[str] = []
    if revenue_growth.status == "insufficient_data" or revenue_growth.value is None:
        missing.append("A revenue growth rate")
    if revenue.value is None or not revenue.value:
        missing.append("Current monthly revenue")
    if gross.status == "insufficient_data" or gross.value is None:
        missing.append("Gross burn")
    if missing:
        return MetricResult(
            "rule_of_40", "Rule of 40", None, "", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "One or more inputs are unavailable", ctx.updated_at, missing))

    monthly_g = revenue_growth.value / 100
    # Guard the pathological case of a monthly decline steeper than -100%.
    annual_growth_pct = (((1 + monthly_g) ** 12) - 1) * 100 if monthly_g > -1 else -100.0
    margin_pct = (revenue.value - gross.value) / revenue.value * 100
    value = annual_growth_pct + margin_pct
    inputs["annualised_growth_pct"] = round(annual_growth_pct, 1)
    inputs["profit_margin_pct"] = round(margin_pct, 1)
    status = combine_status(revenue_growth.status, gross.status, revenue.status)
    return MetricResult(
        "rule_of_40", "Rule of 40", round(value, 1), "", f"{value:.0f}", status,
        _calc_meta(inputs, formula, "Computed from Revenue Growth, Monthly Revenue and Gross Burn", ctx.updated_at))


def _capital_efficiency(ctx: StartupContext, arr: MetricResult) -> MetricResult:
    inputs = {"arr": arr.value, "total_funding": ctx.total_funding}
    formula = "Capital Efficiency = ARR / Total Capital Raised to date"
    if arr.value is None:
        return MetricResult(
            "capital_efficiency", "Capital Efficiency", None, "x", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "Depends on ARR, which is unavailable",
                      ctx.updated_at, ["Current monthly revenue"]))
    if not ctx.total_funding:
        # Dividing by zero capital is not "infinitely efficient" in any sense a
        # benchmark can judge, so the metric is left out of the score and the
        # confidence note says why — it is neither rewarded nor penalised.
        meta = _calc_meta(inputs, formula,
                          "No external capital has been raised, so there is no ratio to compute", ctx.updated_at)
        meta["undefined"] = UNDEFINED_NOT_APPLICABLE
        return MetricResult(
            "capital_efficiency", "Capital Efficiency", None, "x", "Not applicable - no capital raised", "actual", meta)
    value = arr.value / ctx.total_funding
    return MetricResult(
        "capital_efficiency", "Capital Efficiency", round(value, 2), "x", _ratio(value), arr.status,
        _calc_meta(inputs, formula, "Computed from ARR and founder-reported total funding raised", ctx.updated_at))


def _arpu(ctx: StartupContext, revenue: MetricResult) -> MetricResult:
    inputs = {"monthly_revenue": revenue.value, "paying_customers": ctx.paying_customers}
    formula = "ARPU = Monthly Revenue / Paying Customers"
    if revenue.value is None or not ctx.paying_customers:
        missing = []
        if revenue.value is None:
            missing.append("Current monthly revenue")
        if not ctx.paying_customers:
            missing.append("Number of paying customers")
        return MetricResult(
            "arpu", "ARPU (monthly)", None, "", "Insufficient data", "insufficient_data",
            _gap_meta(inputs, formula, "One or more inputs are unavailable", ctx.updated_at, missing))
    value = revenue.value / ctx.paying_customers
    return MetricResult(
        "arpu", "ARPU (monthly)", round(value, 2), "", _money(ctx.currency, value), revenue.status,
        _calc_meta(inputs, formula, "Computed from Monthly Revenue and founder-reported paying customers", ctx.updated_at))


def _ask_size(ctx: StartupContext, net_burn: MetricResult, target_runway_months: float) -> Dict[str, Any]:
    """What a raise needs to cover to reach the stage's target runway.

    Not scored - it is the practical follow-on question once a founder sees
    their runway gap, and it costs one division to answer.
    """
    inputs = {
        "net_burn": net_burn.value,
        "current_cash": ctx.current_cash,
        "target_runway_months": target_runway_months,
        "fundraising_target": ctx.fundraising_target,
    }
    formula = "Required Raise = (Target Runway x Net Burn) - Current Cash, floored at zero"
    if net_burn.status == "insufficient_data" or net_burn.value is None or ctx.current_cash is None:
        return {
            "status": "insufficient_data", "required_raise": None, "display": "Insufficient data",
            "target_runway_months": target_runway_months, "founder_target": ctx.fundraising_target,
            "verdict": None,
            "calculation": _gap_meta(inputs, formula, "Depends on Net Burn and Cash Position",
                                     ctx.updated_at, ["Net burn", "Current cash"]),
        }
    if net_burn.value <= 0:
        return {
            "status": "actual", "required_raise": 0.0, "display": "No raise required - cash-flow positive",
            "target_runway_months": target_runway_months, "founder_target": ctx.fundraising_target,
            "verdict": "You are not burning cash, so a raise is a growth choice rather than a necessity.",
            "calculation": _calc_meta(inputs, formula, "Net Burn is zero or negative", ctx.updated_at),
        }
    required = max(target_runway_months * net_burn.value - ctx.current_cash, 0.0)
    verdict = None
    if ctx.fundraising_target:
        if ctx.fundraising_target < required * cfg.ASK_UNDERSIZED_RATIO:
            verdict = (f"Your stated target of {_money(ctx.currency, ctx.fundraising_target)} is below the "
                       f"{_money(ctx.currency, required)} needed to reach {target_runway_months:.0f} months of runway. "
                       "You would be back in the market before that runway is used.")
        elif ctx.fundraising_target > required * cfg.ASK_OVERSIZED_RATIO:
            verdict = (f"Your stated target of {_money(ctx.currency, ctx.fundraising_target)} is well above the "
                       f"{_money(ctx.currency, required)} needed for {target_runway_months:.0f} months. "
                       "Be ready to justify the extra dilution.")
        else:
            verdict = (f"Your stated target of {_money(ctx.currency, ctx.fundraising_target)} is broadly consistent "
                       f"with the {_money(ctx.currency, required)} needed to reach {target_runway_months:.0f} months.")
    return {
        "status": "estimated", "required_raise": round(required, 2),
        "display": _money(ctx.currency, required),
        "target_runway_months": target_runway_months,
        "founder_target": ctx.fundraising_target,
        "verdict": verdict,
        "calculation": _calc_meta(inputs, formula, "Computed from Net Burn, Cash Position and the stage runway target",
                                  ctx.updated_at),
    }


# ---------------------------------------------------------------------------
# Benchmark scoring
# ---------------------------------------------------------------------------

def _score_against_band(value: Optional[float], band: Dict[str, Any]) -> Optional[float]:
    """Map a value onto 0-100 by linear interpolation between the bands.

    critical -> 25, warn -> 60, target -> 90, and beyond target tapers to 100.
    Piecewise-linear rather than a step function so a founder sitting just
    under a threshold is not scored identically to one far below it.
    """
    if value is None:
        return None
    target, warn, critical = band["target"], band["warn"], band["critical"]
    a = cfg.SCORE_ANCHORS
    top = a["beyond_target"]

    def interp(v, lo, hi, lo_s, hi_s):
        if hi == lo:
            return hi_s
        t = (v - lo) / (hi - lo)
        return lo_s + t * (hi_s - lo_s)

    if band["direction"] == "higher":
        if value >= target:
            taper_to = target * cfg.TAPER_RATIO_HIGHER if target > 0 else target + (warn - critical or 1)
            return min(top, interp(value, target, taper_to, a["target"], top))
        if value >= warn:
            return interp(value, warn, target, a["warn"], a["target"])
        if value >= critical:
            return interp(value, critical, warn, a["critical"], a["warn"])
        width = (warn - critical) or abs(critical) or 1
        return max(a["floor"], interp(value, critical - width, critical, a["floor"], a["critical"]))
    # direction == "lower"
    if value <= target:
        return min(top, interp(value, target, max(target * cfg.TAPER_RATIO_LOWER, 0.0), a["target"], top))
    if value <= warn:
        return interp(value, warn, target, a["warn"], a["target"])
    if value <= critical:
        return interp(value, critical, warn, a["critical"], a["warn"])
    width = (critical - warn) or abs(critical) or 1
    return max(a["floor"], interp(value, critical + width, critical, a["floor"], a["critical"]))


def _band_verdict(value: Optional[float], band: Dict[str, Any]) -> str:
    """Which band a value falls in: strong | acceptable | weak | blocker."""
    if value is None:
        return "unknown"
    if band["direction"] == "higher":
        if value >= band["target"]:
            return "strong"
        if value >= band["warn"]:
            return "acceptable"
        if value >= band["critical"]:
            return "weak"
        return "blocker"
    if value <= band["target"]:
        return "strong"
    if value <= band["warn"]:
        return "acceptable"
    if value <= band["critical"]:
        return "weak"
    return "blocker"


def _format_band(metric_id: str, band: Dict[str, Any]) -> Dict[str, Any]:
    unit = {"runway": " mo", "burn_multiple": "x", "capital_efficiency": "x",
            "revenue_growth": "%", "gross_margin": "%", "rule_of_40": ""}.get(metric_id, "")
    fmt = lambda v: f"{v:g}{unit}"  # noqa: E731 - trivial local formatter
    return {
        "direction": band["direction"],
        "target": band["target"], "warn": band["warn"], "critical": band["critical"],
        "target_display": fmt(band["target"]),
        "warn_display": fmt(band["warn"]),
        "critical_display": fmt(band["critical"]),
        "note": cfg.BENCHMARK_NOTES.get(metric_id, ""),
    }


# ---------------------------------------------------------------------------
# Diligence gaps
# ---------------------------------------------------------------------------

def _capabilities(snapshots: List[StartupMetricSnapshot],
                  transactions: List[StartupTransaction]) -> Dict[str, bool]:
    """Which data capabilities the founder's records currently support.

    A gap whose requirements are all satisfied stops being reported, so the
    list shrinks as the founder feeds the twin - which is the whole point of
    surfacing it.
    """
    months_of_revenue = len(_monthly_revenue_points(snapshots))
    marketing_months = {
        f"{t.txn_date.year:04d}-{t.txn_date.month:02d}"
        for t in transactions
        if t.type == "out" and (t.category or "") == "Marketing"
    }
    return {
        "marketing_spend_by_month": len(marketing_months) >= cfg.MIN_MARKETING_SPEND_MONTHS,
        "new_customers_by_month": False,      # No field records customer acquisition per month.
        "customer_level_revenue": False,      # Revenue is company-wide, never per customer.
        "cogs_separated": False,              # Variable costs are a proxy, not true COGS.
        "revenue_history_3m": months_of_revenue >= cfg.MIN_REVENUE_HISTORY_MONTHS,
        "pipeline_tracking": False,           # No pipeline data is collected.
    }


def _diligence_gaps(capabilities: Dict[str, bool], metrics: Dict[str, MetricResult]) -> List[Dict[str, Any]]:
    order = {"high": 0, "medium": 1, "low": 2}
    gaps: List[Dict[str, Any]] = []
    for gap in cfg.DILIGENCE_GAPS:
        if all(capabilities.get(req, False) for req in gap.get("requires", [])):
            continue
        entry = {k: v for k, v in gap.items() if k != "requires"}
        entry["blocking"] = [req for req in gap.get("requires", []) if not capabilities.get(req, False)]
        gaps.append(entry)

    # A metric that could not be computed is itself a gap. Fold those in so the
    # list is "everything an investor asks that we cannot answer", not just the
    # curated set.
    for m in metrics.values():
        missing = (m.calculation or {}).get("missing_inputs")
        if not missing:
            continue
        gaps.append({
            "id": f"metric_{m.id}",
            "label": f"{m.label} cannot be computed",
            "severity": "medium",
            "asked_by": "Derived directly from the metric an investor will ask you for.",
            "missing_inputs": missing,
            "unlocks": f"The {m.label} figure, and its contribution to your readiness score.",
            "how_to_close": (m.calculation or {}).get("data_source", ""),
            "blocking": missing,
        })
    gaps.sort(key=lambda g: order.get(g["severity"], 3))
    return gaps


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def build_readiness(
    ctx: StartupContext,
    base_metrics: Dict[str, Any],
    snapshots: List[StartupMetricSnapshot],
    transactions: List[StartupTransaction],
) -> Dict[str, Any]:
    """Compute the full Fundraise Readiness payload.

    `base_metrics` is the dict returned by `startup_engine.compute_metrics()` —
    reused rather than recomputed, so burn and runway can never disagree
    between the Overview and this screen.
    """
    stage_key = cfg.normalize_stage(ctx.stage)
    bands = cfg.STAGE_BENCHMARKS[stage_key]

    revenue = base_metrics["revenue"]
    gross = base_metrics["gross_burn"]
    net_burn = base_metrics["net_burn"]
    runway = base_metrics["runway"]
    revenue_growth = base_metrics["revenue_growth"]

    arr = _arr(ctx, revenue)
    gross_margin = _gross_margin(ctx, revenue)
    burn_multiple = _burn_multiple(ctx, net_burn, snapshots)
    rule_of_40 = _rule_of_40(ctx, revenue, gross, revenue_growth)
    capital_efficiency = _capital_efficiency(ctx, arr)
    arpu = _arpu(ctx, revenue)

    #: Metrics that are scored against a band. Runway and revenue growth are
    #: reused from the Overview engine so there is one definition of each.
    scored: Dict[str, MetricResult] = {
        "runway": runway,
        "burn_multiple": burn_multiple,
        "revenue_growth": revenue_growth,
        "gross_margin": gross_margin,
        "rule_of_40": rule_of_40,
        "capital_efficiency": capital_efficiency,
    }
    #: Shown for context but not scored — no defensible stage benchmark exists.
    unscored: Dict[str, MetricResult] = {"arr": arr, "arpu": arpu}

    components: List[Tuple[str, float, float]] = []
    excluded: List[str] = []
    not_applicable: List[str] = []
    assumption_based: List[str] = []
    rows: List[Dict[str, Any]] = []
    anchors = cfg.SCORE_ANCHORS

    for metric_id, metric in scored.items():
        band = bands[metric_id]
        undefined = (metric.calculation or {}).get("undefined")

        # Runway comes from the engine, which returns None with a real status
        # when the company is cash-flow positive: no cash-out horizon at all.
        # That is undefined in the founder's favour — the same way
        # `_health_score` treats it — so it scores full marks. The rule is
        # confined to Runway; every Fundraise metric says explicitly which way
        # its own undefined value points.
        if undefined is None and metric_id == "runway" and metric.value is None \
                and metric.status != "insufficient_data":
            undefined = UNDEFINED_FAVOURABLE

        if undefined == UNDEFINED_FAVOURABLE:
            score, verdict = anchors["beyond_target"], "strong"
        elif undefined == UNDEFINED_UNFAVOURABLE:
            score, verdict = anchors["floor"], "blocker"
        elif undefined == UNDEFINED_NOT_APPLICABLE:
            score, verdict = None, "not_applicable"
        else:
            score = _score_against_band(metric.value, band)
            verdict = _band_verdict(metric.value, band)

        if undefined == UNDEFINED_NOT_APPLICABLE:
            not_applicable.append(metric_id)
        elif score is not None and metric.status != "insufficient_data":
            components.append((metric_id, cfg.READINESS_WEIGHTS[metric_id], score))
            if metric.status == "assumption":
                assumption_based.append(metric_id)
        else:
            excluded.append(metric_id)
        rows.append({
            "metric": metric.to_dict(),
            "benchmark": _format_band(metric_id, band),
            "verdict": verdict,
            "score": round(score, 1) if score is not None else None,
            "weight_pct": round(cfg.READINESS_WEIGHTS[metric_id] * 100, 1),
        })

    if components:
        total_weight = sum(w for _, w, _ in components)
        composite = sum(w * s for _, w, s in components) / total_weight
    else:
        composite = None

    verdict_entry = None
    if composite is not None:
        for v in cfg.READINESS_VERDICTS:
            if composite >= v["min"]:
                verdict_entry = v
                break

    all_metrics = {**scored, **unscored}
    capabilities = _capabilities(snapshots, transactions)
    gaps = _diligence_gaps(capabilities, all_metrics)

    target_runway = bands["runway"]["target"]
    ask = _ask_size(ctx, net_burn, target_runway)

    blockers = [r for r in rows if r["verdict"] == "blocker"]
    weak = [r for r in rows if r["verdict"] == "weak"]

    def _labels(ids: List[str]) -> str:
        return ", ".join(scored[i].label for i in ids)

    confidence_note = (
        f"Scored on {len(components)} of {len(scored)} benchmark metrics."
        + (f" Excluded for want of data: {_labels(excluded)}." if excluded else "")
        + (f" Not applicable to you: {_labels(not_applicable)}." if not_applicable else "")
        + (f" Scored on your own onboarding estimate rather than recorded history: "
           f"{_labels(assumption_based)}." if assumption_based else "")
    )

    return {
        "currency": ctx.currency,
        "company_name": ctx.company_name,
        "stage": {
            "key": stage_key,
            "label": cfg.STAGE_LABELS[stage_key],
            "raw": ctx.stage,
            # True whenever the benchmark table was chosen by fallback — no
            # stage on file, or a stage string that matches no table.
            "normalized_from_default": not cfg.is_known_stage(ctx.stage),
        },
        "currently_fundraising": ctx.currently_fundraising,
        "readiness": {
            "score": round(composite, 1) if composite is not None else None,
            "display": f"{composite:.0f}/100" if composite is not None else "Insufficient data",
            "label": verdict_entry["label"] if verdict_entry else "Insufficient data",
            "tone": verdict_entry["tone"] if verdict_entry else "neutral",
            "summary": (verdict_entry["summary"] if verdict_entry
                        else "Not enough of your metrics can be computed yet to score readiness. "
                             "Close the gaps below and this score will fill in."),
            "confidence_note": confidence_note,
            "scored_count": len(components),
            "total_count": len(scored),
            "excluded": excluded,
            "not_applicable": not_applicable,
            "assumption_based": assumption_based,
        },
        "benchmarks": rows,
        "context_metrics": [m.to_dict() for m in unscored.values()],
        "ask": ask,
        "blockers": [
            {"metric": r["metric"]["label"], "display": r["metric"]["display"],
             "target": r["benchmark"]["target_display"], "note": r["benchmark"]["note"]}
            for r in blockers
        ],
        "watch": [
            {"metric": r["metric"]["label"], "display": r["metric"]["display"],
             "target": r["benchmark"]["target_display"], "note": r["benchmark"]["note"]}
            for r in weak
        ],
        "diligence_gaps": gaps,
        "capabilities": capabilities,
        "disclaimer": (
            "Benchmarks are heuristic bands drawn from widely-cited venture rules of thumb, not "
            "statutory or guaranteed thresholds. Every band is shown alongside its metric so you can "
            "judge the comparison yourself. This is not investment advice."
        ),
    }
