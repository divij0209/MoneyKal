


from fastapi import FastAPI
import os

from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager

from backend.database import engine, Base, auto_create_all, describe_target
from backend.scheduler import start_scheduler, stop_scheduler

# Schema is owned by Alembic ('alembic upgrade head'). This creates missing
# tables only when DB_AUTO_CREATE=true against a local database — see
# backend/database.py:auto_create_all for why it is no longer unconditional.
import backend.models.domain  # noqa: F401  — registers the models on Base.metadata
auto_create_all()

@asynccontextmanager
async def lifespan(app: FastAPI):
    start_scheduler()
    yield
    stop_scheduler()

from backend.routers import auth, onboarding, profile, startup, twin, zoho, gmail, hisaab, market_pulse, home, live_life, tax, voice, whatsapp, budgets, uploads, gamification, split, notifications
# Startup-only additions. Each is fenced to the Startup persona in its own
# router and adds no routes to any existing prefix.
from backend.routers import fundraise, compliance, gst
# Plans & Billing. Additive: reads plan state, adds no routes to any existing prefix.
from backend.routers import billing

app = FastAPI(title="MoneyKal API", lifespan=lifespan)

app.include_router(auth.router)
app.include_router(onboarding.router)
app.include_router(profile.router)
app.include_router(startup.router)
app.include_router(twin.router)
app.include_router(zoho.router)
app.include_router(gmail.router)
app.include_router(hisaab.router)
app.include_router(market_pulse.router)
app.include_router(home.router)
app.include_router(live_life.router)
app.include_router(tax.router)
app.include_router(voice.router)
app.include_router(whatsapp.router)
app.include_router(budgets.router)
app.include_router(uploads.router)
app.include_router(gamification.router)
# Money Splits, and the notification inbox it is the first producer for.
# Both are additive: no existing router, model or response shape changes.
app.include_router(split.router)
app.include_router(notifications.router)
app.include_router(fundraise.router)
app.include_router(compliance.router)
app.include_router(gst.router)
app.include_router(billing.router)

# --- Security response headers ---------------------------------------------
# Added as a plain middleware rather than a dependency so it covers every
# response the app can emit, including 404s, validation errors and the 500 from
# the handler at the bottom of this file.
#
# There is deliberately NO Content-Security-Policy here. This process serves
# JSON and the Swagger UI; a CSP tight enough to be worth having would break
# /docs, and a CSP loose enough not to would be decoration. CSP belongs on
# whatever serves twin-app/, which is where the HTML and the inline scripts are.
@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    # Stops a browser second-guessing a declared content type — the standard
    # defence against a JSON response being executed as script.
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    # Nothing here is meant to be framed, so clickjacking has no surface.
    response.headers.setdefault("X-Frame-Options", "DENY")
    # Keeps full URLs (which can carry ids) out of cross-origin referrers.
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Permitted-Cross-Domain-Policies", "none")
    # HSTS is only meaningful, and only safe, once the request actually arrived
    # over TLS. Asserting it on a plain-http development server would pin
    # localhost to https in the developer's browser.
    if request.url.scheme == "https":
        response.headers.setdefault(
            "Strict-Transport-Security", "max-age=31536000; includeSubDomains"
        )
    return response


# --- CORS -------------------------------------------------------------------
# Configured from the environment so a deployment can name its own origins
# without a code change:
#
#     CORS_ALLOW_ORIGINS=https://app.moneykal.com,https://moneykal.com
#
# The default stays "*", which is correct rather than lazy for this API: there
# are no cookies and no session — `allow_credentials` is False and every
# authenticated route requires an Authorization header that a cross-origin page
# cannot obtain or attach on a user's behalf. A wildcard here therefore grants a
# hostile page nothing it could not already get with curl. It is narrowed in
# deployment anyway, because defence in depth is cheap when it is one env var.
_cors_origins = [
    o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "*").split(",") if o.strip()
] or ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Agentic Financial Decision Twin API is running"}


@app.get("/health", tags=["Health"])
def health():
    """Unauthenticated reachability probe.

    Added for the mobile client, which needs to tell three states apart that
    all look identical from a failed fetch: the phone is offline, the phone is
    on a different network than the API host, or the server is genuinely down.
    Returns no user data and touches no database.
    """
    return {"status": "ok", "service": "moneykal-api"}

import logging
from fastapi import Request
from fastapi.responses import JSONResponse

_logger = logging.getLogger("moneykal.unhandled")


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    # Logged, not written to a file. The previous version opened ./error.log on
    # every unhandled exception, which is three problems in production: it is a
    # blocking synchronous write inside an async handler, it grows without
    # bound inside the container, and a container filesystem is ephemeral, so
    # the tracebacks never reach the platform's log collector. logging goes to
    # stdout, which Render and Docker capture.
    _logger.exception("Unhandled exception on %s %s", request.method, request.url.path)

    # This handler runs outside CORSMiddleware, so without an explicit CORS
    # header the browser blocks the 500 and the frontend sees an opaque
    # "Failed to fetch" instead of the real status. The value mirrors whatever
    # CORS_ALLOW_ORIGINS configured above, rather than a hardcoded "*" that
    # would contradict a narrowed deployment.
    origin = request.headers.get("origin")
    if "*" in _cors_origins:
        allow = "*"
    elif origin and origin in _cors_origins:
        allow = origin
    else:
        allow = _cors_origins[0]

    # The body stays opaque: the traceback goes to the log, never to the caller.
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal Server Error"},
        headers={"Access-Control-Allow-Origin": allow},
    )
