import os
os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
import logging
from datetime import datetime, date, timedelta

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.core.access import has_act, require_act
from backend.core.auth import (
    get_current_user, create_handoff_ticket, decode_handoff_ticket,
    create_oauth_state, decode_oauth_state, HANDOFF_TICKET_EXPIRE_SECONDS,
)
from backend.models.domain import User, Profile, GmailConnection, StartupTransaction
from backend.services.gmail_import_service import (
    build_flow, credentials_from_connection, fetch_candidate_messages, parse_candidate_messages,
)
from backend.services.gmail_deadline_service import build_deadline_query, detect_obligations
from backend.services.upcoming_ingest import ingest_obligations

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/gmail", tags=["Gmail Import"])
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'), override=True)

GMAIL_CLIENT_ID = os.getenv("GMAIL_CLIENT_ID")
GMAIL_CLIENT_SECRET = os.getenv("GMAIL_CLIENT_SECRET")
GMAIL_REDIRECT_URI = os.getenv("GMAIL_REDIRECT_URI")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5500")
#: Where a mobile-initiated OAuth flow returns to. A custom scheme, so the OS
#: hands control back to the installed app instead of leaving the user staring
#: at a web page they can't act on.
MOBILE_REDIRECT_SCHEME = os.getenv("MOBILE_REDIRECT_SCHEME", "moneykal")

#: Purpose tag for the short-lived handoff ticket, so a Gmail ticket can never
#: be replayed against another OAuth integration.
GMAIL_HANDOFF_PURPOSE = "gmail_oauth"


def _require_gmail_config():
    if not GMAIL_CLIENT_ID or not GMAIL_CLIENT_SECRET or not GMAIL_REDIRECT_URI:
        raise HTTPException(status_code=500, detail="Gmail OAuth is not configured on the backend (.env missing GMAIL_CLIENT_ID/SECRET/REDIRECT_URI).")


def _return_url(client: str, status: str, detail: str = ""):
    if client == "mobile":
        return f"moneykal://gmail?status={status}&detail={detail}"
    return f"{FRONTEND_URL}/dashboard.html?view=hisaab&status={status}&detail={detail}"


@router.post("/oauth-ticket")
def gmail_oauth_ticket(current_user: User = Depends(require_act("gmail_ingest"))):
    """Mint a two-minute, single-purpose ticket for starting the OAuth flow.

    Starting OAuth means navigating an *external* browser to /gmail/auth, and
    whatever is in that URL ends up in browser history and server logs. This
    exists so the thing that lands there is a two-minute ticket rather than a
    seven-day bearer token. Mobile-only; the web path is unchanged.
    """
    return {
        "ticket": create_handoff_ticket(current_user.id, GMAIL_HANDOFF_PURPOSE),
        "expires_in": HANDOFF_TICKET_EXPIRE_SECONDS,
        "auth_url": f"/gmail/auth?client=mobile&ticket=",
    }


@router.get("/auth")
def gmail_auth(token: str = None, ticket: str = None, client: str = "web", db: Session = Depends(get_db)):
    """Kicks off the OAuth flow. The caller should navigate a browser directly
    to this URL (not fetch() it) so Google's consent screen shows.

    Two ways in, both landing in the same place:
      - `ticket` — the short-lived handoff from POST /gmail/oauth-ticket. What
        the mobile app uses.
      - `token`  — a full access token in the query string. What the web app
        has always sent (twin-app/js/startup.js), kept working as-is.
    """
    if ticket:
        user_id = decode_handoff_ticket(ticket, GMAIL_HANDOFF_PURPOSE)
    elif token:
        from backend.core.auth import SECRET_KEY, ALGORITHM
        from jose import jwt, JWTError
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            user_id = payload.get("sub")
        except JWTError:
            raise HTTPException(status_code=401, detail="Invalid token")
    else:
        raise HTTPException(status_code=401, detail="Missing token")

    current_user = db.query(User).filter(User.id == int(user_id)).first()
    if not current_user:
        raise HTTPException(status_code=401, detail="Invalid token")

    # Gmail import is part of ACT. This route is opened by navigating a browser
    # to it, so a 402 would land as raw JSON on screen; send the user back to
    # the app with a reason instead. Connections that already exist are kept.
    if not has_act(db, current_user.id):
        return RedirectResponse(_return_url(client, "error", "upgrade_required"))

    _require_gmail_config()
    flow = build_flow(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI)
    # `state` carries who to attach the connection to *and* which client asked,
    # signed so neither can be edited in transit — it used to be a bare, plainly
    # editable user id travelling through a third party.
    auth_url, _ = flow.authorization_url(
        access_type="offline", include_granted_scopes="true", prompt="consent select_account",
        state=create_oauth_state(current_user.id, "mobile" if client == "mobile" else "web"),
    )
    return RedirectResponse(auth_url)


@router.get("/callback")
def gmail_callback(code: str = None, state: str = None, error: str = None, db: Session = Depends(get_db)):
    # Diagnostics go to the application log, never to a file in the working
    # directory: the old oauth_debug.log was committed with connected Gmail
    # addresses in it. Nothing below logs an email address or any part of the
    # OAuth code or state.
    logger.info("Gmail OAuth callback received: error=%s code_present=%s", error, bool(code))
    user_id, client = decode_oauth_state(state) if state else (None, "web")
    logger.info("Gmail OAuth state decoded: user_id=%s client=%s", user_id, client)

    if error or not code or user_id is None:
        logger.warning("Gmail OAuth callback rejected: error=%s code_present=%s user_id=%s",
                       error, bool(code), user_id)
        return RedirectResponse(_return_url(client, "error"))

    _require_gmail_config()
    flow = build_flow(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REDIRECT_URI)
    try:
        flow.fetch_token(code=code)
    except Exception as e:
        logger.error("Gmail token exchange failed: %s: %s", type(e).__name__, e)
        return RedirectResponse(_return_url(client, "error"))

    creds = flow.credentials
    profile = db.query(Profile).filter(Profile.user_id == user_id).first()
    if not profile:
        logger.warning("Gmail OAuth callback for user_id=%s found no profile", user_id)
        return RedirectResponse(_return_url(client, "error", "no_profile"))

    import requests
    userinfo_resp = requests.get("https://www.googleapis.com/oauth2/v2/userinfo", headers={"Authorization": f"Bearer {creds.token}"})
    email_address = userinfo_resp.json().get("email") if userinfo_resp.ok else None
    logger.info("Gmail userinfo fetched: ok=%s email_present=%s",
                userinfo_resp.ok, bool(email_address))

    conn = db.query(GmailConnection).filter(GmailConnection.profile_id == profile.id, GmailConnection.email_address == email_address).first()
    if not conn:
        conn = db.query(GmailConnection).filter(GmailConnection.profile_id == profile.id, GmailConnection.email_address.is_(None)).first()
        if conn:
            conn.email_address = email_address
        else:
            conn = GmailConnection(profile_id=profile.id, email_address=email_address)
            db.add(conn)

    conn.access_token = creds.token
    conn.refresh_token = creds.refresh_token or conn.refresh_token
    conn.token_expiry = creds.expiry
    conn.is_active = True
    db.commit()
    logger.info("Gmail connection saved: conn_id=%s", conn.id)

    return RedirectResponse(_return_url(client, "success"))


@router.get("/status")
def gmail_status(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    # Whether this deployment can start an OAuth flow at all, which is a
    # different question from whether this user has connected an account. The
    # client cannot tell "not connected yet" from "cannot ever connect" without
    # it, so it offered a button that could only fail.
    configured = bool(GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET and GMAIL_REDIRECT_URI)

    connections = db.query(GmailConnection).filter(GmailConnection.profile_id == profile.id, GmailConnection.is_active == True).all()
    if not connections:
        return {"connected": False, "configured": configured, "accounts": []}
    return {
        "connected": True,
        "configured": configured,
        "accounts": [
            {
                "id": c.id,
                "email_address": c.email_address,
                "last_synced_at": c.last_synced_at.isoformat() if c.last_synced_at else None
            } for c in connections
        ]
    }


@router.post("/disconnect")
def gmail_disconnect(email: str = None, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        return {"success": False}
    query = db.query(GmailConnection).filter(GmailConnection.profile_id == profile.id, GmailConnection.is_active == True)
    if email:
        query = query.filter(GmailConnection.email_address == email)
    conns = query.all()
    for conn in conns:
        conn.is_active = False
    db.commit()
    return {"success": True}


def run_sync_for_connection(db: Session, conn: GmailConnection) -> dict:
    """One sync pass over the same Gmail connection, feeding two readers.

    Reader 1 (unchanged): bank/merchant mail becomes StartupTransaction rows
    with source='auto', deduped on the gmail_message_id kept in the description.

    Reader 2 (new): billing mail becomes upcoming_payments rows. It runs its own
    narrow Gmail search rather than reusing reader 1's results, because the two
    are looking for opposite things — a debit alert is not a deadline, and a
    "your bill is due" mail carries no debit. Both searches are server-side
    filtered, so neither walks the mailbox.

    Returns {"transactions_added": int, "deadlines": {...}}. The old integer
    return is preserved under "transactions_added" for existing callers.
    """
    creds = credentials_from_connection(conn, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET)
    since = conn.last_synced_at or (datetime.utcnow() - timedelta(days=14))

    # ---- Reader 1: transactions (existing behaviour, untouched) ----
    messages = fetch_candidate_messages(creds, since=since)
    candidates = parse_candidate_messages(messages)

    existing_ids = {
        t.description.split("gmail_id=")[-1].rstrip("]")
        for t in db.query(StartupTransaction).filter(
            StartupTransaction.profile_id == conn.profile_id,
            StartupTransaction.source == "auto",
        ).all()
        if t.description and "gmail_id=" in t.description
    }

    inserted = 0
    for c in candidates:
        if c["gmail_message_id"] in existing_ids:
            continue
        txn = StartupTransaction(
            profile_id=conn.profile_id,
            type=c["type"],
            category=c["category"],
            amount=c["amount"],
            description=f"{c['description']} [gmail_id={c['gmail_message_id']}]",
            txn_date=date.today(),
            source="auto",
        )
        db.add(txn)
        inserted += 1

    # ---- Reader 2: upcoming financial deadlines ----
    # Isolated so a detection failure can never lose the transactions above,
    # which are already staged on this session.
    deadlines = {"created": 0, "review": 0}
    try:
        deadline_msgs = fetch_candidate_messages(
            creds, since=since, query=build_deadline_query(since)
        )
        obligations = detect_obligations(deadline_msgs)
        deadlines = ingest_obligations(db, conn.profile_id, obligations).to_dict()
    except Exception as e:
        logger.error(
            "Deadline detection failed for profile %s: %s: %s",
            conn.profile_id, type(e).__name__, e,
        )
        deadlines = {"created": 0, "review": 0, "error": str(e)}

    conn.last_synced_at = datetime.utcnow()
    db.commit()
    return {"transactions_added": inserted, "deadlines": deadlines}


@router.post("/sync-now")
def gmail_sync_now(current_user: User = Depends(require_act("gmail_ingest")), db: Session = Depends(get_db)):
    """Manual 'sync now' button — same logic the hourly scheduler job runs."""
    profile = db.query(Profile).filter(Profile.user_id == current_user.id).first()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")
    conns = db.query(GmailConnection).filter(GmailConnection.profile_id == profile.id, GmailConnection.is_active == True).all()
    if not conns:
        raise HTTPException(status_code=400, detail="Gmail is not connected for this profile.")

    total_added = 0
    all_deadlines = {"created": 0, "review": 0}
    try:
        for conn in conns:
            result = run_sync_for_connection(db, conn)
            total_added += result.get("transactions_added", 0)
            d = result.get("deadlines", {})
            all_deadlines["created"] += d.get("created", 0)
            all_deadlines["review"] += d.get("review", 0)
            if "error" in d:
                all_deadlines["error"] = d["error"]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sync failed: {e}")

    return {
        "success": True,
        "transactions_added": total_added,
        "deadlines": all_deadlines,
    }