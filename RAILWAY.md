# Deploying the MoneyKal API to Railway

Written for: whoever is deploying or operating this backend.

The target shape:

```
GitHub main
     |
     v
Railway service  (Docker, ./Dockerfile)   <-- this document
     |
     v
Supabase PostgreSQL  (existing, unchanged)

twin-app/  -> Vercel  --/api/*--> Railway API
mobile/    -> EAS     --------->  Railway API
```

## What Railway deploys, and what it must not

This repository contains three deployable things. Only one belongs on Railway.

| Directory | Deploys to | Notes |
|---|---|---|
| `backend/` + `alembic/` | **Railway** | The FastAPI service |
| `twin-app/` | Vercel | Static; reaches the API through a `/api/*` rewrite |
| `mobile/` | EAS build | Expo React Native Android app |

Two things keep the other two out of the API container:

- `railway.toml` sets `builder = "DOCKERFILE"`, and `Dockerfile` copies only
  `backend/`, `alembic/` and `alembic.ini`. `mobile/package.json` therefore
  cannot lure Railway's Node detection into a Python service.
- `.dockerignore` excludes `mobile/`, `marketing/`, every `.env`, every `*.db`
  and `.git`, so none of it even enters the build context.

`railway.toml` also sets `watchPatterns`, so an Android-only or CSS-only commit
does not rebuild and restart production for no reason.

## Migrations

`railway.toml` runs migrations as a pre-deploy step:

```toml
[deploy]
preDeployCommand = ["alembic upgrade head"]
```

This runs **once per deployment, before any new container serves traffic** —
not once per replica. That distinction is the point. `alembic upgrade head` in
a container start command would have every replica racing the same DDL against
the same database. As a pre-deploy step, a failed migration also aborts the
deploy and leaves the previous version serving, instead of starting a new
version against a schema it cannot use.

The application never migrates itself. `backend/database.py:auto_create_all()`
refuses remote databases outright and `migrate.py` does the same, so Alembic is
the only thing that changes the production schema.

## Database

**Keep Supabase. Do not add a Railway Postgres to this project.** Every
account, Kal Coins ledger row and billing order lives in Supabase. A second
database would come up empty and be served as production, which is
indistinguishable from data loss to anyone looking at it.

`DATABASE_URL` should be the Supabase **Session Pooler** string. TLS does not
need to be in the URL: `backend/database.py` appends `sslmode=require`
automatically for any non-local host. The engine is already configured for a
pooled remote database — `pool_pre_ping` (the pooler drops idle connections),
`pool_recycle=1800`, and a deliberately small pool.

## Environment variables

Set these in the Railway service. **Nothing here is committed to git.**

### Required

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase Session Pooler connection string |
| `JWT_SECRET` | Long random string. Changing it invalidates every existing session |
| `CORS_ALLOW_ORIGINS` | Comma-separated. The Vercel origin, e.g. `https://moneykal.vercel.app` |
| `FRONTEND_URL` | Public web origin, used in links |
| `PAYMENT_MODE` | **`live`**. The code default is `demo`, where checkout simulates payment and grants ACT for free |
| `GEMINI_API_KEY` | |
| `GROQ_API_KEY` | |

### Recommended

| Variable | Value | Why |
|---|---|---|
| `ENABLE_SCHEDULER` | `false` | See "Background jobs" below |
| `DB_AUTO_CREATE` | `false` | Explicit; it refuses remote databases anyway |
| `WHATSAPP_TEST_SEND` | `false` | Keeps the dev-only send endpoint off |
| `VOICE_PERSIST_TRANSCRIPTS` | `false` | Voice transcripts are user financial data |
| `DB_APP_NAME` | `moneykal-railway` | Names the connection in the Supabase dashboard; otherwise it is a random container id |

### Optional integrations

Each feature detects its own absence and hides or explains itself rather than
failing, so these can stay unset.

| Feature | Variables |
|---|---|
| Varta in the browser (Vapi) | `VAPI_PUBLIC_KEY`, `VAPI_SERVER_URL` |
| Varta over the phone (Omnidim) | `OMNIDIM_API_KEY`, `OMNIDIM_AGENT_ID`, `OMNIDIM_FROM_NUMBER_ID` |
| Gmail import | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` |
| WhatsApp logging | `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` |
| Market data | `NEWS_API_KEY`, `FRED_API_KEY`, `EXCHANGE_RATE_API_KEY` |
| Zoho | `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REDIRECT_URI` |

`ALERT_PHONE_NUMBER` exists for operational alerts only. It is deliberately not
a fallback for a user-initiated call: the assistant reads the caller's own
balances and bills aloud, so dialling a shared default would speak one user's
finances to whoever answered. A user with no saved number gets a 400.

`PORT` is injected by Railway. Do not set it.

### As actually deployed

The live service sets `CORS_ALLOW_ORIGINS` to its own origin
(`https://moneykal-api-production.up.railway.app`) rather than a web origin.
That is deliberate and not an oversight: the web client reaches the API through
Vercel's same-origin `/api/*` rewrite, which is proxied server-side, so the
browser never issues a cross-origin request; and React Native does not enforce
CORS. Add a web origin here only if something ever calls this API cross-origin
from a browser.

`FRONTEND_URL` is deliberately left unset until the web client has a public
origin. Its only consumer is the Gmail OAuth return link
(`backend/routers/gmail.py`), which would otherwise send users to
`http://localhost:5500`. Gmail import stays off until it and the Google console
redirect URI agree.

## Background jobs

`ENABLE_SCHEDULER` is off by default and **exactly one process may ever turn it
on**. The jobs are not all idempotent — the WhatsApp jobs send real messages —
so two replicas with the scheduler enabled means every user gets every reminder
twice, and Daily AI Insights generate twice.

Two safe shapes:

1. **Single instance.** Keep the API at one replica and set
   `ENABLE_SCHEDULER=true` on it.
2. **Dedicated worker (preferred once the API scales).** Add a second Railway
   service from the same repo and image, set `ENABLE_SCHEDULER=true` on the
   worker and `false` on the API. The worker needs the same `DATABASE_URL` and
   the integration keys for the jobs it runs.

Jobs covered: Daily AI Insights, weekly/monthly reports, WhatsApp bill
reminders and daily summaries, Gmail sync, budget alerts, upcoming payments.

## Clients

### Web (Vercel)

`twin-app/js/config.js` resolves the API base in this order: `window.__API_BASE`
-> `<meta name="moneykal-api-base">` -> same-origin `/api` on https -> localhost.
On Vercel it lands on the third rule, so the only thing to configure is the
rewrite in `vercel.json`:

```json
{ "source": "/api/:path*", "destination": "https://moneykal-api-production.up.railway.app/:path*" }
```

That rewrite is already pointed at the live Railway domain. Same-origin also
means the browser never makes a cross-origin request, so CORS is not on the
critical path for the web client.

### Mobile (EAS)

`mobile/app.config.ts` reads `EXPO_PUBLIC_API_URL` into `extra.apiUrl`, and
`mobile/src/config/env.ts` uses it. For the `production` profile
`API_URL_OVERRIDE_SUPPORTED` is false, so **the baked value is the only backend
a production build can reach** — it cannot be re-pointed from Settings.

It is already set in `mobile/eas.json` under `build.production.env` and
`build.preview.env` to the live Railway domain. A public API URL is safe to
ship in a client; no backend secret ever goes into the app.

## Render

`render.yaml` is left in place and still works. It is not used by Railway and
the two do not conflict. Railway reads `railway.toml`; Render reads
`render.yaml`.

## After deploying

```bash
curl https://moneykal-api-production.up.railway.app/health        # {"status":"ok",...}
```

Then check, in the Railway logs, that the pre-deploy step reported
`alembic upgrade head` finishing, and that startup shows no
`DATABASE_URL is not set` or `JWT_SECRET is not set` error — both are raised
deliberately at boot rather than failing later on a request.
