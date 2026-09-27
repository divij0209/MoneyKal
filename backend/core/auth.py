import os
import uuid
from datetime import datetime, timedelta
from typing import Optional
from jose import JWTError, jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session
from backend.database import get_db
from backend.models.domain import User

_PLACEHOLDER_KEYS = {
    "supersecretkey_change_me_in_production",   # the old default in this file
    "supersecretkey_change_in_production",      # the one in backend/.env.example
}


def _load_signing_key() -> str:
    """The key every token in this app is signed with.

    Read from JWT_SECRET — the name backend/.env.example, the README and
    SUPABASE.md have always documented. SECRET_KEY is still accepted, because
    that is the name this module used to read.

    Those two names never matched, and nothing ever set SECRET_KEY, so the
    effective signing key was the literal default that used to sit on this
    line: a fixed string in the repository, signing access tokens, refresh
    tokens, Gmail OAuth state and Vapi voice tickets alike. Anyone who could
    read the repo could mint a valid token for any account.

    There is deliberately no default now. A signing key that silently falls
    back to a constant looks, at runtime, exactly like one that is configured
    properly — which is precisely how this survived unnoticed. Failing at
    import is noisy and impossible to ship past.
    """
    key = (os.getenv("JWT_SECRET") or os.getenv("SECRET_KEY") or "").strip()

    if not key:
        raise RuntimeError(
            "JWT_SECRET is not set.\n\n"
            "Every token this app issues is signed with it, and it must be the "
            "SAME value for every developer sharing a database -- otherwise one "
            "backend's tokens are rejected by another's.\n\n"
            "Generate one with:\n"
            "    python -c \"import secrets; print(secrets.token_urlsafe(64))\"\n\n"
            "Put it in backend/.env as JWT_SECRET=... and share it with the team "
            "through the password manager. See SUPABASE.md.\n"
        )

    if key in _PLACEHOLDER_KEYS:
        raise RuntimeError(
            "JWT_SECRET is still a placeholder value shipped in this repository, "
            "so it is public and tokens signed with it can be forged.\n\n"
            "Generate a real one with:\n"
            "    python -c \"import secrets; print(secrets.token_urlsafe(64))\"\n"
        )

    return key


SECRET_KEY = _load_signing_key()
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7 # 7 days

# --- Additive token kinds -------------------------------------------------
# The access token above is unchanged: same lifetime, same claims, so every
# token already issued to a browser keeps working exactly as it did. The three
# kinds below were added for the mobile client and are distinguished by a
# "typ" claim. Access tokens carry no "typ" (they predate this), so the guard
# in get_current_user is written as "reject anything that IS one of the new
# kinds" rather than "require typ == access" — that keeps old tokens valid.
REFRESH_TOKEN_EXPIRE_MINUTES = 60 * 24 * 60   # 60 days
HANDOFF_TICKET_EXPIRE_SECONDS = 120           # single browser hop, nothing more
OAUTH_STATE_EXPIRE_SECONDS = 60 * 15          # a consent screen the user reads

# The MoneyKal PIN's device token. Three days, and deliberately NOT renewed on
# unlock: the point of the cap is that a remembered device re-authenticates with
# the account password every three days, so silently extending it on every
# unlock would make the cap meaningless.
DEVICE_TOKEN_EXPIRE_MINUTES = 60 * 24 * 3     # 3 days, hard

TYP_REFRESH = "refresh"
TYP_HANDOFF = "handoff"
TYP_OAUTH_STATE = "oauth_state"
TYP_DEVICE = "device"

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

def create_refresh_token(user_id: int) -> str:
    """A long-lived token whose only power is to mint a new access token.

    Handed out alongside the access token at login/register. The web client
    ignores the extra field; the mobile client keeps it in the OS keychain so
    a phone doesn't sign the user out every seven days.

    Scope note — this is a *sliding window*, not rotation-with-revocation.
    Each call mints a distinct token (`jti` makes it unique even within the
    same second) and pushes the expiry out, but these are stateless JWTs: a
    previously issued refresh token stays valid until its own `exp` passes.
    Real rotation — where using a token invalidates its predecessor — needs
    server-side state to revoke against, i.e. a token table and a migration.
    That was deliberately not added for the first mobile build; if refresh
    tokens ever need to be revocable (a "sign out all devices" feature, or a
    stolen-device story), that table is the change to make.
    """
    now = datetime.utcnow()
    return jwt.encode(
        {
            "sub": str(user_id),
            "typ": TYP_REFRESH,
            "iat": now,
            "jti": uuid.uuid4().hex,
            "exp": now + timedelta(minutes=REFRESH_TOKEN_EXPIRE_MINUTES),
        },
        SECRET_KEY, algorithm=ALGORITHM,
    )


def decode_refresh_token(token: str) -> int:
    """Returns the user id, or raises 401. Refuses an access token presented
    here, so the two kinds can never be swapped for one another."""
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired refresh token",
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise invalid
    if payload.get("typ") != TYP_REFRESH:
        raise invalid
    sub = payload.get("sub")
    if sub is None:
        raise invalid
    try:
        return int(sub)
    except (TypeError, ValueError):
        raise invalid


def create_device_token(user_id: int) -> str:
    """A three-day token that says "this browser completed a password login".

    It is NOT a credential. Presented to the API it is rejected by
    get_current_user like every other non-access kind; the only thing it can do
    is be offered to POST /auth/pin/unlock ALONGSIDE the correct PIN, which
    returns a real access token. On its own — lifted from localStorage, say —
    it opens nothing.

    The `exp` is absolute from the password login, and no route reissues it, so
    three days after signing in the device has to use the password again.
    """
    now = datetime.utcnow()
    return jwt.encode(
        {
            "sub": str(user_id),
            "typ": TYP_DEVICE,
            "iat": now,
            # A per-device id. Not used for revocation — these are stateless
            # and nothing persists them — but it makes two devices' tokens
            # distinguishable in a debug session without reading the subject.
            "jti": uuid.uuid4().hex,
            "exp": now + timedelta(minutes=DEVICE_TOKEN_EXPIRE_MINUTES),
        },
        SECRET_KEY, algorithm=ALGORITHM,
    )


def decode_device_token(token: str) -> int:
    """Return the user id, or raise 401. Rejects every other token kind, so an
    access or refresh token cannot be passed off as a device token."""
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="This device needs to sign in with a password again.",
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise invalid
    if payload.get("typ") != TYP_DEVICE:
        raise invalid
    sub = payload.get("sub")
    if sub is None:
        raise invalid
    try:
        return int(sub)
    except (TypeError, ValueError):
        raise invalid


def device_token_expiry(token: str):
    """The token's own expiry, so the client can show how long is left without
    parsing a JWT itself. Returns None when it cannot be read."""
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        exp = payload.get("exp")
        return datetime.utcfromtimestamp(exp) if exp else None
    except Exception:  # noqa: BLE001 - a display helper never raises
        return None


def create_handoff_ticket(user_id: int, purpose: str) -> str:
    """A two-minute, purpose-scoped stand-in for the access token.

    Exists because starting an OAuth flow means navigating an *external*
    browser to our /auth URL, and a URL lands in browser history, in server
    logs and in the Referer header. Putting a seven-day bearer token there is
    the thing this avoids: a leaked ticket is useless two minutes later and
    can only do the one thing its purpose names."""
    expire = datetime.utcnow() + timedelta(seconds=HANDOFF_TICKET_EXPIRE_SECONDS)
    return jwt.encode(
        {"sub": str(user_id), "typ": TYP_HANDOFF, "pur": purpose, "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM,
    )


def decode_handoff_ticket(ticket: str, purpose: str) -> int:
    """Returns the user id, or raises 401. The purpose must match the one the
    ticket was minted for, so a Gmail ticket can't be replayed against Zoho."""
    invalid = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired authorization ticket",
    )
    try:
        payload = jwt.decode(ticket, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise invalid
    if payload.get("typ") != TYP_HANDOFF or payload.get("pur") != purpose:
        raise invalid
    sub = payload.get("sub")
    if sub is None:
        raise invalid
    try:
        return int(sub)
    except (TypeError, ValueError):
        raise invalid


def create_oauth_state(user_id: int, client: str) -> str:
    """Signs the OAuth `state` parameter.

    Previously `state` was the bare user id, which meant the value that decides
    *whose profile* a Gmail account gets attached to travelled through a third
    party as plain, editable text. Signing it closes that, and gives us
    somewhere to carry which client started the flow so the callback knows
    whether to return to the web app or to the phone."""
    expire = datetime.utcnow() + timedelta(seconds=OAUTH_STATE_EXPIRE_SECONDS)
    return jwt.encode(
        {"sub": str(user_id), "typ": TYP_OAUTH_STATE, "cli": client, "exp": expire},
        SECRET_KEY, algorithm=ALGORITHM,
    )


def decode_oauth_state(state: str) -> tuple:
    """Returns (user_id, client). Falls back to treating a bare integer as a
    legacy web-initiated state so an OAuth flow already in flight when this
    deployed still completes instead of erroring on the user."""
    if state and state.isdigit():
        return int(state), "web"
    try:
        payload = jwt.decode(state, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        return None, "web"
    if payload.get("typ") != TYP_OAUTH_STATE:
        return None, "web"
    sub = payload.get("sub")
    try:
        return int(sub), (payload.get("cli") or "web")
    except (TypeError, ValueError):
        return None, "web"


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)):
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        # A refresh token, a handoff ticket, an OAuth state or a device token
        # is not a credential for the API. Access tokens carry no "typ" at all,
        # so every token issued before this check existed still passes.
        if payload.get("typ") in (TYP_REFRESH, TYP_HANDOFF, TYP_OAUTH_STATE, TYP_DEVICE):
            raise credentials_exception
        user_id: str = payload.get("sub")
        if user_id is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = db.query(User).filter(User.id == int(user_id)).first()
    if user is None:
        raise credentials_exception
    return user
