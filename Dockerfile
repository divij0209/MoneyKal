# MoneyKal API.
#
# The repository had no deployment configuration of any kind, which meant the
# product could only be opened on the team's own laptop. This is the smallest
# thing that makes the backend runnable anywhere.
#
#   docker build -t moneykal-api .
#   docker run -p 8000:8000 --env-file backend/.env moneykal-api
#
# The frontend in twin-app/ is static and is deployed separately (see
# vercel.json / render.yaml). It finds this service through the API base
# resolved in twin-app/js/config.js.

FROM python:3.12-slim

# PyMuPDF and psycopg2-binary ship wheels, so no compiler is needed. curl is
# here only for the healthcheck below.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

# Dependencies first so a code change does not invalidate the install layer.
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --upgrade pip && pip install -r backend/requirements.txt

COPY alembic.ini ./
COPY alembic ./alembic
COPY backend ./backend

# Never run as root in a container that terminates untrusted input.
RUN useradd --create-home --uid 10001 moneykal \
    && chown -R moneykal:moneykal /app
USER moneykal

# Documentation only. The real port is $PORT at runtime; Railway ignores EXPOSE
# and routes to whatever port the process actually binds.
EXPOSE 8000

# Uses the app's own unauthenticated probe rather than a bare TCP check, so a
# process that is listening but broken is reported unhealthy.
#
# Probes $PORT rather than a hardcoded 8000. The CMD below binds ${PORT:-8000},
# and a platform that injects its own PORT -- Railway does, and it is rarely
# 8000 -- would otherwise leave this probing a port nothing listens on and
# report the container permanently unhealthy while the app is perfectly fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT:-8000}/health" || exit 1

# Migrations are NOT run here. Applying schema changes from every starting
# replica is how two containers race each other on the same database; run
# `alembic upgrade head` as a release step instead (render.yaml does).
# --proxy-headers/--forwarded-allow-ips let uvicorn read X-Forwarded-Proto from
# Railway's TLS-terminating edge. Without them every request looks like plain
# http to the app, so the HSTS header in backend/main.py -- which is set only
# when request.url.scheme is https, deliberately, so a local dev server cannot
# pin localhost to https in a browser -- was never emitted in production.
# Trusting the header from any peer is correct here because the container is
# only reachable through that proxy.
CMD ["sh", "-c", "uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
