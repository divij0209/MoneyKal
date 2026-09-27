"""
Guards on the tax calculator's help text.

The calculator's rule is that no statutory figure lives outside
backend/core/config/tax_config.py — see the headers of that file and of
twin-app/js/tax.js. Prose is the easiest place for that rule to rot, because
a sentence explaining a limit looks harmless next to the field it describes.
These tests keep the guidance honest without a running server.
"""

import io
import re
from pathlib import Path

from backend.core.config import tax_config as cfg

ROOT = Path(__file__).resolve().parents[1]
DASHBOARD = ROOT / "twin-app" / "dashboard.html"
TAX_JS = ROOT / "twin-app" / "js" / "tax.js"

# A figure written into the prose rather than pulled from config.
HARDCODED_FIGURE = re.compile(
    r"₹"                       # a rupee amount
    r"|\bRs\.?\s*\d"           # "Rs 50,000"
    r"|\d\s*%"                 # "30%"
    r"|\d[\d,.]*\s*(lakh|crore)",   # "1.25 lakh", "3 crore"
    re.IGNORECASE,
)


def _templates():
    """Every unrendered guidance string, labelled by where it came from."""
    for key, text in cfg.FIELD_GUIDANCE.items():
        yield f"FIELD_GUIDANCE[{key!r}]", text
    for guide in cfg.FILING_GUIDES:
        for i, step in enumerate(guide["steps"]):
            yield f"FILING_GUIDES[{guide['key']!r}].steps[{i}]", step["detail"]


def _data_help_keys():
    """The data-help keys the UI actually asks for, static and dynamic."""
    pattern = re.compile(r'data-help="([^"]+)"')
    keys = set()
    for path in (DASHBOARD, TAX_JS):
        keys |= set(pattern.findall(io.open(path, encoding="utf-8").read()))
    return keys


def test_guidance_quotes_no_figure_of_its_own():
    """Rates and limits must arrive as placeholders, never as literal text."""
    offenders = [
        (where, HARDCODED_FIGURE.search(text).group(0))
        for where, text in _templates()
        if HARDCODED_FIGURE.search(text)
    ]
    assert not offenders, (
        "guidance text hardcodes a figure instead of using a placeholder "
        f"resolved by guidance_values(): {offenders}"
    )


def test_every_placeholder_resolves_for_every_year():
    """A template naming a figure the config lacks must not reach the UI."""
    for year in cfg.TAX_YEARS:
        guidance = cfg.get_field_guidance(year)
        guides = cfg.get_filing_guides(year)

        rendered = list(guidance.values())
        rendered += [s["detail"] for g in guides for s in g["steps"]]
        rendered += [s["link"]["url"] for g in guides for s in g["steps"] if s.get("link")]

        for text in rendered:
            assert "{" not in text and "}" not in text, (
                f"unresolved placeholder for {year}: {text}"
            )


def test_guidance_follows_the_governing_act():
    """Section labels track the Act in force, so the help text must too."""
    savings = "other_sources.savings_interest"
    assert "S.153 (80TTA)" in cfg.get_field_guidance("FY2026-27")[savings]
    assert "80TTA" in cfg.get_field_guidance("FY2025-26")[savings]
    assert "S.153" not in cfg.get_field_guidance("FY2025-26")[savings]


def test_guidance_matches_the_configured_rates():
    """Spot-check that rendered prose quotes the config, not a stale memory."""
    guidance = cfg.get_field_guidance()
    presumptive = cfg.PRESUMPTIVE_TAXATION["44AD"]

    turnover = guidance["pgbp.presumptive.gross_turnover"]
    assert cfg.format_inr(presumptive["turnover_limit"]) in turnover
    assert cfg.format_inr(presumptive["turnover_limit_standard"]) in turnover

    ltcg = guidance["capital_gains.ltcg_112a"]
    rules = cfg.CAPITAL_GAINS_RULES["ltcg_112a"]
    assert cfg.format_inr(rules["annual_exemption"]) in ltcg
    assert cfg.format_percent(rules["rate"]) in ltcg


def test_ui_and_config_agree_on_every_field():
    """Neither an unexplained field nor orphaned help text."""
    asked_for = _data_help_keys()
    available = set(cfg.FIELD_GUIDANCE)

    assert not asked_for - available, (
        f"fields asking for help text that does not exist: "
        f"{sorted(asked_for - available)}"
    )
    assert not available - asked_for, (
        f"help text no field points at: {sorted(available - asked_for)}"
    )
