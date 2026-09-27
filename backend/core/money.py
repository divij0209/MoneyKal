"""The one place a rupee amount is turned into a string.

WHY THIS EXISTS
---------------
The product was rendering the same kind of number four different ways at once:

    Indian grouping   home_service.format_money()   ₹9,50,000
    Western grouping  startup_engine._money()       ₹42,000,000   <- wrong
    "Rs." prefix      js/compliance.js              Rs.4,20,00,000
    Browser locale    js/auth.js .toLocaleString()  depends on the viewer's laptop

Two of those are simply incorrect for an Indian product, and the fourth is worse
than incorrect because it is unpredictable: it renders in whichever grouping the
reader's own machine is configured for, so the team could not know what a
reviewer would see.

Indian grouping is not "thousands separators". It groups the last three digits
and then in pairs: 42000000 is 4,20,00,000, not 42,000,000. No standard library
format specifier produces it, which is why the wrong one was reached for.

Callers keep their own text for a missing value — "N/A" in one place,
"Insufficient data" in another — because those mean different things to a
reader. Only the digits are shared.
"""
from __future__ import annotations

from typing import Optional


def group_indian(value: float) -> str:
    """Digits only, Indian-grouped, no sign and no currency symbol.

    1234        -> '1,234'
    123456      -> '1,23,456'
    42000000    -> '4,20,00,000'
    """
    whole = "%.0f" % abs(value)
    if len(whole) <= 3:
        return whole
    head, tail = whole[:-3], whole[-3:]
    parts = []
    while len(head) > 2:
        parts.insert(0, head[-2:])
        head = head[:-2]
    if head:
        parts.insert(0, head)
    return ",".join(parts) + "," + tail


def format_money(currency: Optional[str], value: Optional[float],
                 none_text: str = "N/A") -> str:
    """A signed, symbol-prefixed, Indian-grouped amount."""
    if value is None:
        return none_text
    sign = "-" if value < 0 else ""
    return sign + (currency or "₹") + group_indian(value)
