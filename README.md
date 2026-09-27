# Agentic Financial Decision Twin

This repository contains the full stack for the Agentic Financial Decision Twin demo.
The frontend is built with pure Vanilla HTML/CSS/JS and the backend is a Python FastAPI application implementing a multi-agent orchestration pattern.

## Prerequisites

- Python 3.10+ (3.12 is what CI and the Dockerfile use)
- A Groq API key, and optionally a Gemini key, for the AI layer
- A database — either local SQLite (nothing to install) or the shared Supabase
  development database, see **[SUPABASE.md](SUPABASE.md)**

Every AI-backed feature degrades rather than fails when a key is missing or
over quota: simulations still return their full deterministic result, and the
stage trace says the wording came from the built-in template instead of a
model. Nothing on screen silently becomes wrong.

## Database

The backend talks to whatever `DATABASE_URL` in `backend/.env` points at, and
nothing in the application code cares which. Two setups are supported and both
are real:

| Setup | `DATABASE_URL` | Use it when |
| --- | --- | --- |
| **Local SQLite** | `sqlite:///./twin.db` | Working alone, or getting the product running in a hurry. Zero setup, and the file lives at the repository root. |
| **Shared PostgreSQL (Supabase)** | the Session Pooler string | Working with the team on one dataset. Setup, credentials and the schema-change rules are in **[SUPABASE.md](SUPABASE.md)**. |

There is no default: a missing `DATABASE_URL` stops the backend with an
explanation rather than silently creating a private SQLite file nobody else can
see. TLS is required automatically for any non-local host.

Migrations run against either. Every migration in `alembic/versions/` is either
dialect-neutral or guards its PostgreSQL-only parts, so `alembic upgrade head`
succeeds on SQLite as well.

## Setup

1. **Configure Environment Variables**
   Navigate to the `backend` directory and copy `.env.example` to `.env`:
   ```bash
   cp backend/.env.example backend/.env
   ```
   Edit `backend/.env` and insert your `GROQ_API_KEY` and the shared
   `DATABASE_URL` (see [SUPABASE.md](SUPABASE.md#4-configure-your-env) for
   where to get it). There is no default database any more: a missing
   `DATABASE_URL` stops the backend with an explanation rather than silently
   creating a private SQLite file nobody else can see.

2. **Install Backend Dependencies**
   ```bash
   cd backend
   python -m venv venv
   # On Windows:
   .\venv\Scripts\activate
   # On Mac/Linux:
   source venv/bin/activate
   pip install -r requirements.txt
   ```

3. **Bring Your Schema Up To Date**
   From the ROOT project directory:
   ```bash
   # On Windows:
   $env:PYTHONPATH="."
   python -m alembic upgrade head
   # On Mac/Linux:
   PYTHONPATH="." python -m alembic upgrade head
   ```
   Against the shared database this is usually a no-op, because whoever wrote
   the migration already applied it. Run it anyway — it is what makes a
   teammate's schema change reach you.

4. **Seed the Database** *(local databases only)*
   Only needed for a database of your own. The shared development database is
   already populated, and `seed.py` refuses to run twice. From the ROOT project
   directory:
   ```bash
   # Make sure your virtual environment is active!
   # On Windows:
   $env:PYTHONPATH="."
   python backend/seed.py
   # On Mac/Linux:
   PYTHONPATH="." python backend/seed.py
   ```

## After Pulling Changes

**Run `python -m alembic upgrade head` whenever you pull.** A pull can bring a
migration with it, and until you apply it every request touching the changed
table fails with `column ... does not exist` — which reads like a broken
feature rather than a stale schema.

The backend no longer creates tables on startup, and `migrate.py` no longer
edits a shared database. Both used to change the schema without leaving a
migration behind, which is invisible on a database of your own and corrosive on
one three people share — see
[SUPABASE.md § Changing the schema later](SUPABASE.md#6-changing-the-schema-later).

**Adding or changing a model?** Generate a migration and commit it with the
model change, in the same commit. The workflow, and how to avoid colliding with
a teammate, is in [SUPABASE.md](SUPABASE.md#6-changing-the-schema-later).

## Running the Application

### The short way (Windows)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

That frees port 8000 first, applies migrations, serves `twin-app/` on
`http://127.0.0.1:3000` and runs the API on `http://127.0.0.1:8000`. The port
step is not housekeeping: a uvicorn left running from an earlier session keeps
the port, the new one fails to bind, and the frontend quietly talks to the old
build — routers added since then return 404 and features disappear with no
error anywhere on screen.

### The manual way

**Backend**, from the root directory:
```bash
# On Windows:
$env:PYTHONPATH="."
uvicorn backend.main:app --reload --port 8000
# On Mac/Linux:
PYTHONPATH="." uvicorn backend.main:app --reload --port 8000
```
The API is at `http://localhost:8000`, docs at `/docs`, and an unauthenticated
health probe at `/health`.

**Frontend**, in a second terminal:
```bash
python scripts/serve_web.py --port 3000
```
Open `http://localhost:3000`.

Use this rather than `python -m http.server`. The standard server sends no
`Cache-Control`, so the browser keeps reusing old HTML without asking and page
changes silently fail to appear (see the note in `scripts/serve_web.py`).

### Where the frontend looks for the API

`twin-app/js/config.js` resolves the base once, and everything else uses what
it decides:

1. `window.__API_BASE`, if a deploy-time snippet set it
2. `<meta name="moneykal-api-base" content="...">`, if the page has one
3. `<origin>/api` when the page is served over https — a deployed build proxies
   `/api` to the backend, which keeps the two same-origin and avoids both CORS
   and the mixed-content block that silently kills every call from an https
   page to an http API
4. `http://<hostname>:8000` for local development

Nothing else in the frontend hardcodes a host or a port.

### Demo accounts

So that no one ever meets an empty dashboard:

```bash
$env:PYTHONPATH="."
python backend/seed_demo_accounts.py
python backend/seed_home_demo.py demo@moneykal.app   # ledger, goals, upcoming
```

| Account | Login |
| --- | --- |
| Individual | `demo@moneykal.app` |
| Startup / CFO | `founder@moneykal.app` |

Both use the password in `DEMO_ACCOUNT_PASSWORD`. Set it in `backend/.env`
before seeding — the script refuses to run without it — and get the team's value
from the password manager rather than from this file.

Both are idempotent and write through the same tables the app writes at
runtime, so every figure on screen is computed by the normal code path. These
are throwaway logins for a demo database — do not create them anywhere holding
real data.

## Deployment

The API is containerised and the frontend is static.

| File | What it does |
| --- | --- |
| `Dockerfile` | Builds the API. Runs as a non-root user, has a healthcheck, and deliberately does **not** run migrations at container start — that races between replicas. |
| `render.yaml` | Kept for Render, not used by production. Migrations run once per deploy as a pre-deploy step, and the static site rewrites `/api/*` onto the API so the two are same-origin. Its optional Postgres block is commented out so a blueprint launch cannot stand up an empty database beside Supabase and serve it as production. |
| `vercel.json` | Alternative for the static frontend, with the same `/api/*` rewrite and the security headers. |
| `railway.toml` | Blueprint for Railway, the current production target. Builds from the same `Dockerfile`, runs `alembic upgrade head` once per deploy as a pre-deploy step, and limits rebuild triggers to backend paths so an Android or CSS commit does not restart the API. |

**Production runs on Railway against the existing Supabase database.** See
[RAILWAY.md](RAILWAY.md) for the environment-variable checklist, the
background-job rule (exactly one process may run the scheduler), and how the
web and mobile clients are pointed at the deployed API. `render.yaml` is kept
and still works, but is not what production uses.

```bash
docker build -t moneykal-api .
docker run -p 8000:8000 --env-file backend/.env moneykal-api
```

Set `CORS_ALLOW_ORIGINS` to the deployed frontend origin in production. It
defaults to `*`, which is safe for this API — there are no cookies,
`allow_credentials` is off, and every authenticated route requires a bearer
header a cross-origin page cannot obtain — but narrowing it costs one variable.

## Voice Mode (Vapi)

Voice is a second interface onto the *same* Financial Twin — not a second brain.
The real-time layer is [Vapi](https://vapi.ai); every personalised answer still
comes from the existing orchestrator, simulation engine and database.

```
User voice
  -> Vapi Web SDK (mic, STT, turn-taking, barge-in, TTS)
    -> POST /voice/tool  (authenticated by a signed, user-scoped voice token)
      -> existing orchestrator / startup_orchestrator / financial_simulator
        -> user profile, simulations, market intelligence, RAG
      <- structured result
  <- Vapi speaks it back
```

### Setup

1. Create a Vapi account and copy the **public key** from
   dashboard.vapi.ai -> API Keys.
2. Put it in `backend/.env`:
   ```
   VAPI_PUBLIC_KEY=your_public_key
   ```
   See `backend/.env.example` for the optional model/voice overrides.
3. Expose the backend to Vapi. Vapi calls the tool endpoint from its own
   servers, so `127.0.0.1` will not work. From the project root, in its own
   terminal:
   ```bash
   python voice_tunnel.py
   ```
   That opens a Cloudflare quick tunnel and writes `VAPI_SERVER_URL` into
   `backend/.env` for you. Leave it running. (Already use ngrok? Run
   `ngrok http 8000` and set `VAPI_SERVER_URL` by hand instead.)
4. Restart the backend so it reads the new config, hard-reload the frontend,
   sign in, open **Ask Twin** and click the mic (or the VARTA card on the
   Overview). Allow microphone access and start talking; you can interrupt the
   assistant at any time.

The tunnel URL changes every time the tunnel restarts. If voice stops
connecting, re-run `python voice_tunnel.py` and restart the backend.

The Vapi Web SDK is loaded from a CDN at runtime, so no `npm install` is needed
for the static frontend. In a bundled app the equivalent is
`npm i @vapi-ai/web`.

### Notes

- Voice transcripts are shown live and are **not** written to chat history or
  the database (set `VOICE_PERSIST_TRANSCRIPTS=true` to opt in).
- Telephony is not enabled. The assistant and tools are channel-agnostic, so a
  phone number can be pointed at the same agent later without backend changes.
