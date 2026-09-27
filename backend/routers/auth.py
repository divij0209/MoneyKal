import re

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, field_validator
from sqlalchemy import func
from sqlalchemy.orm import Session
import bcrypt
import hashlib
from datetime import datetime, timedelta
from typing import Optional

from backend.database import get_db
from backend.models.domain import User, Profile
from backend.core.auth import (
    create_access_token, create_refresh_token, decode_refresh_token,
    create_device_token, decode_device_token, device_token_expiry,
    DEVICE_TOKEN_EXPIRE_MINUTES,
    ACCESS_TOKEN_EXPIRE_MINUTES, get_current_user,
)
from backend.services import split_service
from backend.core.ratelimit import (
    SlidingWindowLimiter, client_ip, enforce, login_ip_limiter, login_limiter,
    register_limiter,
)

router = APIRouter(prefix="/auth", tags=["Auth"])

def normalize_username(value: str) -> str:
    """Usernames are email addresses, so they are matched without regard to
    case or surrounding whitespace. Kept in one place so login and registration
    cannot drift apart on what counts as the same account."""
    return (value or "").strip().lower()


# --- Input validation ------------------------------------------------------
# Registration previously accepted anything at all: an empty username, a
# 5,000-character one, "<script>alert(1)</script>", and a password of "1" all
# returned 200 with a seven-day token. None of that is exotic input — it is the
# first thing anyone evaluating the product types.
#
# Deliberately split by route. REGISTER enforces the rules; LOGIN does not,
# beyond a length cap. Applying a password floor at login would lock out every
# account created before this existed, which is a self-inflicted outage rather
# than a security improvement.

MIN_PASSWORD_LENGTH = 8
# bcrypt only reads the first 72 bytes, so anything beyond that is not more
# security, just more bytes to hash. The cap also removes a trivially cheap way
# to make the server do expensive work.
MAX_PASSWORD_LENGTH = 128
MAX_USERNAME_LENGTH = 254  # RFC 5321 maximum path length for an address.

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$")


def validate_username(value: str) -> str:
    """Normalize and check the shape of a username at registration."""
    username = normalize_username(value)
    if not username:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Enter your email address.",
        )
    if len(username) > MAX_USERNAME_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="That email address is too long.",
        )
    if not _EMAIL_RE.match(username):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Enter a valid email address.",
        )
    return username


def validate_new_password(password: str) -> str:
    """The floor for a password on a new account.

    Length only, and a check against a small list of the passwords that get
    tried first. A complexity rule (one upper, one digit, one symbol) is
    deliberately not imposed: it measurably pushes people towards `Password1!`
    without making a password harder to guess.
    """
    password = password or ""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Choose a password of at least {MIN_PASSWORD_LENGTH} characters.",
        )
    if len(password) > MAX_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Passwords must be {MAX_PASSWORD_LENGTH} characters or fewer.",
        )
    if password.strip().lower() in _COMMON_PASSWORDS:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="That password is too common. Choose something harder to guess.",
        )
    return password


_COMMON_PASSWORDS = {
    "password", "password1", "password123", "12345678", "123456789",
    "1234567890", "qwertyui", "qwerty123", "iloveyou", "welcome1",
    "abc12345", "letmein1", "admin123", "moneykal", "changeme",
}



# --- Terms & Conditions acceptance ---------------------------------------
# The document itself lives with the clients that display it:
#   twin-app/js/legal-terms.js
#   mobile/src/features/legal/termsContent.ts
# Both send the version they showed, which is what gets stored. This constant
# is the fallback used when a client accepts without naming a version, and the
# value to bump here when a new version ships.
CURRENT_TERMS_VERSION = "1.0"


class TermsAcceptanceMixin(BaseModel):
    """The acceptance fields both auth requests may carry.

    Every field is optional so that a client which does not send them — an
    older mobile build, an integration test — registers and logs in exactly as
    it did before. Acceptance is *gated in the UI*; what happens here is the
    record of it, not the gate.
    """
    terms_accepted: Optional[bool] = None
    terms_version: Optional[str] = None
    terms_accepted_at: Optional[datetime] = None


def record_terms_acceptance(user: User, req: "TermsAcceptanceMixin") -> None:
    """Store an acceptance against the user row, if the client sent one.

    Written on register *and* on login, so an account created before this
    existed picks up a record the next time its owner signs in and ticks the
    box. An acceptance is never cleared by a request that omits the fields.
    """
    if not req.terms_accepted:
        return

    user.terms_accepted = True
    user.terms_version = req.terms_version or CURRENT_TERMS_VERSION
    # The client's timestamp is a convenience, not evidence — a device clock
    # can be anything. The server's own time is what gets stored.
    user.terms_accepted_at = datetime.utcnow()


def terms_state(user: User) -> dict:
    """The acceptance fields, shaped for an auth response. Additive: existing
    clients ignore them."""
    return {
        "terms_accepted": bool(getattr(user, "terms_accepted", False)),
        "terms_version": getattr(user, "terms_version", None),
        "terms_accepted_at": (
            user.terms_accepted_at.isoformat()
            if getattr(user, "terms_accepted_at", None)
            else None
        ),
        "current_terms_version": CURRENT_TERMS_VERSION,
    }


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    """Verifies a bcrypt hash. Returns False (rather than raising) on a
    malformed/legacy hash so callers can fall back cleanly."""
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


class LoginRequest(TermsAcceptanceMixin):
    username: str
    password: str
    # "Keep me logged in on this device". Optional and default False, so a
    # client that has never heard of it logs in exactly as it always did.
    remember_device: Optional[bool] = False


@router.post("/login")
def login(req: LoginRequest, request: Request = None, db: Session = Depends(get_db)):
    lookup = normalize_username(req.username)

    # Throttled on BOTH the account and the caller's address. Keying on the
    # account alone would let one attacker lock a known user out on purpose;
    # keying on the address alone is defeated by rotating it. Checked before
    # the password is verified so a locked-out caller costs no bcrypt work.
    ip = client_ip(request)
    enforce(login_limiter, [f"user:{lookup}"],
            "Too many sign-in attempts for this account. Wait a few minutes and try again.")
    enforce(login_ip_limiter, [f"ip:{ip}"],
            "Too many sign-in attempts from this connection. Wait a few minutes and try again.")

    # An over-long password is rejected without hashing it. bcrypt reads only
    # the first 72 bytes anyway, so this loses nothing and removes a cheap way
    # to make the server burn CPU.
    if len(req.password or "") > MAX_PASSWORD_LENGTH:
        login_limiter.record(f"user:{lookup}")
        login_ip_limiter.record(f"ip:{ip}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    user = db.query(User).filter(func.lower(User.username) == lookup).first()

    def _reject():
        # Every failed attempt counts, whether the account exists or not — not
        # counting misses on unknown accounts would leave username enumeration
        # unthrottled.
        login_limiter.record(f"user:{lookup}")
        login_ip_limiter.record(f"ip:{ip}")
        return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")

    if not user:
        raise _reject()

    if not verify_password(req.password, user.hashed_password):
        # Handle transition from an old sha256 password, same behavior as before
        if user.hashed_password == hashlib.sha256(req.password.encode()).hexdigest():
            user.hashed_password = hash_password(req.password)
            db.commit()
        else:
            raise _reject()

    # Credentials were correct, so the failure history is no longer meaningful.
    login_limiter.reset(f"user:{lookup}")
    login_ip_limiter.reset(f"ip:{ip}")

    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": str(user.id)}, expires_delta=access_token_expires
    )

    profile = db.query(Profile).filter(Profile.user_id == user.id).first()

    if profile and profile.key == "enterprise":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Enterprise accounts are no longer supported")

    # Recorded after the credentials have been checked, so a failed sign-in
    # never writes an acceptance for an account the caller does not own.
    record_terms_acceptance(user, req)
    db.commit()

    # Additive. Present only when the user ticked "keep me logged in", and
    # only ever useful together with the correct PIN — see create_device_token.
    device_token = create_device_token(user.id) if req.remember_device else None

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "device_token": device_token,
        "device_expires_in": DEVICE_TOKEN_EXPIRE_MINUTES * 60 if device_token else None,
        "pin_set": bool(user.pin_hash),
        # Additive: the web client reads only the four fields below and ignores
        # this one. The mobile client stores it in the OS keychain and trades it
        # at /auth/refresh, so a phone isn't signed out every seven days.
        "refresh_token": create_refresh_token(user.id),
        "user_id": user.id,
        "username": user.username,
        "profile_key": profile.key if profile else None,
        # Additive: lets a client tell whether the version on file is still
        # current. Existing clients ignore it.
        **terms_state(user),
    }


class RegisterRequest(TermsAcceptanceMixin):
    username: str
    password: str


@router.post("/register")
def register(req: RegisterRequest, request: Request = None, db: Session = Depends(get_db)):
    ip = client_ip(request)
    enforce(
        register_limiter,
        [f"ip:{ip}"],
        "Too many accounts created from this connection. Try again later.",
    )

    username = validate_username(req.username)
    validate_new_password(req.password)

    user = db.query(User).filter(func.lower(User.username) == username).first()

    if user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="User already exists")

    register_limiter.record(f"ip:{ip}")
    hashed_password = hash_password(req.password)
    user = User(username=username, hashed_password=hashed_password)
    # Written in the same INSERT as the account it belongs to, so an account
    # can never exist without the acceptance that was given alongside it.
    record_terms_acceptance(user, req)
    db.add(user)
    db.commit()
    db.refresh(user)

    # Split guest claim. If anyone invited this email address before they had
    # an account, the guest participant carrying their expenses and balances is
    # linked to this new user here, so their history is intact the first time
    # they open Split. Failure is swallowed inside the service — registering
    # must never fail because a Split table was unavailable.
    split_claim = split_service.claim_persons_for_new_user(db, user)
    db.commit()

    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": str(user.id)}, expires_delta=access_token_expires
    )

    profile = db.query(Profile).filter(Profile.user_id == user.id).first()

    if profile and profile.key == "enterprise":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Enterprise accounts are no longer supported")

    return {
        "access_token": access_token,
        "token_type": "bearer",
        # Additive: the web client reads only the four fields below and ignores
        # this one. The mobile client stores it in the OS keychain and trades it
        # at /auth/refresh, so a phone isn't signed out every seven days.
        "refresh_token": create_refresh_token(user.id),
        "user_id": user.id,
        "username": user.username,
        "profile_key": profile.key if profile else None,
        # Additive: lets the client say "you've been added to 2 groups" after
        # signing up through an invite. Existing clients ignore it.
        "split": split_claim,
        **terms_state(user),
    }

class RefreshRequest(BaseModel):
    refresh_token: str


# ===========================================================================
# MoneyKal PIN — a device unlock layer, not a second password
#
# WHAT IT IS
#   A PIN can do exactly one thing: turn a valid, unexpired DEVICE token into
#   an access token. It cannot authenticate anything by itself, it cannot be
#   used without the device token, and the device token cannot be used without
#   it. Neither half is a credential alone.
#
# WHAT IT IS NOT
#   It does not replace, shorten or weaken the password path. Every route below
#   is additive; /auth/login and /auth/refresh behave exactly as they did.
#
# WHY VERIFICATION IS SERVER-SIDE
#   A four-digit PIN is ten thousand candidates. Verified in the browser, the
#   hash is handed to the attacker and the attempt counter is theirs to edit.
#   The hash never leaves the server and every attempt is counted here.
# ===========================================================================

MIN_PIN_LENGTH = 4
MAX_PIN_LENGTH = 6

# Five wrong PINs per account in fifteen minutes. Tighter than the password
# limiter's allowance relative to the keyspace, because 10,000 candidates is
# small enough that the limiter IS the security boundary, not a nicety.
pin_limiter = SlidingWindowLimiter(max_hits=5, window_seconds=15 * 60)

# PINs that are the first thing anyone tries. Rejected at set time only; this
# is not a check on an existing PIN.
_WEAK_PINS = {
    "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888",
    "9999", "1234", "4321", "0123", "1212", "1122", "2580", "1004",
    "000000", "111111", "123456", "654321", "121212", "112233", "123123",
}


def _validate_pin(pin: str) -> str:
    """Shape and strength. Raises 422 with a message meant for the user."""
    pin = (pin or "").strip()
    if not pin.isdigit():
        raise HTTPException(status_code=422, detail="Your PIN must be digits only.")
    if len(pin) not in (MIN_PIN_LENGTH, MAX_PIN_LENGTH):
        raise HTTPException(
            status_code=422,
            detail=f"Choose a {MIN_PIN_LENGTH}- or {MAX_PIN_LENGTH}-digit PIN.",
        )
    if pin in _WEAK_PINS:
        raise HTTPException(
            status_code=422,
            detail="That PIN is too easy to guess. Choose a less obvious one.",
        )
    if len(set(pin)) == 1:
        raise HTTPException(
            status_code=422,
            detail="That PIN is too easy to guess. Choose a less obvious one.",
        )
    return pin


class PinSetRequest(BaseModel):
    pin: str
    # Re-authentication. Setting or replacing a PIN is a credential change, so
    # it costs the account password even though the caller is already signed in
    # — otherwise a borrowed access token could quietly install its own PIN.
    password: str


class PinUnlockRequest(BaseModel):
    device_token: str
    pin: str


@router.get("/pin/status")
def pin_status(current_user: User = Depends(get_current_user)):
    """Whether this account has a PIN. Never returns the hash or the PIN."""
    return {
        "pin_set": bool(current_user.pin_hash),
        "pin_set_at": current_user.pin_set_at.isoformat() if current_user.pin_set_at else None,
        "device_days": DEVICE_TOKEN_EXPIRE_MINUTES // (60 * 24),
    }


@router.post("/pin/set")
def set_pin(
    req: PinSetRequest,
    request: Request = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Create or replace this account's PIN. Also the "change PIN" route —
    there is one PIN per account, so setting a new one replaces the old."""
    ip = client_ip(request)
    # The password check here is a guess opportunity, so it is throttled with
    # the same counters the login route uses.
    lookup = normalize_username(current_user.username)
    enforce(login_limiter, [f"user:{lookup}"],
            "Too many attempts for this account. Wait a few minutes and try again.")
    enforce(login_ip_limiter, [f"ip:{ip}"],
            "Too many attempts from this connection. Wait a few minutes and try again.")

    if not verify_password(req.password, current_user.hashed_password):
        login_limiter.record(f"user:{lookup}")
        login_ip_limiter.record(f"ip:{ip}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="That password is not correct.")

    pin = _validate_pin(req.pin)
    current_user.pin_hash = hash_password(pin)      # bcrypt, as for the password
    current_user.pin_set_at = datetime.utcnow()
    db.commit()

    # A fresh PIN clears the lockout: the person proved who they are.
    pin_limiter.reset(f"pin:{current_user.id}")
    login_limiter.reset(f"user:{lookup}")
    return {"pin_set": True, "pin_set_at": current_user.pin_set_at.isoformat()}


@router.delete("/pin")
def clear_pin(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Turn the PIN off. Idempotent. Any device token already out there stops
    being useful immediately, because unlock refuses an account with no PIN."""
    current_user.pin_hash = None
    current_user.pin_set_at = None
    db.commit()
    pin_limiter.reset(f"pin:{current_user.id}")
    return {"pin_set": False}


@router.post("/pin/unlock")
def unlock_with_pin(req: PinUnlockRequest, request: Request = None,
                    db: Session = Depends(get_db)):
    """Exchange (device token + PIN) for an access token.

    Unauthenticated by design — the device token is what stands in for the
    session, and it is verified here rather than by get_current_user, which
    rejects it precisely so it can never be used as a credential elsewhere.

    The device token is NOT reissued. Its expiry is absolute from the password
    login, so unlocking cannot roll the three-day window forward.
    """
    user_id = decode_device_token(req.device_token)          # 401 if expired/wrong kind
    ip = client_ip(request)

    # Keyed on the account, and on the address as a backstop. Checked before
    # the hash comparison so a locked-out caller costs no bcrypt work.
    enforce(pin_limiter, [f"pin:{user_id}"],
            "Too many incorrect PINs. Wait a few minutes, or sign in with your password.")
    enforce(login_ip_limiter, [f"ip:{ip}"],
            "Too many attempts from this connection. Wait a few minutes and try again.")

    # Shape is checked before anything expensive happens. _validate_pin is NOT
    # reused here: it also rejects weak PINs, and an account whose PIN was set
    # before a value joined _WEAK_PINS must still be able to unlock with it.
    # This is only a bound on what reaches bcrypt, and it is deliberately
    # counted as a failed attempt so a malformed PIN cannot be used to probe
    # without spending an allowance.
    candidate = (req.pin or "").strip()
    if not candidate.isdigit() or not (MIN_PIN_LENGTH <= len(candidate) <= MAX_PIN_LENGTH):
        pin_limiter.record(f"pin:{user_id}")
        login_ip_limiter.record(f"ip:{ip}")
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="That PIN is not correct.")

    user = db.query(User).filter(User.id == user_id).first()
    if not user or not user.pin_hash:
        # No account, or the PIN was turned off after this device was
        # remembered. Either way the device has to use the password.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="This device needs to sign in with a password again.")

    if not verify_password(candidate, user.pin_hash):
        pin_limiter.record(f"pin:{user_id}")
        login_ip_limiter.record(f"ip:{ip}")
        allowed, _ = pin_limiter.check(f"pin:{user_id}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=("That PIN is not correct."
                    if allowed else
                    "Too many incorrect PINs. Sign in with your password instead."),
        )

    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    if profile and profile.key == "enterprise":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN,
                            detail="Enterprise accounts are no longer supported")

    pin_limiter.reset(f"pin:{user_id}")

    # Deliberately shorter than a password login's seven days. An unlocked
    # session lives in the browser until the next reload, when the PIN is asked
    # for again, so it has no reason to outlive the day.
    access_token = create_access_token(
        data={"sub": str(user.id)}, expires_delta=timedelta(hours=12)
    )
    expires_at = device_token_expiry(req.device_token)
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user_id": user.id,
        "username": user.username,
        "profile_key": profile.key if profile else "",
        # So the client can say "you'll need your password in N days" rather
        # than discovering it at the worst moment.
        "device_expires_at": expires_at.isoformat() if expires_at else None,
        **terms_state(user),
    }


@router.post("/refresh")
def refresh(req: RefreshRequest, db: Session = Depends(get_db)):
    """Trade a refresh token for a fresh access token.

    Purely additive — nothing calls this unless it chooses to, and the web
    login flow is untouched.

    A new refresh token is issued alongside, extending the window so an active
    phone stays signed in. This is a sliding window rather than true rotation:
    the presented token is not revoked and stays valid until its own expiry,
    because stateless JWTs have nothing to revoke against. See the note on
    create_refresh_token() for what making them revocable would take.
    """
    user_id = decode_refresh_token(req.refresh_token)

    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")

    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    if profile and profile.key == "enterprise":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Enterprise accounts are no longer supported")

    access_token = create_access_token(
        data={"sub": str(user.id)},
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )

    return {
        "access_token": access_token,
        "token_type": "bearer",
        "refresh_token": create_refresh_token(user.id),
        "user_id": user.id,
        "username": user.username,
        "profile_key": profile.key if profile else None,
        # Additive, same as login: a refreshing client can see whether the
        # version on file is still the current one.
        **terms_state(user),
    }
