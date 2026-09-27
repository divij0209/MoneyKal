"""
Money Splits — domain service.

Everything the router needs that is not HTTP: resolving identities, enforcing
who may see what, computing and persisting expense shares, recording
settlements, and writing the activity/notification trail.

The router is kept thin on purpose. Authorization in particular lives here, in
functions the router cannot bypass, because "never trust an id from the client"
only holds if there is exactly one way to turn a client-supplied id into an
object — `resolve_group`, `resolve_expense` and `resolve_settlement` are that
way, and each takes the caller's person and raises rather than returning
something the caller is not entitled to.
"""
import logging
import secrets
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

from fastapi import HTTPException
from sqlalchemy import func, or_
from sqlalchemy.orm import Session, joinedload

from backend.models.domain import (
    SplitActivity, SplitExpense, SplitExpenseItem,
    SplitExpensePayer, SplitExpenseShare, SplitFriendship, SplitGroup,
    SplitGroupMember, SplitInvitation, SplitPerson, SplitSettlement, User,
)
from backend.services import notification_service
from backend.services.split_ledger import build_ledger
from backend.services.split_math import (
    DEFAULT_CURRENCY, SplitMathError, allocate_by_percent, allocate_by_weights,
    allocate_equal, format_minor, normalize_currency, to_minor, validate_exact,
)

logger = logging.getLogger(__name__)

SPLIT_MODES = ("equal", "exact", "percent", "shares", "itemized")

EXPENSE_CATEGORIES = [
    "Food & Dining", "Groceries", "Rent / Housing", "Utilities & Bills",
    "Travel & Transport", "Entertainment", "Shopping", "Health & Medical",
    "Accommodation", "Fuel", "Gifts", "Other",
]

# Deterministic chip colours drawn from the MoneyKal palette, so a person's
# avatar is the same colour on every screen without storing a preference.
_AVATAR_COLORS = [
    "#00e5ff", "#5cefff", "#0098ad", "#7cecf9", "#03899e",
    "#0aa6bf", "#22ecff", "#6fcbd8",
]


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

def _avatar_color(seed: str) -> str:
    return _AVATAR_COLORS[sum(ord(c) for c in (seed or "?")) % len(_AVATAR_COLORS)]


def normalize_email(value: Optional[str]) -> Optional[str]:
    """Matches backend.routers.auth.normalize_username exactly.

    It has to: usernames in this product *are* email addresses, and the guest
    claim works by looking a new registration's username up in this column. If
    the two normalisations ever diverged, a guest invited as "Divij@x.com"
    would not be found when divij@x.com signed up, and we would silently create
    the duplicate person this design exists to prevent.
    """
    value = (value or "").strip().lower()
    return value or None


def get_person_for_user(db: Session, user: User, create: bool = True) -> Optional[SplitPerson]:
    """The SplitPerson identity for a logged-in account.

    Resolves in three steps, and the middle one is the important one:

    1. An identity already linked to this user id.
    2. An *unclaimed guest* with this user's email — someone invited them
       before they signed up. Claim it, which instantly hands them every
       expense, share and balance that was recorded against the guest.
    3. Otherwise mint a fresh identity.

    Step 2 also runs for users who registered normally and were invited
    afterwards under the same address, so the claim is not limited to people
    who arrive through an invitation link.
    """
    person = db.query(SplitPerson).filter(SplitPerson.user_id == user.id).first()
    if person:
        return person
    if not create:
        return None

    email = normalize_email(user.username)
    if email:
        guest = db.query(SplitPerson).filter(
            func.lower(SplitPerson.email) == email,
            SplitPerson.user_id.is_(None),
        ).first()
        if guest:
            guest.user_id = user.id
            guest.claimed_at = datetime.utcnow()
            db.flush()
            logger.info("Claimed guest person %s for user %s", guest.id, user.id)
            return guest

    person = SplitPerson(
        user_id=user.id,
        email=email,
        display_name=_display_name_from_email(email) or f"User {user.id}",
        avatar_color=_avatar_color(email or str(user.id)),
        claimed_at=datetime.utcnow(),
    )
    db.add(person)
    db.flush()
    return person


def _display_name_from_email(email: Optional[str]) -> Optional[str]:
    if not email or "@" not in email:
        return email
    local = email.split("@", 1)[0]
    cleaned = local.replace(".", " ").replace("_", " ").replace("-", " ").strip()
    return cleaned.title() if cleaned else email


def find_or_create_guest(db: Session, creator: SplitPerson, email: Optional[str],
                         name: Optional[str], phone: Optional[str] = None) -> SplitPerson:
    """Resolve an invitee to a participant identity, creating a guest if needed.

    Deliberately looks up by email *without* filtering on `user_id IS NULL`: if
    the address already belongs to a real MoneyKal account, we want that
    account, not a second guest shadowing it. That single choice is what stops
    the duplicate-user problem at the source, since every path that adds a
    person to a group or an expense goes through here.
    """
    email = normalize_email(email)
    if email:
        existing = db.query(SplitPerson).filter(func.lower(SplitPerson.email) == email).first()
        if existing:
            # Fill in a name we did not have before, but never overwrite one a
            # real user chose for themselves.
            if name and existing.user_id is None and existing.display_name != name:
                existing.display_name = name.strip()
            return existing

    if not name and not email:
        raise HTTPException(status_code=400, detail="A name or an email is required to add someone")

    guest = SplitPerson(
        user_id=None,
        email=email,
        display_name=(name or _display_name_from_email(email) or "Guest").strip(),
        phone=(phone or "").strip() or None,
        avatar_color=_avatar_color(email or name or "guest"),
        created_by_user_id=creator.user_id,
    )
    db.add(guest)
    db.flush()
    return guest


def claim_persons_for_new_user(db: Session, user: User) -> dict:
    """Called from /auth/register. Wires a brand-new account into any history
    that was already waiting for it.

    Returns a small summary the register endpoint passes back to the client, so
    the UI can say "you have been added to 2 groups" instead of dropping the
    user on an empty Split screen with no explanation of why they were invited.

    Wrapped so that a failure here can never break registration: signing up
    must succeed even if the Split tables are unavailable.
    """
    result = {"claimed": False, "groups": 0, "invitations": 0}
    try:
        email = normalize_email(user.username)
        person = get_person_for_user(db, user)
        if not person:
            return result
        result["claimed"] = person.claimed_at is not None and person.created_by_user_id is not None

        if email:
            invites = db.query(SplitInvitation).filter(
                func.lower(SplitInvitation.email) == email,
                SplitInvitation.status == "pending",
            ).all()
            for inv in invites:
                accept_invitation_row(db, inv, user, person)
                result["invitations"] += 1

        result["groups"] = db.query(SplitGroupMember).filter(
            SplitGroupMember.person_id == person.id,
            SplitGroupMember.is_active == True,  # noqa: E712
        ).count()
        db.flush()
    except Exception:
        logger.exception("Guest claim failed for user %s", user.id)
    return result


def serialize_person(person: SplitPerson, viewer_person_id: Optional[int] = None) -> dict:
    return {
        "id": person.id,
        "name": "You" if viewer_person_id == person.id else person.display_name,
        "display_name": person.display_name,
        "email": person.email,
        "is_guest": person.user_id is None,
        "is_you": viewer_person_id == person.id,
        "avatar_color": person.avatar_color or _avatar_color(person.display_name or "?"),
        "initials": _initials(person.display_name),
    }


def _initials(name: Optional[str]) -> str:
    parts = [p for p in (name or "?").split() if p]
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


# ---------------------------------------------------------------------------
# Friends
# ---------------------------------------------------------------------------

def _pair(a: int, b: int) -> Tuple[int, int]:
    """Friendship is symmetric, so it is stored once with the lower id first.
    Everything that reads or writes a friendship goes through this, which is
    what makes "are we friends" a single indexed lookup."""
    return (a, b) if a < b else (b, a)


def get_friendship(db: Session, a: int, b: int) -> Optional[SplitFriendship]:
    lo, hi = _pair(a, b)
    return db.query(SplitFriendship).filter(
        SplitFriendship.person_a_id == lo,
        SplitFriendship.person_b_id == hi,
    ).first()


def add_friend(db: Session, me: SplitPerson, other: SplitPerson) -> SplitFriendship:
    if me.id == other.id:
        raise HTTPException(status_code=400, detail="You cannot add yourself as a friend")
    link = get_friendship(db, me.id, other.id)
    if link:
        if link.status == "blocked":
            raise HTTPException(status_code=403, detail="This person is not accepting requests")
        return link

    lo, hi = _pair(me.id, other.id)
    # Accepted on creation, for both guests and real users. A guest has no way
    # to accept anything, so requiring acceptance would make them unusable and
    # defeat the invite flow; and for real users, being added to someone's
    # friend list grants no access to any of their data on its own — only
    # shared groups and shared expenses do that. The `pending` and `blocked`
    # states exist on the model for a request/block flow to build on later.
    link = SplitFriendship(
        person_a_id=lo, person_b_id=hi,
        status="accepted", requested_by_person_id=me.id,
    )
    db.add(link)
    db.flush()

    record_activity(
        db, kind="friend_added", actor=me,
        summary=f"{me.display_name} added {other.display_name} as a friend",
        audience=[me.id, other.id],
    )
    if other.user_id:
        notification_service.notify(
            db, other.user_id, kind="split_friend_added",
            title=f"{me.display_name} added you on Money Splits",
            body="You can now split expenses together.",
            link_type="split_friend", link_id=me.id,
            meta={"person_id": me.id, "name": me.display_name},
            whatsapp_text=f"{me.display_name} added you as a friend on Money Splits.",
        )
    return link


def list_friends(db: Session, me: SplitPerson) -> List[SplitPerson]:
    links = db.query(SplitFriendship).filter(
        or_(SplitFriendship.person_a_id == me.id, SplitFriendship.person_b_id == me.id),
        SplitFriendship.status == "accepted",
    ).all()
    ids = {(l.person_b_id if l.person_a_id == me.id else l.person_a_id) for l in links}

    # Anyone sharing a group counts as a friend for display purposes even if no
    # explicit link was ever made — being in a group together is a stronger
    # signal than a friend request, and a user who can already see your
    # expenses should not be missing from your friend list.
    my_group_ids = [m.group_id for m in db.query(SplitGroupMember).filter(
        SplitGroupMember.person_id == me.id,
        SplitGroupMember.is_active == True,  # noqa: E712
    ).all()]
    if my_group_ids:
        co = db.query(SplitGroupMember.person_id).filter(
            SplitGroupMember.group_id.in_(my_group_ids),
            SplitGroupMember.is_active == True,  # noqa: E712
        ).all()
        ids.update(pid for (pid,) in co)
    ids.discard(me.id)
    if not ids:
        return []
    return db.query(SplitPerson).filter(SplitPerson.id.in_(ids)).order_by(SplitPerson.display_name).all()


def search_people(db: Session, me: SplitPerson, query: str, limit: int = 10) -> List[SplitPerson]:
    """Find existing MoneyKal users by email or name.

    Restricted to an exact email match or a name prefix of at least two
    characters. A substring search over every person in the database would be a
    user-enumeration endpoint, which is not something a split feature needs to
    offer.
    """
    q = (query or "").strip().lower()
    if len(q) < 2:
        return []
    rows = db.query(SplitPerson).filter(
        SplitPerson.id != me.id,
        or_(
            func.lower(SplitPerson.email) == q,
            func.lower(SplitPerson.display_name).like(f"{q}%"),
        ),
    ).order_by(SplitPerson.display_name).limit(limit).all()
    return rows


# ---------------------------------------------------------------------------
# Groups — and the authorization boundary
# ---------------------------------------------------------------------------

def resolve_group(db: Session, group_id: int, me: SplitPerson,
                  require_owner: bool = False) -> SplitGroup:
    """Turn a client-supplied group id into a group this caller may actually use.

    Membership is checked before the group is returned, not after, and the same
    404 is raised for "no such group" and "not your group" so the endpoint
    cannot be used to probe which group ids exist.
    """
    group = db.query(SplitGroup).filter(SplitGroup.id == group_id).first()
    if not group:
        raise HTTPException(status_code=404, detail="Group not found")
    member = db.query(SplitGroupMember).filter(
        SplitGroupMember.group_id == group.id,
        SplitGroupMember.person_id == me.id,
        SplitGroupMember.is_active == True,  # noqa: E712
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="Group not found")
    if require_owner and member.role != "owner" and group.created_by_person_id != me.id:
        raise HTTPException(status_code=403, detail="Only the group owner can do that")
    return group


def group_member_ids(db: Session, group_id: int) -> List[int]:
    return [m.person_id for m in db.query(SplitGroupMember).filter(
        SplitGroupMember.group_id == group_id,
        SplitGroupMember.is_active == True,  # noqa: E712
    ).all()]


def create_group(db: Session, me: SplitPerson, name: str, group_type: str = "other",
                 currency: str = DEFAULT_CURRENCY, emoji: Optional[str] = None,
                 simplify: bool = True) -> SplitGroup:
    name = (name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="A group needs a name")

    group = SplitGroup(
        name=name,
        group_type=group_type if group_type in ("trip", "home", "couple", "friends", "other") else "other",
        emoji=emoji,
        currency=normalize_currency(currency),
        created_by_person_id=me.id,
        simplify_debts=bool(simplify),
    )
    db.add(group)
    db.flush()

    db.add(SplitGroupMember(group_id=group.id, person_id=me.id, role="owner"))
    db.flush()

    record_activity(
        db, kind="group_created", actor=me, group_id=group.id,
        summary=f"{me.display_name} created the group {group.name}",
        audience=[me.id],
    )
    return group


def add_member(db: Session, group: SplitGroup, me: SplitPerson,
               person: SplitPerson) -> SplitGroupMember:
    existing = db.query(SplitGroupMember).filter(
        SplitGroupMember.group_id == group.id,
        SplitGroupMember.person_id == person.id,
    ).first()
    if existing:
        if not existing.is_active:
            existing.is_active = True
            db.flush()
        return existing

    member = SplitGroupMember(group_id=group.id, person_id=person.id, role="member")
    db.add(member)
    db.flush()

    audience = group_member_ids(db, group.id)
    record_activity(
        db, kind="member_added", actor=me, group_id=group.id,
        summary=f"{me.display_name} added {person.display_name} to {group.name}",
        audience=audience,
    )
    if person.user_id:
        notification_service.notify(
            db, person.user_id, kind="split_group_invite",
            title=f"You were added to {group.name}",
            body=f"{me.display_name} added you to the group.",
            link_type="split_group", link_id=group.id,
            meta={"group_id": group.id, "group_name": group.name, "actor": me.display_name},
            whatsapp_text=f"{me.display_name} added you to the Money Splits group '{group.name}'.",
        )
    return member


def remove_member(db: Session, group: SplitGroup, me: SplitPerson, person_id: int) -> None:
    """Leave or remove someone — refused while they still have a balance.

    Letting a member with an outstanding balance disappear would silently
    delete money that other people are owed. The debt has to be settled first,
    which is a real constraint rather than a UI nicety.
    """
    member = db.query(SplitGroupMember).filter(
        SplitGroupMember.group_id == group.id,
        SplitGroupMember.person_id == person_id,
        SplitGroupMember.is_active == True,  # noqa: E712
    ).first()
    if not member:
        raise HTTPException(status_code=404, detail="That person is not in this group")

    ledger = group_ledger(db, group)
    if ledger.net.get(person_id, 0) != 0:
        raise HTTPException(
            status_code=400,
            detail="That person still has an outstanding balance in this group. Settle up first.",
        )

    member.is_active = False
    db.flush()
    person = db.query(SplitPerson).filter(SplitPerson.id == person_id).first()
    record_activity(
        db, kind="member_left", actor=me, group_id=group.id,
        summary=(f"{me.display_name} left {group.name}" if person_id == me.id
                 else f"{me.display_name} removed {person.display_name if person else 'a member'} from {group.name}"),
        audience=group_member_ids(db, group.id) + [person_id],
    )


# ---------------------------------------------------------------------------
# Invitations
# ---------------------------------------------------------------------------

def create_invitation(db: Session, me: SplitPerson, email: Optional[str], name: Optional[str],
                      group: Optional[SplitGroup] = None, phone: Optional[str] = None) -> SplitInvitation:
    """Invite someone, whether or not they use MoneyKal.

    The guest identity is created *now*, not when the invite is accepted, so
    the invitee can be put on expenses immediately. That is the whole point:
    the person who owes you money does not have to install anything before you
    can record that they owe it.
    """
    person = find_or_create_guest(db, me, email, name, phone)
    if person.id == me.id:
        raise HTTPException(status_code=400, detail="You cannot invite yourself")

    if group:
        add_member(db, group, me, person)
    else:
        add_friend(db, me, person)

    invite = SplitInvitation(
        token=secrets.token_urlsafe(24),
        invited_by_person_id=me.id,
        person_id=person.id,
        email=normalize_email(email),
        phone=phone,
        group_id=group.id if group else None,
        expires_at=datetime.utcnow() + timedelta(days=30),
        # A person who already has an account does not need to accept anything
        # — they are in. The row is kept as a record of the invite.
        status="accepted" if person.user_id else "pending",
    )
    if person.user_id:
        invite.accepted_by_user_id = person.user_id
        invite.accepted_at = datetime.utcnow()
    db.add(invite)
    db.flush()

    record_activity(
        db, kind="invite_sent", actor=me, group_id=group.id if group else None,
        summary=f"{me.display_name} invited {person.display_name}"
                + (f" to {group.name}" if group else ""),
        audience=[me.id, person.id],
    )
    return invite


def invitation_preview(db: Session, token: str) -> dict:
    """Unauthenticated read of an invite, for the landing page.

    Returns only what the page needs to say "Divij invited you to Goa Trip" —
    never the group's expenses or balances, which the visitor has no right to
    see until they have an account and are a member.
    """
    inv = db.query(SplitInvitation).filter(SplitInvitation.token == token).first()
    if not inv:
        raise HTTPException(status_code=404, detail="This invitation link is not valid")
    if inv.status == "revoked":
        raise HTTPException(status_code=410, detail="This invitation has been revoked")
    if inv.expires_at and inv.expires_at < datetime.utcnow() and inv.status == "pending":
        raise HTTPException(status_code=410, detail="This invitation has expired")

    inviter = db.query(SplitPerson).filter(SplitPerson.id == inv.invited_by_person_id).first()
    group = db.query(SplitGroup).filter(SplitGroup.id == inv.group_id).first() if inv.group_id else None
    return {
        "token": inv.token,
        "status": inv.status,
        "invited_by": inviter.display_name if inviter else "A MoneyKal user",
        "invited_email": inv.email,
        "invited_name": inv.person.display_name if inv.person else None,
        "group": {"id": group.id, "name": group.name, "emoji": group.emoji} if group else None,
        "already_accepted": inv.status == "accepted",
    }


def accept_invitation_row(db: Session, inv: SplitInvitation, user: User,
                          person: SplitPerson) -> None:
    """Attach an accepted invite to the account that claimed it.

    If the invited guest row is not the same row as the accepting user's
    identity — they signed up with a different address than they were invited
    at — the group membership is transferred rather than the two identities
    merged. Merging would mean rewriting every expense share, and a half-done
    merge is far worse than a clean transfer of the one thing that matters.
    """
    inv.status = "accepted"
    inv.accepted_by_user_id = user.id
    inv.accepted_at = datetime.utcnow()

    if inv.person_id != person.id and inv.group_id:
        old = db.query(SplitGroupMember).filter(
            SplitGroupMember.group_id == inv.group_id,
            SplitGroupMember.person_id == inv.person_id,
        ).first()
        already = db.query(SplitGroupMember).filter(
            SplitGroupMember.group_id == inv.group_id,
            SplitGroupMember.person_id == person.id,
        ).first()
        if old and not already:
            old.person_id = person.id
        elif old:
            old.is_active = False

    inviter = db.query(SplitPerson).filter(SplitPerson.id == inv.invited_by_person_id).first()
    group = db.query(SplitGroup).filter(SplitGroup.id == inv.group_id).first() if inv.group_id else None
    record_activity(
        db, kind="invite_accepted", actor=person, group_id=inv.group_id,
        summary=f"{person.display_name} joined" + (f" {group.name}" if group else " Money Splits"),
        audience=[person.id, inv.invited_by_person_id],
    )
    if inviter and inviter.user_id:
        notification_service.notify(
            db, inviter.user_id, kind="split_group_member_added",
            title=f"{person.display_name} joined MoneyKal",
            body=(f"They are now in {group.name}." if group else "You can now settle up in the app."),
            link_type="split_group" if group else "split_friend",
            link_id=group.id if group else person.id,
            meta={"person_id": person.id, "name": person.display_name},
        )
    db.flush()


def accept_invitation(db: Session, token: str, user: User) -> dict:
    inv = db.query(SplitInvitation).filter(SplitInvitation.token == token).first()
    if not inv:
        raise HTTPException(status_code=404, detail="This invitation link is not valid")
    if inv.status == "revoked":
        raise HTTPException(status_code=410, detail="This invitation has been revoked")

    person = get_person_for_user(db, user)
    if inv.status == "accepted" and inv.accepted_by_user_id == user.id:
        return {"status": "already_accepted", "group_id": inv.group_id}

    accept_invitation_row(db, inv, user, person)
    return {"status": "accepted", "group_id": inv.group_id}


# ---------------------------------------------------------------------------
# Expenses
# ---------------------------------------------------------------------------

def _authorized_person_ids(db: Session, me: SplitPerson, group: Optional[SplitGroup],
                           person_ids: Iterable[int]) -> List[int]:
    """Validate that every id the client sent is someone the caller may involve.

    This is the check that stops a crafted request from adding a stranger to an
    expense — or, worse, reading their name back out of the response. In a
    group, the allowed set is the membership; outside one it is the caller's
    friends plus the caller.
    """
    wanted = list(dict.fromkeys(int(p) for p in person_ids))
    if not wanted:
        raise HTTPException(status_code=400, detail="An expense needs at least one participant")

    if group:
        allowed = set(group_member_ids(db, group.id))
    else:
        allowed = {f.id for f in list_friends(db, me)}
        allowed.add(me.id)

    unknown = [p for p in wanted if p not in allowed]
    if unknown:
        raise HTTPException(
            status_code=403,
            detail="One or more participants are not part of this group",
        )
    return wanted


def compute_shares(total_minor: int, mode: str, participant_ids: Sequence[int],
                   values: Optional[Dict[int, str]] = None,
                   items: Optional[List[dict]] = None) -> Tuple[Dict[int, int], Dict[int, str]]:
    """Turn a split instruction into final per-person amounts.

    Returns (share_minor by person, weight-as-typed by person). The second
    value is stored only so the edit screen can reopen showing what the user
    entered; nothing computes from it.

    Every branch ends in an allocation that provably sums to `total_minor` —
    that is the contract the balance engine relies on, and it is asserted at
    the end regardless of which mode ran.
    """
    values = values or {}
    weights: Dict[int, str] = {}

    if mode == "equal":
        amounts = allocate_equal(total_minor, len(participant_ids))
        shares = dict(zip(participant_ids, amounts))

    elif mode == "exact":
        parts = [int(values.get(pid) or 0) for pid in participant_ids]
        validate_exact(total_minor, parts, "amounts")
        shares = dict(zip(participant_ids, parts))

    elif mode == "percent":
        percents = [values.get(pid, "0") for pid in participant_ids]
        amounts = allocate_by_percent(total_minor, percents)
        shares = dict(zip(participant_ids, amounts))
        weights = {pid: str(values.get(pid, "0")) for pid in participant_ids}

    elif mode == "shares":
        counts = [values.get(pid, "0") for pid in participant_ids]
        amounts = allocate_by_weights(total_minor, counts)
        shares = dict(zip(participant_ids, amounts))
        weights = {pid: str(values.get(pid, "0")) for pid in participant_ids}

    elif mode == "itemized":
        if not items:
            raise SplitMathError("An itemized expense needs at least one item")
        shares = {pid: 0 for pid in participant_ids}
        items_total = 0
        for item in items:
            amount = int(item["amount_minor"])
            members = [p for p in item.get("participant_person_ids") or [] if p in shares]
            if not members:
                raise SplitMathError(f"Item '{item.get('name')}' has no participants")
            portions = allocate_by_weights(amount, [1] * len(members))
            for pid, portion in zip(members, portions):
                shares[pid] += portion
            items_total += amount

        # Anything the items do not account for is tax, tip or a service charge.
        # It is spread across participants in proportion to what they already
        # owe, which is the only allocation that does not quietly overcharge the
        # person who ordered the cheap dish.
        remainder = total_minor - items_total
        if remainder < 0:
            raise SplitMathError(
                "The items add up to more than the expense total"
            )
        if remainder > 0:
            base = [shares[pid] for pid in participant_ids]
            extra = (allocate_by_weights(remainder, base) if any(base)
                     else allocate_equal(remainder, len(participant_ids)))
            for pid, add in zip(participant_ids, extra):
                shares[pid] += add
    else:
        raise SplitMathError(f"'{mode}' is not a supported split mode")

    total = sum(shares.values())
    if total != total_minor:
        # Defensive: every branch above is proven to close, so reaching here
        # means a bug in this function rather than bad input. Failing loudly is
        # correct — a silently unbalanced expense corrupts every balance that
        # reads it afterwards.
        raise SplitMathError(
            f"Internal split error: shares total {total} but the expense is {total_minor}"
        )
    return shares, weights


def _parse_payers(payers: List[dict], total_minor: int, currency: str,
                  allowed_ids: Sequence[int]) -> List[Tuple[int, int]]:
    if not payers:
        raise HTTPException(status_code=400, detail="Someone has to have paid")
    out = []
    for p in payers:
        pid = int(p["person_id"])
        if pid not in allowed_ids:
            raise HTTPException(status_code=403, detail="A payer is not part of this group")
        amount = to_minor(p["amount"], currency) if "amount" in p else int(p["amount_minor"])
        if amount <= 0:
            raise HTTPException(status_code=400, detail="A payer's amount must be greater than zero")
        out.append((pid, amount))
    paid = sum(a for _, a in out)
    if paid != total_minor:
        raise HTTPException(
            status_code=400,
            detail=(f"The payers total {format_minor(paid, currency)} but the expense is "
                    f"{format_minor(total_minor, currency)}"),
        )
    return out


def create_expense(db: Session, me: SplitPerson, payload: dict) -> SplitExpense:
    """Create one expense with its payers, shares and (optionally) items."""
    client_token = (payload.get("client_token") or "").strip() or None
    if client_token:
        existing = db.query(SplitExpense).filter(
            SplitExpense.client_token == client_token
        ).first()
        if existing:
            # Idempotency: a double-tapped Save or a retried request returns the
            # expense that was already created rather than booking it twice.
            return existing

    group = resolve_group(db, int(payload["group_id"]), me) if payload.get("group_id") else None
    currency = normalize_currency(payload.get("currency") or (group.currency if group else DEFAULT_CURRENCY))
    total_minor = to_minor(payload.get("amount"), currency) if payload.get("amount") is not None \
        else int(payload["total_minor"])
    if total_minor <= 0:
        raise HTTPException(status_code=400, detail="An expense must be greater than zero")

    description = (payload.get("description") or "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="An expense needs a description")

    mode = payload.get("split_mode") or "equal"
    if mode not in SPLIT_MODES:
        raise HTTPException(status_code=400, detail=f"'{mode}' is not a supported split mode")

    participant_ids = _authorized_person_ids(db, me, group, payload.get("participant_person_ids") or [])
    payers = _parse_payers(payload.get("payers") or [], total_minor, currency,
                           _authorized_person_ids(db, me, group,
                                                  [p["person_id"] for p in payload.get("payers") or []]))

    values = _decode_values(payload.get("split_values"), mode, currency)
    items = _decode_items(payload.get("items"), currency)

    try:
        shares, weights = compute_shares(total_minor, mode, participant_ids, values, items)
    except SplitMathError as e:
        raise HTTPException(status_code=400, detail=str(e))

    expense = SplitExpense(
        group_id=group.id if group else None,
        description=description,
        total_minor=total_minor,
        currency=currency,
        expense_date=_parse_date(payload.get("expense_date")),
        category=(payload.get("category") or None),
        notes=(payload.get("notes") or None),
        receipt_url=(payload.get("receipt_url") or None),
        split_mode=mode,
        created_by_person_id=me.id,
        client_token=client_token,
    )
    db.add(expense)
    db.flush()

    for pid, amount in payers:
        db.add(SplitExpensePayer(expense_id=expense.id, person_id=pid, amount_minor=amount))
    for pid in participant_ids:
        db.add(SplitExpenseShare(expense_id=expense.id, person_id=pid,
                                 share_minor=shares[pid], weight=weights.get(pid)))
    for idx, item in enumerate(items or []):
        db.add(SplitExpenseItem(
            expense_id=expense.id, name=item["name"], amount_minor=item["amount_minor"],
            participant_person_ids=item["participant_person_ids"], position=idx,
        ))
    db.flush()

    _announce_expense(db, expense, me, group, verb="added")
    return expense


def update_expense(db: Session, me: SplitPerson, expense: SplitExpense, payload: dict) -> SplitExpense:
    """Replace an expense's money in one shot.

    Payers, shares and items are deleted and rebuilt rather than diffed. An
    expense is a small, self-contained set of rows, and a full rebuild makes it
    impossible to leave a stale share behind when a participant is removed —
    which a diff-based update gets wrong exactly once and then corrupts a
    balance nobody can trace.
    """
    group = db.query(SplitGroup).filter(SplitGroup.id == expense.group_id).first() if expense.group_id else None
    currency = normalize_currency(payload.get("currency") or expense.currency)

    total_minor = (to_minor(payload["amount"], currency) if payload.get("amount") is not None
                   else int(payload.get("total_minor", expense.total_minor)))
    if total_minor <= 0:
        raise HTTPException(status_code=400, detail="An expense must be greater than zero")

    mode = payload.get("split_mode") or expense.split_mode
    if mode not in SPLIT_MODES:
        raise HTTPException(status_code=400, detail=f"'{mode}' is not a supported split mode")

    raw_participants = payload.get("participant_person_ids")
    participant_ids = _authorized_person_ids(
        db, me, group,
        raw_participants if raw_participants is not None else [s.person_id for s in expense.shares],
    )
    raw_payers = payload.get("payers")
    if raw_payers is None:
        raw_payers = [{"person_id": p.person_id, "amount_minor": p.amount_minor} for p in expense.payers]
        # Editing only the amount is the common case, and the old payer rows
        # still carry the old figure. With a single payer the intent is
        # unambiguous — one person paid, so they paid the new total — and
        # scaling it is what the user means. With several payers there is no
        # honest guess about who covered the difference, so we ask rather than
        # invent a split of the change.
        if total_minor != int(expense.total_minor):
            if len(raw_payers) == 1:
                raw_payers = [{"person_id": raw_payers[0]["person_id"], "amount_minor": total_minor}]
            else:
                raise HTTPException(
                    status_code=400,
                    detail="This expense has more than one payer, so changing the total "
                           "means saying how much each of them paid.",
                )
    payers = _parse_payers(raw_payers, total_minor, currency,
                           _authorized_person_ids(db, me, group, [p["person_id"] for p in raw_payers]))

    values = _decode_values(payload.get("split_values"), mode, currency)
    items = _decode_items(payload.get("items"), currency)

    try:
        shares, weights = compute_shares(total_minor, mode, participant_ids, values, items)
    except SplitMathError as e:
        raise HTTPException(status_code=400, detail=str(e))

    expense.description = (payload.get("description") or expense.description).strip()
    expense.total_minor = total_minor
    expense.currency = currency
    expense.split_mode = mode
    if payload.get("expense_date"):
        expense.expense_date = _parse_date(payload.get("expense_date"))
    if "category" in payload:
        expense.category = payload.get("category") or None
    if "notes" in payload:
        expense.notes = payload.get("notes") or None
    if "receipt_url" in payload:
        expense.receipt_url = payload.get("receipt_url") or None

    db.query(SplitExpensePayer).filter(SplitExpensePayer.expense_id == expense.id).delete()
    db.query(SplitExpenseShare).filter(SplitExpenseShare.expense_id == expense.id).delete()
    db.query(SplitExpenseItem).filter(SplitExpenseItem.expense_id == expense.id).delete()
    db.flush()

    for pid, amount in payers:
        db.add(SplitExpensePayer(expense_id=expense.id, person_id=pid, amount_minor=amount))
    for pid in participant_ids:
        db.add(SplitExpenseShare(expense_id=expense.id, person_id=pid,
                                 share_minor=shares[pid], weight=weights.get(pid)))
    for idx, item in enumerate(items or []):
        db.add(SplitExpenseItem(
            expense_id=expense.id, name=item["name"], amount_minor=item["amount_minor"],
            participant_person_ids=item["participant_person_ids"], position=idx,
        ))
    db.flush()

    _announce_expense(db, expense, me, group, verb="updated")
    return expense


def delete_expense(db: Session, me: SplitPerson, expense: SplitExpense) -> None:
    """Soft delete. The row stays so the activity feed can still refer to it,
    and so a deletion is auditable; the balance engine skips `is_deleted`, so
    the money effect is immediate."""
    expense.is_deleted = True
    expense.deleted_at = datetime.utcnow()
    db.flush()
    group = db.query(SplitGroup).filter(SplitGroup.id == expense.group_id).first() if expense.group_id else None
    _announce_expense(db, expense, me, group, verb="deleted")


def resolve_expense(db: Session, expense_id: int, me: SplitPerson,
                    for_write: bool = False) -> SplitExpense:
    """Fetch an expense the caller is entitled to.

    Read access requires membership of its group, or being a participant/payer
    on an ungrouped expense. Write access additionally requires being the
    creator or a member of the group — a stranger who was merely named on an
    expense must not be able to rewrite it.
    """
    expense = db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
        joinedload(SplitExpense.items),
    ).filter(SplitExpense.id == expense_id).first()
    if not expense or expense.is_deleted:
        raise HTTPException(status_code=404, detail="Expense not found")

    if expense.group_id:
        resolve_group(db, expense.group_id, me)
        return expense

    involved = {s.person_id for s in expense.shares} | {p.person_id for p in expense.payers}
    involved.add(expense.created_by_person_id)
    if me.id not in involved:
        raise HTTPException(status_code=404, detail="Expense not found")
    if for_write and me.id != expense.created_by_person_id and me.id not in involved:
        raise HTTPException(status_code=403, detail="You cannot edit this expense")
    return expense


def _decode_values(raw, mode: str, currency: str) -> Dict[int, str]:
    """Normalise the client's per-person split inputs.

    For 'exact' the values are money and are converted to minor units here, so
    `compute_shares` only ever sees integers; for percent/shares they stay as
    typed and are handed to the Decimal-based allocator untouched.
    """
    if not raw:
        return {}
    out: Dict[int, str] = {}
    for key, value in raw.items():
        pid = int(key)
        if mode == "exact":
            out[pid] = to_minor(value, currency)
        else:
            out[pid] = str(value)
    return out


def _decode_items(raw, currency: str) -> Optional[List[dict]]:
    if not raw:
        return None
    items = []
    for item in raw:
        name = (item.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="Every item needs a name")
        amount = (to_minor(item["amount"], currency) if item.get("amount") is not None
                  else int(item.get("amount_minor", 0)))
        if amount <= 0:
            raise HTTPException(status_code=400, detail=f"Item '{name}' must be greater than zero")
        items.append({
            "name": name,
            "amount_minor": amount,
            "participant_person_ids": [int(p) for p in (item.get("participant_person_ids") or [])],
        })
    return items


def _parse_date(value):
    if not value:
        return datetime.utcnow().date()
    if hasattr(value, "year"):
        return value
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        raise HTTPException(status_code=400, detail="Date must be in YYYY-MM-DD format")


# ---------------------------------------------------------------------------
# Settlements
# ---------------------------------------------------------------------------

def create_settlement(db: Session, me: SplitPerson, payload: dict) -> SplitSettlement:
    client_token = (payload.get("client_token") or "").strip() or None
    if client_token:
        existing = db.query(SplitSettlement).filter(
            SplitSettlement.client_token == client_token
        ).first()
        if existing:
            return existing

    group = resolve_group(db, int(payload["group_id"]), me) if payload.get("group_id") else None
    currency = normalize_currency(payload.get("currency") or (group.currency if group else DEFAULT_CURRENCY))

    from_id = int(payload["from_person_id"])
    to_id = int(payload["to_person_id"])
    if from_id == to_id:
        raise HTTPException(status_code=400, detail="A settlement needs two different people")

    allowed = _authorized_person_ids(db, me, group, [from_id, to_id])
    if me.id not in allowed:
        # Recording a payment between two other people is legitimate inside a
        # group (someone reconciling on the group's behalf) but never outside
        # one, where there is no shared context to justify it.
        if not group:
            raise HTTPException(status_code=403, detail="You can only record settlements you are part of")

    amount = (to_minor(payload["amount"], currency) if payload.get("amount") is not None
              else int(payload["amount_minor"]))
    if amount <= 0:
        raise HTTPException(status_code=400, detail="A settlement must be greater than zero")

    # Partial settlements are allowed by design — "here's 500 of the 1,200 I
    # owe you" is a normal thing to do — so the amount is not required to match
    # the outstanding balance. Overpaying is refused, though, because it flips
    # the debt around and is almost always a typo.
    ledger = group_ledger(db, group) if group else overall_ledger(db, me)
    outstanding = ledger.between(to_id, from_id)
    if outstanding > 0 and amount > outstanding:
        raise HTTPException(
            status_code=400,
            detail=(f"That is more than the outstanding balance of "
                    f"{format_minor(outstanding, currency)}"),
        )

    settlement = SplitSettlement(
        group_id=group.id if group else None,
        from_person_id=from_id, to_person_id=to_id,
        amount_minor=amount, currency=currency,
        method=(payload.get("method") or "cash"),
        note=(payload.get("note") or None),
        settled_on=_parse_date(payload.get("settled_on")),
        recorded_by_person_id=me.id,
        client_token=client_token,
    )
    db.add(settlement)
    db.flush()

    payer = db.query(SplitPerson).filter(SplitPerson.id == from_id).first()
    payee = db.query(SplitPerson).filter(SplitPerson.id == to_id).first()
    pretty = format_minor(amount, currency)
    audience = group_member_ids(db, group.id) if group else [from_id, to_id]

    record_activity(
        db, kind="settlement_added", actor=me, group_id=group.id if group else None,
        settlement_id=settlement.id,
        summary=f"{payer.display_name} paid {payee.display_name} {pretty}"
                + (f" in {group.name}" if group else ""),
        amount_minor=amount, currency=currency, audience=audience,
        # Display metadata only, so the feed can phrase a settlement from the
        # reader's side ("Harshit paid you") instead of naming both parties.
        meta={
            "from_person_id": from_id,
            "to_person_id": to_id,
            "from_name": payer.display_name if payer else None,
            "to_name": payee.display_name if payee else None,
            "group_name": group.name if group else None,
        },
    )
    if payee and payee.user_id and payee.id != me.id:
        notification_service.notify(
            db, payee.user_id, kind="split_settlement_received",
            title=f"{payer.display_name} settled up with you",
            body=f"{pretty} recorded" + (f" in {group.name}" if group else ""),
            link_type="split_settlement", link_id=settlement.id,
            meta={"amount_minor": amount, "currency": currency,
                  "group_id": group.id if group else None, "from": payer.display_name},
            whatsapp_text=f"{payer.display_name} paid you {pretty} on Money Splits.",
        )
    if payer and payer.user_id and payer.id != me.id:
        notification_service.notify(
            db, payer.user_id, kind="split_settlement_recorded",
            title=f"{me.display_name} recorded your payment",
            body=f"{pretty} to {payee.display_name}",
            link_type="split_settlement", link_id=settlement.id,
            meta={"amount_minor": amount, "currency": currency},
        )
    return settlement


def resolve_settlement(db: Session, settlement_id: int, me: SplitPerson) -> SplitSettlement:
    st = db.query(SplitSettlement).filter(SplitSettlement.id == settlement_id).first()
    if not st or st.is_deleted:
        raise HTTPException(status_code=404, detail="Settlement not found")
    if st.group_id:
        resolve_group(db, st.group_id, me)
    elif me.id not in (st.from_person_id, st.to_person_id, st.recorded_by_person_id):
        raise HTTPException(status_code=404, detail="Settlement not found")
    return st


def delete_settlement(db: Session, me: SplitPerson, st: SplitSettlement) -> None:
    st.is_deleted = True
    db.flush()
    group = db.query(SplitGroup).filter(SplitGroup.id == st.group_id).first() if st.group_id else None
    record_activity(
        db, kind="settlement_deleted", actor=me, group_id=st.group_id,
        settlement_id=st.id,
        summary=f"{me.display_name} deleted a settlement of {format_minor(st.amount_minor, st.currency)}",
        amount_minor=st.amount_minor, currency=st.currency,
        audience=(group_member_ids(db, group.id) if group else [st.from_person_id, st.to_person_id]),
    )


# ---------------------------------------------------------------------------
# Ledgers
# ---------------------------------------------------------------------------

def group_ledger(db: Session, group: SplitGroup):
    expenses = db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
    ).filter(
        SplitExpense.group_id == group.id,
        SplitExpense.is_deleted == False,  # noqa: E712
    ).all()
    settlements = db.query(SplitSettlement).filter(
        SplitSettlement.group_id == group.id,
        SplitSettlement.is_deleted == False,  # noqa: E712
    ).all()
    return build_ledger(expenses, settlements, group_member_ids(db, group.id))


def overall_ledger(db: Session, me: SplitPerson):
    """Every expense and settlement this person is involved in, anywhere.

    Scoped by participation rather than by group so that one-to-one expenses
    with no group are included — those are a large share of real usage and
    would otherwise be missing from the friend balances entirely.
    """
    expense_ids = {e for (e,) in db.query(SplitExpenseShare.expense_id).filter(
        SplitExpenseShare.person_id == me.id).all()}
    expense_ids |= {e for (e,) in db.query(SplitExpensePayer.expense_id).filter(
        SplitExpensePayer.person_id == me.id).all()}

    group_ids = [m.group_id for m in db.query(SplitGroupMember).filter(
        SplitGroupMember.person_id == me.id,
        SplitGroupMember.is_active == True,  # noqa: E712
    ).all()]

    q = db.query(SplitExpense).options(
        joinedload(SplitExpense.shares), joinedload(SplitExpense.payers),
    ).filter(SplitExpense.is_deleted == False)  # noqa: E712
    filters = []
    if expense_ids:
        filters.append(SplitExpense.id.in_(expense_ids))
    if group_ids:
        filters.append(SplitExpense.group_id.in_(group_ids))
    expenses = q.filter(or_(*filters)).all() if filters else []

    s_filters = [SplitSettlement.from_person_id == me.id, SplitSettlement.to_person_id == me.id]
    if group_ids:
        s_filters.append(SplitSettlement.group_id.in_(group_ids))
    settlements = db.query(SplitSettlement).filter(
        SplitSettlement.is_deleted == False,  # noqa: E712
        or_(*s_filters),
    ).all()

    return build_ledger(expenses, settlements, [me.id])


# ---------------------------------------------------------------------------
# Activity
# ---------------------------------------------------------------------------

def record_activity(db: Session, kind: str, actor: SplitPerson, summary: str,
                    audience: Sequence[int], group_id: Optional[int] = None,
                    expense_id: Optional[int] = None, settlement_id: Optional[int] = None,
                    amount_minor: Optional[int] = None, currency: str = DEFAULT_CURRENCY,
                    meta: Optional[dict] = None) -> SplitActivity:
    activity = SplitActivity(
        kind=kind,
        actor_person_id=actor.id,
        actor_name=actor.display_name,
        group_id=group_id, expense_id=expense_id, settlement_id=settlement_id,
        summary=summary, amount_minor=amount_minor, currency=currency,
        meta=meta or {},
        audience_person_ids=sorted(set(int(a) for a in audience)),
    )
    db.add(activity)
    db.flush()
    return activity


def list_activity(db: Session, me: SplitPerson, group_id: Optional[int] = None,
                  limit: int = 50, offset: int = 0) -> List[SplitActivity]:
    """The Activity feed.

    Filtered in Python on `audience_person_ids` because it is a JSON column and
    SQLite cannot index into it portably. The row count per user is small
    (hundreds, not millions) and the query is already bounded by group and by
    ordering, so this is the right trade against adding a join table purely to
    make a feed query pretty.
    """
    q = db.query(SplitActivity)
    if group_id is not None:
        q = q.filter(SplitActivity.group_id == group_id)
    rows = q.order_by(SplitActivity.created_at.desc(), SplitActivity.id.desc()) \
            .limit(1000).all()
    mine = [r for r in rows if me.id in (r.audience_person_ids or [])]
    return mine[offset:offset + limit]


def _announce_expense(db: Session, expense: SplitExpense, actor: SplitPerson,
                      group: Optional[SplitGroup], verb: str) -> None:
    """One activity row plus a personalised notification per participant.

    The notification says what it means *for the recipient* — "you owe 500",
    "you are owed 2,000" — rather than restating the expense, because that is
    the only part a person actually acts on.
    """
    participants = {s.person_id: int(s.share_minor) for s in expense.shares}
    payers = {p.person_id: int(p.amount_minor) for p in expense.payers}
    audience = set(participants) | set(payers) | {actor.id}
    if group:
        audience.update(group_member_ids(db, group.id))

    pretty = format_minor(expense.total_minor, expense.currency)
    where = f" in {group.name}" if group else ""
    # net_by_person lets the activity feed tell each reader what the entry meant
    # for *them* — "you get back 612.50" rather than a bare description — and is
    # what serialize_activity keys its green/coral tone off. Keyed by string
    # because the column is JSON and a JSON object cannot have integer keys.
    # Purely descriptive: no balance is ever read from here, only displayed.
    net_by_person = {
        str(pid): payers.get(pid, 0) - participants.get(pid, 0)
        for pid in (set(participants) | set(payers))
    }
    record_activity(
        db, kind=f"expense_{verb}", actor=actor, group_id=expense.group_id,
        expense_id=expense.id,
        summary=f"{actor.display_name} {verb} {expense.description}{where}",
        amount_minor=expense.total_minor, currency=expense.currency,
        audience=sorted(audience),
        meta={
            "description": expense.description,
            "total": pretty,
            "category": expense.category,
            "group_name": group.name if group else None,
            "net_by_person": net_by_person,
        },
    )

    if verb == "deleted":
        kind = "split_expense_deleted"
    elif verb == "updated":
        kind = "split_expense_updated"
    else:
        kind = "split_expense_added"

    people = {p.id: p for p in db.query(SplitPerson).filter(
        SplitPerson.id.in_(list(audience))).all()} if audience else {}

    for pid in audience:
        person = people.get(pid)
        if not person or not person.user_id or pid == actor.id:
            continue
        share = participants.get(pid, 0)
        paid = payers.get(pid, 0)
        net = paid - share
        if verb == "deleted":
            body = f"{pretty} · {expense.description}"
        elif net > 0:
            body = f"You are owed {format_minor(net, expense.currency)}"
        elif net < 0:
            body = f"You owe {format_minor(-net, expense.currency)}"
        else:
            body = f"{pretty} · you are settled on this one"

        notification_service.notify(
            db, person.user_id, kind=kind,
            title=f"{actor.display_name} {verb} {expense.description}{where}",
            body=body,
            link_type="split_expense", link_id=expense.id,
            meta={
                "expense_id": expense.id, "group_id": expense.group_id,
                "amount_minor": expense.total_minor, "currency": expense.currency,
                "your_net_minor": net,
            },
            whatsapp_text=f"{actor.display_name} {verb} '{expense.description}' ({pretty}). {body}.",
        )
