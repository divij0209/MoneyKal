"""Set an account's password directly against the database.

WHY THIS EXISTS
---------------
There is no self-serve password reset in the product yet — the forgot-password
dialog says so honestly — which means a developer or a demo operator who does
not know an account's password has no way back into it at all. That is fine for
a real user (they have their password) and useless for anyone running the app
locally against a database full of accounts created months ago.

This is an operator tool, not a feature. It talks to the database directly, it
does not go through the API, and it has no authentication of its own: whoever
can run it can already read backend/.env and the database file. Do not deploy
it, and do not point it at a database holding other people's accounts.

    # from the project root
    $env:PYTHONPATH="."                                     # PowerShell
    python backend/set_password.py --list
    python backend/set_password.py you@example.com
    python backend/set_password.py you@example.com "MyNewPass!2026"

Called without a password it generates a strong one and prints it. The password
is written with the same bcrypt hashing the register route uses, so the account
behaves identically afterwards, and any stale rate-limit lockout is irrelevant
because the limiter lives in the API process, not the database.
"""
import secrets
import string
import sys

from backend.database import SessionLocal, describe_target
from backend.models.domain import Profile, User
from backend.routers.auth import (
    MIN_PASSWORD_LENGTH, hash_password, normalize_username,
)


def generate_password(length: int = 16) -> str:
    """A readable, strong password. Excludes characters that are easy to
    misread when someone is typing one off a screen during a demo."""
    alphabet = (string.ascii_lowercase.replace("l", "")
                + string.ascii_uppercase.replace("I", "").replace("O", "")
                + string.digits.replace("0", "").replace("1", "")
                + "!@#$%*?")
    return "".join(secrets.choice(alphabet) for _ in range(length))


def list_accounts(db) -> None:
    users = db.query(User).order_by(User.id).all()
    print("%-6s %-40s %s" % ("id", "username", "profile"))
    print("-" * 68)
    for u in users:
        profile = db.query(Profile).filter(Profile.user_id == u.id).first()
        print("%-6s %-40s %s" % (u.id, u.username, profile.key if profile else "no profile"))
    print("\n%d account(s) in %s" % (len(users), describe_target()))


def set_password(db, username: str, password: str = None) -> int:
    lookup = normalize_username(username)
    user = db.query(User).filter(User.username == lookup).first()
    if not user:
        # Case-insensitive second pass, matching how login resolves an account.
        user = next((u for u in db.query(User).all()
                     if (u.username or "").lower() == lookup), None)
    if not user:
        print("No account named %r." % username)
        print("Run with --list to see what exists.")
        return 1

    if password is None:
        password = generate_password()
    elif len(password) < MIN_PASSWORD_LENGTH:
        print("Password must be at least %d characters (the register route "
              "enforces the same floor)." % MIN_PASSWORD_LENGTH)
        return 1

    user.hashed_password = hash_password(password)
    db.commit()

    profile = db.query(Profile).filter(Profile.user_id == user.id).first()
    print("Updated %s" % describe_target())
    print("")
    print("  account   %s  (id %s, %s)" % (user.username, user.id,
                                           profile.key if profile else "no profile"))
    print("  password  %s" % password)
    print("")
    if not profile:
        print("This account has no profile yet, so signing in will resume onboarding.")
    return 0


def main() -> int:
    args = [a for a in sys.argv[1:]]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0

    db = SessionLocal()
    try:
        if args[0] in ("-l", "--list"):
            list_accounts(db)
            return 0
        return set_password(db, args[0], args[1] if len(args) > 1 else None)
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
