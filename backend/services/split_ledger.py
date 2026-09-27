"""
The balance engine.

Balances in Money Splits are **never stored**. There is no `balance` column
anywhere in the schema, and that is deliberate: a stored balance is a second
source of truth that has to be kept in step with every expense edit, every
deletion and every settlement, and the first time it drifts the user is shown a
number that no set of rows can explain. Everything here is derived, on read,
from the expenses and settlements themselves.

Two views come out of the same pass:

* the **net** position per person — one number, positive meaning "is owed";
* the **pairwise** ledger — who owes whom specifically, which is what a group
  screen has to show before any simplification is applied.

Multiple payers are handled by splitting each participant's share across the
payers in proportion to what each of them actually put in. If Divij pays 2,000
and Harshit pays 1,000 on a 3,000 dinner, then Jiya's 1,000 share is owed
two-thirds to Divij and one-third to Harshit — not arbitrarily to whoever the
UI happened to list first. That proportional split runs through the same
largest-remainder allocator as everything else, so the pairwise amounts sum
back to the share exactly.
"""
from collections import defaultdict
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from backend.services.split_math import allocate_by_weights, simplify_debts


class Ledger:
    """Derived balances for a set of people over a set of expenses/settlements."""

    def __init__(self, net: Dict[int, int], pairwise: Dict[Tuple[int, int], int]):
        self.net = net
        # pairwise[(a, b)] > 0 means "a owes b". Never holds both directions for
        # the same pair — see _normalize.
        self.pairwise = pairwise

    def owed_to(self, person_id: int) -> int:
        return sum(v for (a, b), v in self.pairwise.items() if b == person_id and v > 0)

    def owed_by(self, person_id: int) -> int:
        return sum(v for (a, b), v in self.pairwise.items() if a == person_id and v > 0)

    def between(self, person_id: int, other_id: int) -> int:
        """Positive: `other_id` owes `person_id`. Negative: the reverse."""
        return self.pairwise.get((other_id, person_id), 0) - self.pairwise.get((person_id, other_id), 0)

    def simplified(self) -> List[dict]:
        return simplify_debts(self.net)


def _normalize(pairwise: Dict[Tuple[int, int], int]) -> Dict[Tuple[int, int], int]:
    """Collapse mutual debts and drop zeroes.

    If A owes B 500 and B owes A 300, the truth is that A owes B 200 — keeping
    both rows would make a settled-up pair look like two live debts and would
    double-count in any total.
    """
    out: Dict[Tuple[int, int], int] = {}
    seen = set()
    for (a, b) in list(pairwise.keys()):
        if (a, b) in seen or (b, a) in seen:
            continue
        seen.add((a, b))
        forward = pairwise.get((a, b), 0)
        backward = pairwise.get((b, a), 0)
        delta = forward - backward
        if delta > 0:
            out[(a, b)] = delta
        elif delta < 0:
            out[(b, a)] = -delta
    return out


def build_ledger(expenses: Iterable, settlements: Iterable,
                 person_ids: Optional[Sequence[int]] = None) -> Ledger:
    """Compute net and pairwise balances.

    `expenses` must be ORM SplitExpense rows with `shares` and `payers` loaded;
    `settlements` must be SplitSettlement rows. Both are expected to be
    pre-filtered to the scope being asked about (one group, or everything a
    user participates in) — this function does no authorization of its own.

    Soft-deleted rows are skipped here rather than at the query site so that no
    caller can forget: a deleted expense must stop affecting balances the
    instant it is deleted, which is the whole point of the flag.
    """
    net: Dict[int, int] = defaultdict(int)
    pairwise: Dict[Tuple[int, int], int] = defaultdict(int)

    if person_ids:
        for pid in person_ids:
            net[pid] += 0

    for exp in expenses:
        if getattr(exp, "is_deleted", False):
            continue

        payers = [(p.person_id, int(p.amount_minor)) for p in exp.payers if int(p.amount_minor) != 0]
        if not payers:
            continue

        for payer_id, amount in payers:
            net[payer_id] += amount
        for share in exp.shares:
            net[share.person_id] -= int(share.share_minor)

        # Pairwise: each participant owes each payer in proportion to what that
        # payer actually put in.
        for share in exp.shares:
            owed = int(share.share_minor)
            if owed == 0:
                continue
            debtor = share.person_id
            if len(payers) == 1:
                creditor = payers[0][0]
                if creditor != debtor:
                    pairwise[(debtor, creditor)] += owed
                continue

            portions = allocate_by_weights(owed, [amount for _, amount in payers])
            for (creditor, _), portion in zip(payers, portions):
                if portion and creditor != debtor:
                    pairwise[(debtor, creditor)] += portion

        # A payer who is also a participant has already covered part of their
        # own share: the `creditor != debtor` guard above drops that portion
        # rather than booking a debt from someone to themselves.

    for st in settlements:
        if getattr(st, "is_deleted", False):
            continue
        amount = int(st.amount_minor)
        # Paying money out improves your position; receiving it reduces what
        # you are owed. This is the mirror image of an expense, which is why
        # settlements must never be modelled as negative expenses — they move
        # the balance without touching what the group spent.
        net[st.from_person_id] += amount
        net[st.to_person_id] -= amount
        pairwise[(st.from_person_id, st.to_person_id)] -= amount

    return Ledger(dict(net), _normalize(dict(pairwise)))


def summarize_for(ledger: Ledger, person_id: int, currency: str = "INR") -> dict:
    """The "You are owed / You owe / Settled up" header.

    Reports gross owed and gross owing separately as well as the net, because
    "you are owed 2,000 and you owe 500" and "you are owed 1,500" are different
    facts about a group and users read them differently.
    """
    owed_to_me = ledger.owed_to(person_id)
    i_owe = ledger.owed_by(person_id)
    net = ledger.net.get(person_id, 0)
    return {
        "person_id": person_id,
        "currency": currency,
        "net_minor": net,
        "owed_to_you_minor": owed_to_me,
        "you_owe_minor": i_owe,
        "status": "settled" if net == 0 else ("owed" if net > 0 else "owes"),
    }
