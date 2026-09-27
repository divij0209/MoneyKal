"""
Split arithmetic — the money engine behind Money Splits.

Two rules govern everything in this file, and they are the reason it exists as
a separate module rather than as helpers scattered through the router:

1. **Money is never a float.** Every amount is carried as an integer number of
   minor units (paise for INR, cents for USD). Floats cannot represent 0.1
   exactly, so a naive 100/3 split produces three shares of 33.333333333333336
   that sum to 100.00000000000001 — a discrepancy that compounds across edits
   and eventually shows a user a balance that is off by a rupee with no
   explanation. Integers make the arithmetic exact by construction.

2. **An allocation always sums to the total.** Every function that divides an
   amount returns a list whose sum is exactly equal to the input. This is the
   invariant the balance engine depends on: if shares did not sum to the
   expense, "who owes what" would not close, and no amount of careful display
   rounding downstream could hide it.

The rounding policy is *largest remainder*. Each participant gets the floor of
their exact share, then the leftover minor units are handed out one at a time to
whoever was rounded down hardest. Rs 100 across three people becomes
3334/3333/3333 rather than 3333/3333/3333-and-a-lost-paisa. Ties break on
position, so the result is deterministic: the same input always produces the
same allocation, which matters because an expense gets recalculated every time
it is edited.
"""
from decimal import Decimal, ROUND_FLOOR, InvalidOperation
from typing import Iterable, List, Optional, Sequence, Union

Number = Union[int, float, str, Decimal]


class SplitMathError(ValueError):
    """Raised when an amount or an allocation is not usable.

    A distinct type so routers can map it to a 400 with the message intact —
    these are all user-correctable input problems ("percentages must total
    100"), not server faults.
    """


# ---------------------------------------------------------------------------
# Currency
# ---------------------------------------------------------------------------
# Exponent = how many minor units make one major unit. Only currencies that are
# not 2-decimal need an entry; everything else falls through to the default.
# Kept deliberately small: a full ISO 4217 table would be dead weight, and a
# wrong entry is worse than the default because it silently scales amounts.
_CURRENCY_EXPONENT = {
    "JPY": 0, "KRW": 0, "VND": 0, "CLP": 0, "ISK": 0, "UGX": 0, "RWF": 0,
    "BHD": 3, "KWD": 3, "OMR": 3, "JOD": 3, "TND": 3,
}
DEFAULT_CURRENCY = "INR"

CURRENCY_SYMBOLS = {
    "INR": "₹", "USD": "$", "EUR": "€", "GBP": "£",
    "JPY": "¥", "AUD": "A$", "CAD": "C$", "SGD": "S$",
    "AED": "AED ", "CHF": "CHF ", "CNY": "CN¥",
}


def normalize_currency(code: Optional[str]) -> str:
    code = (code or DEFAULT_CURRENCY).strip().upper()
    if len(code) != 3 or not code.isalpha():
        raise SplitMathError(f"'{code}' is not a valid 3-letter currency code")
    return code


def currency_exponent(code: Optional[str]) -> int:
    return _CURRENCY_EXPONENT.get(normalize_currency(code), 2)


def currency_symbol(code: Optional[str]) -> str:
    code = normalize_currency(code)
    return CURRENCY_SYMBOLS.get(code, code + " ")


# ---------------------------------------------------------------------------
# Conversion between what a human types and what we store
# ---------------------------------------------------------------------------

def to_minor(amount: Number, currency: str = DEFAULT_CURRENCY) -> int:
    """Parse a user-supplied amount into integer minor units.

    Accepts str/int/float/Decimal. Floats are routed through `repr` rather than
    `Decimal(float)` so that 19.99 becomes Decimal('19.99') and not
    Decimal('19.989999999999998436805981327779591083526611328125') — the JSON
    body of an API request gives us a float whether we like it or not, and this
    is the one place where that has to be made safe.

    Rejects more precision than the currency has, instead of silently rounding:
    if a client sends 10.567 for INR we want to hear about the bug, not book
    10.57 and leave the user's total short by a third of a paisa per row.
    """
    if amount is None:
        raise SplitMathError("Amount is required")
    exp = currency_exponent(currency)
    try:
        if isinstance(amount, float):
            dec = Decimal(repr(amount))
        elif isinstance(amount, Decimal):
            dec = amount
        else:
            text = str(amount).strip().replace(",", "").replace("₹", "")
            if not text:
                raise SplitMathError("Amount is required")
            dec = Decimal(text)
    except SplitMathError:
        raise
    except (InvalidOperation, ArithmeticError, ValueError):
        raise SplitMathError(f"'{amount}' is not a valid amount")

    if not dec.is_finite():
        raise SplitMathError("Amount must be a finite number")

    scaled = dec.scaleb(exp)
    if scaled != scaled.to_integral_value():
        raise SplitMathError(
            f"Amount {dec} has more precision than {normalize_currency(currency)} supports"
        )
    return int(scaled)


def from_minor(minor: int, currency: str = DEFAULT_CURRENCY) -> Decimal:
    """Integer minor units back to a major-unit Decimal, for display/serialising."""
    exp = currency_exponent(currency)
    quant = Decimal(1).scaleb(-exp)
    return (Decimal(int(minor)) / (Decimal(10) ** exp)).quantize(quant)


def format_minor(minor: int, currency: str = DEFAULT_CURRENCY, with_symbol: bool = True) -> str:
    """Human-readable amount. Indian grouping (1,23,456) for INR, Western
    grouping elsewhere, because a rupee figure shown as 123,456 reads as wrong
    to the audience this product is built for."""
    currency = normalize_currency(currency)
    value = from_minor(minor, currency)
    sign = "-" if value < 0 else ""
    value = abs(value)
    exp = currency_exponent(currency)
    whole, _, frac = str(value).partition(".")

    if currency == "INR" and len(whole) > 3:
        head, tail = whole[:-3], whole[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        whole = ",".join(parts) + "," + tail
    else:
        whole = f"{int(whole):,}"

    body = whole + (("." + frac) if exp and frac else "")
    return f"{sign}{currency_symbol(currency)}{body}" if with_symbol else f"{sign}{body}"


# ---------------------------------------------------------------------------
# Allocation — the core of the engine
# ---------------------------------------------------------------------------

def _as_decimal(value: Number, what: str) -> Decimal:
    try:
        if isinstance(value, Decimal):
            return value
        if isinstance(value, float):
            return Decimal(repr(value))
        return Decimal(str(value).strip())
    except (InvalidOperation, ArithmeticError, ValueError):
        raise SplitMathError(f"'{value}' is not a valid {what}")


def allocate_by_weights(total_minor: int, weights: Sequence[Number]) -> List[int]:
    """Divide `total_minor` in proportion to `weights`, losing nothing.

    This single function backs equal, percentage and share/ratio splitting —
    they differ only in what they pass as weights ([1,1,1], [50,30,20],
    [2,1,1]) — so the rounding behaviour is guaranteed identical across all
    three modes rather than reimplemented three times with three subtly
    different edge cases.

    Returns a list the same length as `weights` whose sum is exactly
    `total_minor`, including when the total is negative (a refund) or when some
    weights are zero (a participant who is present on the expense but not
    sharing this particular item).
    """
    if not weights:
        raise SplitMathError("Cannot split between nobody")

    decimals: List[Decimal] = []
    for w in weights:
        d = _as_decimal(w, "weight")
        if not d.is_finite() or d < 0:
            raise SplitMathError("Weights must be finite and non-negative")
        decimals.append(d)

    total_weight = sum(decimals)
    if total_weight <= 0:
        raise SplitMathError("At least one participant must have a share greater than zero")

    total = int(total_minor)
    # Work on the magnitude and reapply the sign, so a negative total rounds the
    # same way a positive one does instead of flooring "the other direction".
    sign = -1 if total < 0 else 1
    magnitude = abs(total)

    exact = [Decimal(magnitude) * d / total_weight for d in decimals]
    floors = [int(e.to_integral_value(rounding=ROUND_FLOOR)) for e in exact]
    leftover = magnitude - sum(floors)

    # Hand the leftover units to whoever lost the most to flooring. Ties break
    # on index so the allocation is stable across recalculations of the same
    # expense; without that, editing an unrelated field could shuffle who
    # carries the extra paisa.
    order = sorted(range(len(decimals)), key=lambda i: (-(exact[i] - floors[i]), i))
    for k in range(leftover):
        floors[order[k % len(order)]] += 1

    return [sign * f for f in floors]


def allocate_equal(total_minor: int, count: int) -> List[int]:
    """Equal split. Rs 100 across 3 -> [3334, 3333, 3333]."""
    if count <= 0:
        raise SplitMathError("Cannot split between nobody")
    return allocate_by_weights(total_minor, [1] * count)


def allocate_by_percent(total_minor: int, percents: Sequence[Number]) -> List[int]:
    """Percentage split. Percentages must total exactly 100.

    Checked rather than normalised: if a user enters 50/30/10 they have made a
    mistake, and quietly scaling it to 62.5/37.5/12.5 would book an expense
    they never agreed to.
    """
    decimals = [_as_decimal(p, "percentage") for p in percents]
    total = sum(decimals) if decimals else Decimal(0)
    if total != Decimal("100"):
        raise SplitMathError(
            # format(..., 'f') rather than normalize(): Decimal('90').normalize()
            # renders as "9E+1", which is not a number to show a user.
            f"Percentages must add up to 100% (they currently total {format(total.normalize(), 'f')}%)"
        )
    return allocate_by_weights(total_minor, decimals)


def validate_exact(total_minor: int, parts_minor: Sequence[int], label: str = "shares") -> List[int]:
    """Custom/unequal amounts: the user typed every figure, so we only check
    that they close. Returns the list unchanged so callers can use it inline."""
    parts = [int(p) for p in parts_minor]
    diff = int(total_minor) - sum(parts)
    if diff != 0:
        raise SplitMathError(
            f"The {label} do not add up to the total "
            f"({'short by' if diff > 0 else 'over by'} {abs(diff)} minor units)"
        )
    return parts


def split_equal_subset(total_minor: int, participant_ids: Sequence[int],
                       included_ids: Optional[Iterable[int]] = None) -> dict:
    """Equal split across a subset of the participants, zero for everyone else.

    Used by itemized splitting, where each line item is shared by only some of
    the people on the bill.
    """
    included = set(included_ids) if included_ids is not None else set(participant_ids)
    weights = [1 if pid in included else 0 for pid in participant_ids]
    if not any(weights):
        raise SplitMathError("An item must be shared by at least one person")
    amounts = allocate_by_weights(total_minor, weights)
    return dict(zip(participant_ids, amounts))


# ---------------------------------------------------------------------------
# Debt simplification
# ---------------------------------------------------------------------------

def simplify_debts(net_by_person: dict) -> List[dict]:
    """Turn a set of net positions into the fewest transfers that clear them.

    Input maps person id -> net minor units, positive meaning "is owed".
    Greedy largest-creditor/largest-debtor matching: it is not provably minimal
    in every pathological case, but it is optimal whenever no proper subset of
    people happens to balance among themselves, which covers essentially every
    real group. Each pass settles at least one person completely, so the result
    has at most n-1 transfers versus the O(n^2) a naive pairwise ledger shows.

    The sum of all nets is zero by construction (every rupee owed is a rupee
    owed *to* someone), so the loop always terminates with both sides empty.
    """
    creditors = sorted(
        [[pid, amt] for pid, amt in net_by_person.items() if amt > 0],
        key=lambda r: (-r[1], r[0]),
    )
    debtors = sorted(
        [[pid, -amt] for pid, amt in net_by_person.items() if amt < 0],
        key=lambda r: (-r[1], r[0]),
    )

    transfers: List[dict] = []
    i = j = 0
    while i < len(debtors) and j < len(creditors):
        amount = min(debtors[i][1], creditors[j][1])
        if amount > 0:
            transfers.append({
                "from_person_id": debtors[i][0],
                "to_person_id": creditors[j][0],
                "amount_minor": amount,
            })
        debtors[i][1] -= amount
        creditors[j][1] -= amount
        if debtors[i][1] == 0:
            i += 1
        if creditors[j][1] == 0:
            j += 1
    return transfers
