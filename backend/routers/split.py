"""
Money Splits — HTTP surface.

Thin by design. Every route does the same three things: resolve the caller to a
SplitPerson, hand the work to `split_service` (which owns authorization), and
serialise the result. No route trusts an id from the request body — group,
expense and settlement ids are always exchanged for objects through the
`resolve_*` helpers, which raise 404 for anything the caller is not entitled
to see.

The one unauthenticated route is `GET /split/invite/{token}`, which returns
only who invited you and to which group, so an invitation link can render a
landing page before the recipient has an account.
"""
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session, joinedload

from backend.core.auth import get_current_user
from backend.database import get_db
from backend.models.domain import (
    SplitExpense, SplitGroup, SplitGroupMember, SplitPerson, SplitSettlement, User,
)
from backend.services import notification_service, split_service, subscription_service
from backend.services.split_ledger import summarize_for
from backend.services.split_math import (
    DEFAULT_CURRENCY, SplitMathError, currency_symbol, format_minor, from_minor,
    normalize_currency,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/split", tags=["Split"])


# ---------------------------------------------------------------------------
# Dependency: the caller as a Split participant
# ---------------------------------------------------------------------------

def current_person(db: Session = Depends(get_db),
                   current_user: User = Depends(get_current_user)) -> SplitPerson:
    """Resolve the bearer token to a SplitPerson, creating or claiming as needed.

    Committing here matters: identity resolution can *claim a guest row*, and
    that claim has to survive even if the request it arrived on later fails.
    """
    person = split_service.get_person_for_user(db, current_user)
    db.commit()
    db.refresh(person)
    return person


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------

class GroupCreate(BaseModel):
    name: str
    group_type: str = "other"
    currency: str = DEFAULT_CURRENCY
    emoji: Optional[str] = None
    simplify_debts: bool = True


class GroupUpdate(BaseModel):
    name: Optional[str] = None
    group_type: Optional[str] = None
    emoji: Optional[str] = None
    simplify_debts: Optional[bool] = None
    is_archived: Optional[bool] = None


class PersonRef(BaseModel):
    person_id: Optional[int] = None
    email: Optional[str] = None
    name: Optional[str] = None
    phone: Optional[str] = None


class PayerIn(BaseModel):
    person_id: int
    # Major units as the user typed them ("1200.50"). Accepted as a string so a
    # client cannot lose precision to a JSON float before we ever see it;
    # split_math.to_minor is strict about what it will parse.
    amount: Any


class ItemIn(BaseModel):
    name: str
    amount: Any
    participant_person_ids: List[int] = Field(default_factory=list)


class ExpenseIn(BaseModel):
    group_id: Optional[int] = None
    description: str
    amount: Any
    currency: Optional[str] = None
    expense_date: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None
    receipt_url: Optional[str] = None
    split_mode: str = "equal"
    participant_person_ids: List[int] = Field(default_factory=list)
    payers: List[PayerIn] = Field(default_factory=list)
    # person_id -> percentage / share count / exact amount, depending on mode.
    split_values: Optional[Dict[str, Any]] = None
    items: Optional[List[ItemIn]] = None
    client_token: Optional[str] = None


class ExpenseUpdate(BaseModel):
    description: Optional[str] = None
    amount: Optional[Any] = None
    currency: Optional[str] = None
    expense_date: Optional[str] = None
    category: Optional[str] = None
    notes: Optional[str] = None
    receipt_url: Optional[str] = None
    split_mode: Optional[str] = None
    participant_person_ids: Optional[List[int]] = None
    payers: Optional[List[PayerIn]] = None
    split_values: Optional[Dict[str, Any]] = None
    items: Optional[List[ItemIn]] = None


class SettlementIn(BaseModel):
    group_id: Optional[int] = None
    from_person_id: int
    to_person_id: int
    amount: Any
    currency: Optional[str] = None
    method: str = "cash"
    note: Optional[str] = None
    settled_on: Optional[str] = None
    client_token: Optional[str] = None


class InviteIn(BaseModel):
    email: Optional[str] = None
    name: Optional[str] = None
    phone: Optional[str] = None
    group_id: Optional[int] = None


class FriendAdd(BaseModel):
    person_id: Optional[int] = None
    email: Optional[str] = None
    name: Optional[str] = None


# ---------------------------------------------------------------------------
# Serialisers
#
# Every money field goes out three ways: `*_minor` for arithmetic the client
# might do, a decimal string for precision-safe display, and a preformatted
# string for rendering. The client never divides by 100 itself, which is where
# rounding bugs would otherwise creep back in on the way to the screen.
# ---------------------------------------------------------------------------

def money(minor: int, currency: str) -> dict:
    minor = int(minor or 0)
    return {
        "minor": minor,
        "amount": str(from_minor(minor, currency)),
        "display": format_minor(minor, currency),
        "currency": currency,
        "symbol": currency_symbol(currency),
    }


def serialize_expense(db: Session, exp: SplitExpense, me: SplitPerson,
                      people: Optional[Dict[int, SplitPerson]] = None) -> dict:
    people = people or _people_map(db, [s.person_id for s in exp.shares]
                                   + [p.person_id for p in exp.payers]
                                   + [exp.created_by_person_id])
    shares = {s.person_id: int(s.share_minor) for s in exp.shares}
    payers = {p.person_id: int(p.amount_minor) for p in exp.payers}
    my_net = payers.get(me.id, 0) - shares.get(me.id, 0)

    return {
        "id": exp.id,
        "group_id": exp.group_id,
        "description": exp.description,
        "total": money(exp.total_minor, exp.currency),
        "currency": exp.currency,
        "date": exp.expense_date.isoformat() if exp.expense_date else None,
        "category": exp.category,
        "notes": exp.notes,
        "receipt_url": exp.receipt_url,
        "split_mode": exp.split_mode,
        "created_by": split_service.serialize_person(people[exp.created_by_person_id], me.id)
                      if exp.created_by_person_id in people else None,
        "payers": [{
            "person": split_service.serialize_person(people[pid], me.id),
            "amount": money(amount, exp.currency),
        } for pid, amount in payers.items() if pid in people],
        "shares": [{
            "person": split_service.serialize_person(people[s.person_id], me.id),
            "amount": money(int(s.share_minor), exp.currency),
            "weight": s.weight,
        } for s in exp.shares if s.person_id in people],
        "items": [{
            "id": i.id, "name": i.name,
            "amount": money(i.amount_minor, exp.currency),
            "participant_person_ids": i.participant_person_ids or [],
        } for i in sorted(exp.items, key=lambda x: x.position)],
        # What this expense means for the person reading it — the only line the
        # list view actually renders in colour.
        "your_net": money(my_net, exp.currency),
        "your_share": money(shares.get(me.id, 0), exp.currency),
        "you_paid": money(payers.get(me.id, 0), exp.currency),
        "involves_you": me.id in shares or me.id in payers,
        "created_at": exp.created_at.isoformat() if exp.created_at else None,
    }


def _people_map(db: Session, ids) -> Dict[int, SplitPerson]:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    return {p.id: p for p in db.query(SplitPerson).filter(SplitPerson.id.in_(ids)).all()}


def serialize_activity(act, me: SplitPerson) -> dict:
    """One row of the activity feed, resolved to the reader's point of view.

    `tone` and `your_net` are computed per reader rather than stored, because
    the same event means opposite things to two people: the expense Divij added
    is money coming back to him and money owed by everyone else. The client
    renders colour and the "you get back / you owe" line straight off these,
    so it never has to re-derive meaning from the kind string.
    """
    tone = "neutral"
    your_net = None
    meta = act.meta or {}

    if act.kind in ("expense_added", "expense_updated", "expense_deleted"):
        net = (meta.get("net_by_person") or {}).get(str(me.id))
        if net is not None:
            net = int(net)
            your_net = money(net, act.currency)
            tone = "positive" if net > 0 else ("negative" if net < 0 else "neutral")
    elif act.kind == "settlement_added":
        # Receiving a settlement is money arriving; paying one clears a debt,
        # which is good news but not income, so it stays neutral.
        if meta.get("to_person_id") == me.id:
            tone = "positive"
            your_net = money(act.amount_minor or 0, act.currency)
        elif meta.get("from_person_id") == me.id:
            tone = "neutral"

    return {
        "id": act.id,
        "kind": act.kind,
        "summary": act.summary,
        "actor_name": act.actor_name,
        "group_id": act.group_id,
        "group_name": meta.get("group_name"),
        "expense_id": act.expense_id,
        "settlement_id": act.settlement_id,
        "amount": money(act.amount_minor, act.currency) if act.amount_minor is not None else None,
        "your_net": your_net,
        "tone": tone,
        "meta": meta,
        "created_at": act.created_at.isoformat() if act.created_at else None,
    }


# ---------------------------------------------------------------------------
# Me / entitlements
# ---------------------------------------------------------------------------

@router.get("/me")
def get_me(db: Session = Depends(get_db), me: SplitPerson = Depends(current_person),
           current_user: User = Depends(get_current_user)):
    ledger = split_service.overall_ledger(db, me)
    summary = summarize_for(ledger, me.id)
    db.commit()
    return {
        "person": split_service.serialize_person(me, me.id),
        "summary": {
            "net": money(summary["net_minor"], DEFAULT_CURRENCY),
            "owed_to_you": money(summary["owed_to_you_minor"], DEFAULT_CURRENCY),
            "you_owe": money(summary["you_owe_minor"], DEFAULT_CURRENCY),
            "status": summary["status"],
        },
        "entitlements": subscription_service.entitlements(db, current_user.id),
        "categories": split_service.EXPENSE_CATEGORIES,
        "unread_notifications": notification_service.unread_count(db, current_user.id),
    }


@router.get("/entitlements")
def get_entitlements(db: Session = Depends(get_db),
                     current_user: User = Depends(get_current_user)):
    return subscription_service.entitlements(db, current_user.id)


# ---------------------------------------------------------------------------
# Friends
# ---------------------------------------------------------------------------

@router.get("/friends")
def list_friends(db: Session = Depends(get_db), me: SplitPerson = Depends(current_person)):
    """Friends with the live balance between each of them and the caller."""
    friends = split_service.list_friends(db, me)
    ledger = split_service.overall_ledger(db, me)
    out = []
    for f in friends:
        balance = ledger.between(me.id, f.id)   # >0 means they owe the caller
        out.append({
            **split_service.serialize_person(f, me.id),
            "balance": money(balance, DEFAULT_CURRENCY),
            "status": "settled" if balance == 0 else ("owes_you" if balance > 0 else "you_owe"),
        })
    out.sort(key=lambda r: (r["status"] == "settled", -abs(r["balance"]["minor"]), r["display_name"]))
    db.commit()
    return {"friends": out}


@router.get("/friends/search")
def search_friends(q: str = Query(..., min_length=2),
                   db: Session = Depends(get_db), me: SplitPerson = Depends(current_person)):
    rows = split_service.search_people(db, me, q)
    return {"results": [split_service.serialize_person(p, me.id) for p in rows]}


@router.post("/friends", status_code=201)
def add_friend(req: FriendAdd, db: Session = Depends(get_db),
               me: SplitPerson = Depends(current_person)):
    if req.person_id:
        other = db.query(SplitPerson).filter(SplitPerson.id == req.person_id).first()
        if not other:
            raise HTTPException(status_code=404, detail="That person was not found")
    else:
        other = split_service.find_or_create_guest(db, me, req.email, req.name)
    split_service.add_friend(db, me, other)
    db.commit()
    return {"friend": split_service.serialize_person(other, me.id)}


@router.get("/friends/{person_id}")
def friend_detail(person_id: int, db: Session = Depends(get_db),
                  me: SplitPerson = Depends(current_person)):
    """One friend: the balance, plus every expense the two of you share.

    The expense list is filtered to those the caller is genuinely part of, so
    this cannot be used to read a friend's unrelated activity.
    """
    friend = db.query(SplitPerson).filter(SplitPerson.id == person_id).first()
    if not friend:
        raise HTTPException(status_code=404, detail="That person was not found")

    ledger = split_service.overall_ledger(db, me)
    balance = ledger.between(me.id, friend.id)

    shared = [e for e in _my_expenses(db, me)
              if {s.person_id for s in e.shares} | {p.person_id for p in e.payers} >= {me.id, friend.id}]
    people = _people_map(db, [me.id, friend.id])

    settlements = db.query(SplitSettlement).filter(
        SplitSettlement.is_deleted == False,  # noqa: E712
        SplitSettlement.from_person_id.in_([me.id, friend.id]),
        SplitSettlement.to_person_id.in_([me.id, friend.id]),
    ).order_by(SplitSettlement.settled_on.desc()).all()

    db.commit()
    return {
        "friend": split_service.serialize_person(friend, me.id),
        "balance": money(balance, DEFAULT_CURRENCY),
        "status": "settled" if balance == 0 else ("owes_you" if balance > 0 else "you_owe"),
        "expenses": [serialize_expense(db, e, me) for e in shared],
        "settlements": [{
            "id": s.id,
            "from": split_service.serialize_person(people[s.from_person_id], me.id),
            "to": split_service.serialize_person(people[s.to_person_id], me.id),
            "amount": money(s.amount_minor, s.currency),
            "method": s.method, "note": s.note,
            "date": s.settled_on.isoformat() if s.settled_on else None,
        } for s in settlements if s.from_person_id in people and s.to_person_id in people],
    }


def _my_expenses(db: Session, me: SplitPerson) -> List[SplitExpense]:
    from backend.models.domain import SplitExpensePayer, SplitExpenseShare
    ids = {e for (e,) in db.query(SplitExpenseShare.expense_id).filter(
        SplitExpenseShare.person_id == me.id).all()}
    ids |= {e for (e,) in db.query(SplitExpensePayer.expense_id).filter(
        SplitExpensePayer.person_id == me.id).all()}
    if not ids:
        return []
    return db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
        joinedload(SplitExpense.items),
    ).filter(
        SplitExpense.id.in_(ids),
        SplitExpense.is_deleted == False,  # noqa: E712
    ).order_by(SplitExpense.expense_date.desc(), SplitExpense.id.desc()).all()


# ---------------------------------------------------------------------------
# Groups
# ---------------------------------------------------------------------------

@router.get("/groups")
def list_groups(include_archived: bool = False,
                db: Session = Depends(get_db), me: SplitPerson = Depends(current_person)):
    memberships = db.query(SplitGroupMember).filter(
        SplitGroupMember.person_id == me.id,
        SplitGroupMember.is_active == True,  # noqa: E712
    ).all()
    group_ids = [m.group_id for m in memberships]
    if not group_ids:
        db.commit()
        return {"groups": []}

    q = db.query(SplitGroup).filter(SplitGroup.id.in_(group_ids))
    if not include_archived:
        q = q.filter(SplitGroup.is_archived == False)  # noqa: E712

    out = []
    for group in q.order_by(SplitGroup.updated_at.desc()).all():
        ledger = split_service.group_ledger(db, group)
        net = ledger.net.get(me.id, 0)
        member_ids = split_service.group_member_ids(db, group.id)
        people = _people_map(db, member_ids)
        # member_names and expense_count are additive display fields for the
        # group card, which shows who is in a group and how busy it is without
        # the client having to fetch every group's detail to find out. Nothing
        # is computed here that the detail endpoint did not already compute —
        # this only surfaces it one level up.
        expense_count = db.query(SplitExpense).filter(
            SplitExpense.group_id == group.id,
            SplitExpense.is_deleted == False,  # noqa: E712
        ).count()
        out.append({
            "id": group.id, "name": group.name, "emoji": group.emoji,
            "group_type": group.group_type, "currency": group.currency,
            "is_archived": group.is_archived,
            "member_count": len(member_ids),
            "member_names": [
                ("You" if pid == me.id else people[pid].display_name)
                for pid in member_ids if pid in people
            ],
            "members": [
                split_service.serialize_person(people[pid], me.id)
                for pid in member_ids if pid in people
            ],
            "expense_count": expense_count,
            "your_balance": money(net, group.currency),
            "status": "settled" if net == 0 else ("owed" if net > 0 else "owes"),
        })
    db.commit()
    return {"groups": out}


@router.post("/groups", status_code=201)
def create_group(req: GroupCreate, db: Session = Depends(get_db),
                 me: SplitPerson = Depends(current_person)):
    group = split_service.create_group(
        db, me, req.name, req.group_type, req.currency, req.emoji, req.simplify_debts,
    )
    db.commit()
    return {"id": group.id, "name": group.name}


@router.get("/groups/{group_id}")
def group_detail(group_id: int, db: Session = Depends(get_db),
                 me: SplitPerson = Depends(current_person)):
    """Everything the group screen renders, in one call.

    Summary, balances, simplified settle-up suggestions, member totals,
    expenses and activity — the screen has a fixed information hierarchy and
    fetching it piecemeal would make the header and the list disagree while
    requests land out of order.
    """
    group = split_service.resolve_group(db, group_id, me)
    ledger = split_service.group_ledger(db, group)
    member_ids = split_service.group_member_ids(db, group.id)
    people = _people_map(db, member_ids)

    expenses = db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
        joinedload(SplitExpense.items),
    ).filter(
        SplitExpense.group_id == group.id,
        SplitExpense.is_deleted == False,  # noqa: E712
    ).order_by(SplitExpense.expense_date.desc(), SplitExpense.id.desc()).all()

    settlements = db.query(SplitSettlement).filter(
        SplitSettlement.group_id == group.id,
        SplitSettlement.is_deleted == False,  # noqa: E712
    ).order_by(SplitSettlement.settled_on.desc(), SplitSettlement.id.desc()).all()

    total_spent = sum(int(e.total_minor) for e in expenses)
    your_total = sum(int(s.share_minor) for e in expenses for s in e.shares if s.person_id == me.id)

    # Per-member: what they paid, what they owe, and where they net out.
    paid_by = {pid: 0 for pid in member_ids}
    share_by = {pid: 0 for pid in member_ids}
    for e in expenses:
        for p in e.payers:
            if p.person_id in paid_by:
                paid_by[p.person_id] += int(p.amount_minor)
        for s in e.shares:
            if s.person_id in share_by:
                share_by[s.person_id] += int(s.share_minor)

    by_category: Dict[str, int] = {}
    for e in expenses:
        key = e.category or "Uncategorised"
        by_category[key] = by_category.get(key, 0) + int(e.total_minor)

    balances = []
    for (debtor, creditor), amount in sorted(ledger.pairwise.items(), key=lambda kv: -kv[1]):
        if debtor in people and creditor in people:
            balances.append({
                "from": split_service.serialize_person(people[debtor], me.id),
                "to": split_service.serialize_person(people[creditor], me.id),
                "amount": money(amount, group.currency),
            })

    suggestions = [{
        "from": split_service.serialize_person(people[t["from_person_id"]], me.id),
        "to": split_service.serialize_person(people[t["to_person_id"]], me.id),
        "amount": money(t["amount_minor"], group.currency),
    } for t in ledger.simplified()
        if t["from_person_id"] in people and t["to_person_id"] in people]

    summary = summarize_for(ledger, me.id, group.currency)
    activity = split_service.list_activity(db, me, group_id=group.id, limit=40)
    db.commit()

    return {
        "group": {
            "id": group.id, "name": group.name, "emoji": group.emoji,
            "group_type": group.group_type, "currency": group.currency,
            "simplify_debts": group.simplify_debts, "is_archived": group.is_archived,
            "created_by_person_id": group.created_by_person_id,
            "is_owner": group.created_by_person_id == me.id,
        },
        "members": [{
            **split_service.serialize_person(people[pid], me.id),
            "paid": money(paid_by.get(pid, 0), group.currency),
            "share": money(share_by.get(pid, 0), group.currency),
            "net": money(ledger.net.get(pid, 0), group.currency),
        } for pid in member_ids if pid in people],
        "summary": {
            "net": money(summary["net_minor"], group.currency),
            "owed_to_you": money(summary["owed_to_you_minor"], group.currency),
            "you_owe": money(summary["you_owe_minor"], group.currency),
            "status": summary["status"],
            "total_spent": money(total_spent, group.currency),
            "your_total_share": money(your_total, group.currency),
            "expense_count": len(expenses),
        },
        "balances": balances,
        # What the Settle Up button offers. Uses the simplified transfer set
        # when the group has simplification on, and the raw pairwise debts when
        # it does not — the group's own setting decides, not the client.
        "settle_suggestions": suggestions if group.simplify_debts else balances,
        "by_category": [
            {"category": k, "amount": money(v, group.currency)}
            for k, v in sorted(by_category.items(), key=lambda kv: -kv[1])
        ],
        "expenses": [serialize_expense(db, e, me, people) for e in expenses],
        "settlements": [{
            "id": s.id,
            "from": split_service.serialize_person(people[s.from_person_id], me.id)
                    if s.from_person_id in people else None,
            "to": split_service.serialize_person(people[s.to_person_id], me.id)
                  if s.to_person_id in people else None,
            "amount": money(s.amount_minor, s.currency),
            "method": s.method, "note": s.note,
            "date": s.settled_on.isoformat() if s.settled_on else None,
        } for s in settlements],
        "activity": [serialize_activity(a, me) for a in activity],
    }


@router.put("/groups/{group_id}")
def update_group(group_id: int, req: GroupUpdate, db: Session = Depends(get_db),
                 me: SplitPerson = Depends(current_person)):
    group = split_service.resolve_group(db, group_id, me, require_owner=True)
    if req.name is not None:
        name = req.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="A group needs a name")
        group.name = name
    if req.group_type is not None:
        group.group_type = req.group_type
    if req.emoji is not None:
        group.emoji = req.emoji or None
    if req.simplify_debts is not None:
        group.simplify_debts = bool(req.simplify_debts)
    if req.is_archived is not None:
        group.is_archived = bool(req.is_archived)
    db.commit()
    return {"status": "saved"}


@router.post("/groups/{group_id}/members", status_code=201)
def add_group_member(group_id: int, req: PersonRef, db: Session = Depends(get_db),
                     me: SplitPerson = Depends(current_person)):
    group = split_service.resolve_group(db, group_id, me)
    if req.person_id:
        person = db.query(SplitPerson).filter(SplitPerson.id == req.person_id).first()
        if not person:
            raise HTTPException(status_code=404, detail="That person was not found")
    else:
        person = split_service.find_or_create_guest(db, me, req.email, req.name, req.phone)
    split_service.add_member(db, group, me, person)
    db.commit()
    return {"member": split_service.serialize_person(person, me.id)}


@router.delete("/groups/{group_id}/members/{person_id}", status_code=204)
def remove_group_member(group_id: int, person_id: int, db: Session = Depends(get_db),
                        me: SplitPerson = Depends(current_person)):
    # Anyone may remove themselves (leaving); removing somebody else is the
    # owner's call. Checked here rather than in the service because it is a
    # policy about *this endpoint*, not about the membership record.
    group = split_service.resolve_group(db, group_id, me, require_owner=(person_id != me.id))
    split_service.remove_member(db, group, me, person_id)
    db.commit()


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------

@router.post("/invitations", status_code=201)
def create_invitation(req: InviteIn, db: Session = Depends(get_db),
                      me: SplitPerson = Depends(current_person)):
    group = split_service.resolve_group(db, req.group_id, me) if req.group_id else None
    invite = split_service.create_invitation(db, me, req.email, req.name, group, req.phone)
    db.commit()
    return {
        "token": invite.token,
        "person": split_service.serialize_person(invite.person, me.id),
        "status": invite.status,
        # A relative path so the link is correct on localhost, on a LAN IP and
        # in production without the server needing to know its own hostname.
        "invite_path": f"/join.html?token={invite.token}",
    }


@router.get("/invite/{token}")
def preview_invitation(token: str, db: Session = Depends(get_db)):
    """Unauthenticated on purpose — this is the landing page for someone who
    does not have an account yet. Returns only the inviter's name and the
    group's name, never its expenses or balances."""
    return split_service.invitation_preview(db, token)


@router.post("/invite/{token}/accept")
def accept_invitation(token: str, db: Session = Depends(get_db),
                      current_user: User = Depends(get_current_user)):
    result = split_service.accept_invitation(db, token, current_user)
    db.commit()
    return result


# ---------------------------------------------------------------------------
# Expenses
# ---------------------------------------------------------------------------

@router.post("/expenses", status_code=201)
def create_expense(req: ExpenseIn, db: Session = Depends(get_db),
                   me: SplitPerson = Depends(current_person),
                   current_user: User = Depends(get_current_user)):
    payload = req.model_dump()
    payload["payers"] = [p.model_dump() for p in req.payers]
    payload["items"] = [i.model_dump() for i in (req.items or [])] or None

    # Multi-currency is the one part of adding an expense that is gated. The
    # check is on the *group's* currency, so a free user is never blocked from
    # a group that simply happens to be in USD — only from mixing currencies
    # inside one.
    if req.group_id and req.currency:
        group = split_service.resolve_group(db, req.group_id, me)
        if normalize_currency(req.currency) != normalize_currency(group.currency):
            subscription_service.require_premium(db, current_user.id, "split_multi_currency")

    try:
        expense = split_service.create_expense(db, me, payload)
    except SplitMathError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.commit()
    db.refresh(expense)
    return serialize_expense(db, expense, me)


@router.get("/expenses/{expense_id}")
def get_expense(expense_id: int, db: Session = Depends(get_db),
                me: SplitPerson = Depends(current_person)):
    expense = split_service.resolve_expense(db, expense_id, me)
    db.commit()
    return serialize_expense(db, expense, me)


@router.put("/expenses/{expense_id}")
def update_expense(expense_id: int, req: ExpenseUpdate, db: Session = Depends(get_db),
                   me: SplitPerson = Depends(current_person)):
    expense = split_service.resolve_expense(db, expense_id, me, for_write=True)
    payload = req.model_dump(exclude_unset=True)
    if req.payers is not None:
        payload["payers"] = [p.model_dump() for p in req.payers]
    if req.items is not None:
        payload["items"] = [i.model_dump() for i in req.items]
    try:
        expense = split_service.update_expense(db, me, expense, payload)
    except SplitMathError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.commit()
    db.refresh(expense)
    return serialize_expense(db, expense, me)


@router.delete("/expenses/{expense_id}", status_code=204)
def delete_expense(expense_id: int, db: Session = Depends(get_db),
                   me: SplitPerson = Depends(current_person)):
    expense = split_service.resolve_expense(db, expense_id, me, for_write=True)
    split_service.delete_expense(db, me, expense)
    db.commit()


@router.get("/expenses")
def list_expenses(group_id: Optional[int] = None,
                  limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
                  db: Session = Depends(get_db), me: SplitPerson = Depends(current_person)):
    if group_id:
        split_service.resolve_group(db, group_id, me)
        rows = db.query(SplitExpense).options(
            joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
            joinedload(SplitExpense.items),
        ).filter(
            SplitExpense.group_id == group_id,
            SplitExpense.is_deleted == False,  # noqa: E712
        ).order_by(SplitExpense.expense_date.desc(), SplitExpense.id.desc()) \
         .offset(offset).limit(limit).all()
    else:
        rows = _my_expenses(db, me)[offset:offset + limit]
    db.commit()
    return {"expenses": [serialize_expense(db, e, me) for e in rows]}


# ---------------------------------------------------------------------------
# Settlements
# ---------------------------------------------------------------------------

@router.post("/settlements", status_code=201)
def create_settlement(req: SettlementIn, db: Session = Depends(get_db),
                      me: SplitPerson = Depends(current_person)):
    try:
        settlement = split_service.create_settlement(db, me, req.model_dump())
    except SplitMathError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.commit()
    db.refresh(settlement)
    people = _people_map(db, [settlement.from_person_id, settlement.to_person_id])
    return {
        "id": settlement.id,
        "from": split_service.serialize_person(people[settlement.from_person_id], me.id),
        "to": split_service.serialize_person(people[settlement.to_person_id], me.id),
        "amount": money(settlement.amount_minor, settlement.currency),
        "method": settlement.method,
        "date": settlement.settled_on.isoformat() if settlement.settled_on else None,
    }


@router.delete("/settlements/{settlement_id}", status_code=204)
def delete_settlement(settlement_id: int, db: Session = Depends(get_db),
                      me: SplitPerson = Depends(current_person)):
    settlement = split_service.resolve_settlement(db, settlement_id, me)
    split_service.delete_settlement(db, me, settlement)
    db.commit()


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------

@router.get("/activity")
def activity(group_id: Optional[int] = None,
             limit: int = Query(50, ge=1, le=200), offset: int = Query(0, ge=0),
             db: Session = Depends(get_db), me: SplitPerson = Depends(current_person)):
    if group_id:
        split_service.resolve_group(db, group_id, me)
    rows = split_service.list_activity(db, me, group_id=group_id, limit=limit, offset=offset)
    db.commit()
    return {"activity": [serialize_activity(a, me) for a in rows]}


# ---------------------------------------------------------------------------
# Premium-gated
# ---------------------------------------------------------------------------

@router.get("/groups/{group_id}/analytics")
def group_analytics(group_id: int, db: Session = Depends(get_db),
                    me: SplitPerson = Depends(current_person),
                    current_user: User = Depends(get_current_user)):
    """Advanced charts — Premium. The basic category breakdown stays free on
    the group screen; this adds the per-member and month-over-month cuts."""
    subscription_service.require_premium(db, current_user.id, "split_advanced_charts")
    group = split_service.resolve_group(db, group_id, me)

    expenses = db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
    ).filter(
        SplitExpense.group_id == group.id,
        SplitExpense.is_deleted == False,  # noqa: E712
    ).all()

    by_month: Dict[str, int] = {}
    by_member: Dict[int, int] = {}
    for e in expenses:
        key = e.expense_date.strftime("%Y-%m") if e.expense_date else "unknown"
        by_month[key] = by_month.get(key, 0) + int(e.total_minor)
        for s in e.shares:
            by_member[s.person_id] = by_member.get(s.person_id, 0) + int(s.share_minor)

    people = _people_map(db, list(by_member.keys()))
    db.commit()
    return {
        "by_month": [{"month": k, "amount": money(v, group.currency)}
                     for k, v in sorted(by_month.items())],
        "by_member": [{
            "person": split_service.serialize_person(people[pid], me.id),
            "amount": money(amount, group.currency),
        } for pid, amount in sorted(by_member.items(), key=lambda kv: -kv[1]) if pid in people],
    }


@router.get("/groups/{group_id}/export")
def export_group(group_id: int, db: Session = Depends(get_db),
                 me: SplitPerson = Depends(current_person),
                 current_user: User = Depends(get_current_user)):
    """CSV of every expense in the group — Premium."""
    subscription_service.require_premium(db, current_user.id, "split_export")
    group = split_service.resolve_group(db, group_id, me)
    expenses = db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
    ).filter(
        SplitExpense.group_id == group.id,
        SplitExpense.is_deleted == False,  # noqa: E712
    ).order_by(SplitExpense.expense_date).all()

    people = _people_map(db, split_service.group_member_ids(db, group.id))
    lines = ["Date,Description,Category,Total,Paid by,Your share"]
    for e in expenses:
        payers = "; ".join(
            people[p.person_id].display_name for p in e.payers if p.person_id in people
        )
        mine = next((int(s.share_minor) for s in e.shares if s.person_id == me.id), 0)
        desc = (e.description or "").replace('"', '""')
        lines.append(
            f'{e.expense_date},"{desc}","{e.category or ""}",'
            f'{from_minor(e.total_minor, e.currency)},"{payers}",{from_minor(mine, e.currency)}'
        )
    db.commit()
    return {"filename": f"{group.name.replace(' ', '_')}_expenses.csv", "csv": "\n".join(lines)}
