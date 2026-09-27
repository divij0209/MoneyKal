"""A dependency-free sliding-window rate limiter for the authentication routes.

WHY THIS EXISTS
---------------
`/auth/login` had no throttle of any kind: ten consecutive wrong passwords
returned ten immediate 401s with no delay, no lockout and no captcha, which is
an open door for unlimited credential stuffing against a product holding
people's financial profiles.

WHY IT IS IN-PROCESS AND NOT REDIS OR SLOWAPI
---------------------------------------------
The backend runs as a single uvicorn process, so a per-process counter is an
accurate counter. Adding a dependency (SlowAPI) or a service (Redis) to get the
same behaviour would add a failure mode — a limiter that cannot reach its store
either fails open, which is no limiter, or fails closed, which locks everyone
out — for no benefit at this scale. If the API is ever run with more than one
worker this becomes per-worker and the effective limit multiplies by the worker
count; that is a deliberate, documented trade rather than an oversight, and the
fix at that point is a shared store, not a rewrite of the call sites.

State is bounded: expired buckets are swept on write, and the sweep is cheap
because the dictionary only ever holds keys seen inside the current window.
"""
from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional, Tuple

from fastapi import HTTPException, Request, status


class SlidingWindowLimiter:
    """Counts hits per key inside a rolling window."""

    def __init__(self, max_hits: int, window_seconds: int) -> None:
        self.max_hits = max_hits
        self.window = window_seconds
        self._hits: Dict[str, List[float]] = {}
        self._lock = threading.Lock()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window
        empty = []
        for key, stamps in self._hits.items():
            kept = [s for s in stamps if s > cutoff]
            if kept:
                self._hits[key] = kept
            else:
                empty.append(key)
        for key in empty:
            self._hits.pop(key, None)

    def check(self, key: str) -> Tuple[bool, int]:
        """Return (allowed, retry_after_seconds) WITHOUT recording a hit."""
        now = time.time()
        with self._lock:
            stamps = [s for s in self._hits.get(key, []) if s > now - self.window]
            if len(stamps) < self.max_hits:
                return True, 0
            retry = int(self.window - (now - stamps[0])) + 1
            return False, max(retry, 1)

    def record(self, key: str) -> None:
        """Record one hit against the key."""
        now = time.time()
        with self._lock:
            self._prune(now)
            self._hits.setdefault(key, []).append(now)

    def reset(self, key: str) -> None:
        """Forget a key's history. Called after a successful sign-in so a user
        who mistyped twice and then got it right does not stay one attempt away
        from a lockout for the rest of the window."""
        with self._lock:
            self._hits.pop(key, None)


def client_ip(request: Optional[Request]) -> str:
    """Best-effort caller identity.

    X-Forwarded-For is honoured because the intended deployment sits behind a
    proxy, and its absence locally is fine. It is spoofable, which is exactly
    why the login limiter keys on username as well: an attacker who rotates the
    header still cannot get more than the allowance against any one account.
    """
    if request is None:
        return "unknown"
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return getattr(getattr(request, "client", None), "host", None) or "unknown"


# Two different jobs, so two different allowances, both keyed into the same
# limiter:
#
#   user:<username>  5 failures / 15 min — the real protection. Guessing one
#                    account's password is capped at 20 attempts an hour no
#                    matter how many addresses the attacker rotates through.
#
#   ip:<address>    20 failures / 15 min — a backstop against one host spraying
#                    many accounts. Deliberately looser than the per-account
#                    limit because an IP is not a person: a conference network,
#                    an office, or any NAT puts everyone behind one address, and
#                    five failures shared across a room would lock out people who
#                    had done nothing wrong. Twenty still stops a script.
login_limiter = SlidingWindowLimiter(max_hits=5, window_seconds=15 * 60)
login_ip_limiter = SlidingWindowLimiter(max_hits=20, window_seconds=15 * 60)

# Registration is throttled per IP only — there is no account to key on yet.
# Ten new accounts an hour from one address is far above real use and far below
# what is useful for filling the database with junk.
register_limiter = SlidingWindowLimiter(max_hits=10, window_seconds=60 * 60)


def enforce(limiter: SlidingWindowLimiter, keys: List[str], message: str) -> None:
    """Raise 429 if any of `keys` is over its allowance."""
    for key in keys:
        allowed, retry_after = limiter.check(key)
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=message,
                headers={"Retry-After": str(retry_after)},
            )
