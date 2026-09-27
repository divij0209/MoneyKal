# Supabase — the shared development database

Every developer runs their own backend on their own machine, and all of them
talk to one Supabase PostgreSQL database:

```
Developer A -> local backend (uvicorn :8000) -\
Developer B -> local backend (uvicorn :8000) --> Supabase development database
Developer C -> local backend (uvicorn :8000) -/
```

Nothing else changes. The backend still connects to PostgreSQL with SQLAlchemy
and psycopg2, migrations are still Alembic, and no API route, response shape or
frontend file is different. Supabase *is* PostgreSQL; the move is a connection
string plus the guard rails that make one database safe to share.

**The frontends never talk to Supabase.** `twin-app` and `mobile` call this
backend over HTTP exactly as before. No Supabase key of any kind — anon,
publishable or service-role — is shipped to a client.

---

## Contents

1. [Create and configure the Supabase project](#1-create-and-configure-the-supabase-project) *(one person, once)*
2. [Run the database migrations](#2-run-the-database-migrations) *(one person, once)*
3. [Import the existing local data](#3-import-the-existing-local-data) *(one person, once)*
4. [Configure `.env`](#4-configure-your-env) *(every developer)*
5. [Run the project locally](#5-run-the-project-locally) *(every developer)*
6. [Changing the schema later](#6-changing-the-schema-later) *(read before you touch a model)*
7. [Rolling back](#7-rolling-back)

Steps 1–3 are done **once, by one person**. Everyone else starts at step 4.

---

## 1. Create and configure the Supabase project

1. Sign in at <https://supabase.com/dashboard> and choose **New project**.
   - **Name**: `moneykal-dev` — the name should say it is the development
     database, because one day there will be a second one that is not.
   - **Region**: pick the one nearest the team. This app is India-facing
     (rupee amounts, GST numbers, NSE tickers), so `ap-south-1` (Mumbai) is
     usually the right answer. Every query pays this latency, so it is worth
     thirty seconds of thought.
   - **Database password**: generate a strong one. Put it in the team password
     manager immediately — Supabase will not show it again, and every
     developer needs it. Avoid `@ : / ? #` if you can; if the generated
     password contains them, see the percent-encoding note in step 4.

2. Wait for provisioning (a minute or two), then open **Connect** in the top
   bar and select the **Session pooler** tab. Copy that URI. It looks like:

   ```
   postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
   ```

   **Use the Session pooler, not the other two.** This matters more than it
   looks:

   | Option | Port | Why not |
   |---|---|---|
   | Direct connection | 5432 | IPv6-only on the free plan. On most home and office networks it simply times out, with no useful error. |
   | Transaction pooler | 6543 | No prepared statements and no session-level state, so Alembic migrations fail partway through. |
   | **Session pooler** | **5432** | **IPv4, full session semantics. Use this.** |

3. **Close the Data API over our tables.** Supabase publishes the `public`
   schema through PostgREST, and its default privileges hand the `anon` role —
   whose key is designed to be public — access to tables created there. Our
   tables hold bcrypt password hashes and Gmail OAuth refresh tokens.

   Go to **Settings → API → Exposed schemas** and remove `public`, leaving the
   list empty (or set to a schema we do not use).

   Migration `f1a9c3e7b204` independently enables row-level security on all 39
   tables and revokes the `anon`/`authenticated` grants, so you are covered
   twice. Do both anyway: this is the one part of the setup where a mistake is
   silent and expensive. Our backend is unaffected either way — it connects as
   the table owner, and an owner bypasses RLS.

4. Share with the team, through the password manager and **never** in chat or
   a committed file: the project ref, the region, and the database password.

---

## 2. Run the database migrations

One person, once, from the project root, with the Supabase URI already in
`backend/.env` (step 4):

```bash
# Windows PowerShell
$env:PYTHONPATH="."
python -m alembic upgrade head

# macOS / Linux
PYTHONPATH="." python -m alembic upgrade head
```

This builds all 40 tables (39 application tables plus `alembic_version`), every
index, every foreign key, and enables row-level security. Confirm:

```bash
python -m alembic current   # -> f1a9c3e7b204 (head)
python -m alembic check     # -> No new upgrade operations detected.
```

`alembic check` reporting no operations is the real proof: it means the schema
Supabase now has is exactly the schema the models describe.

> **Do not use `migrate.py` or `create_all` for this.** `migrate.py` now refuses
> to run against a remote database, and the backend no longer creates tables on
> startup. Section 6 explains why.

---

## 3. Import the existing local data

Still one person, once — the person whose local database is the one worth
keeping.

**Take a backup first.** It is also the rollback artifact:

```bash
# Windows — pg_dump ships with PostgreSQL but is usually not on PATH
& "C:\Program Files\PostgreSQL\18\bin\pg_dump.exe" `
    -h localhost -p 5432 -U postgres -d zenith `
    -Fc --no-owner --no-privileges -f backups/zenith-before-supabase.dump
```

`backups/` is gitignored — that dump contains password hashes and live OAuth
refresh tokens, so keep it off shared drives and out of chat.

Then set both URLs in `backend/.env`:

```ini
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
MIGRATION_SOURCE_URL=postgresql://postgres:<local-password>@localhost:5432/zenith
```

And run:

```bash
python scripts/migrate_to_supabase.py check    # shows both sides, changes nothing
python scripts/migrate_to_supabase.py copy     # copies, then resets id sequences
python scripts/migrate_to_supabase.py verify   # row-count parity, per table
```

`copy` walks the tables in foreign-key dependency order, so parents always land
before children, and it **refuses to run against a target that already holds
data** — pass `--force` only if you genuinely mean to add to an already-
populated database.

Resetting the id sequences is not optional and `copy` does it for you. Rows
arrive with their original primary keys while the sequences still sit at 1, so
without it the next row the app inserts collides with an existing key — as a
500 on someone's sign-up, not as an error here.

### What is deliberately left behind

| Not migrated | Why |
|---|---|
| The `evolution` schema (37 tables, ~28k rows) | Belongs to the self-hosted Evolution API (WhatsApp), managed by its own Prisma migrations. This backend reaches it over HTTP, never over SQL. It also holds a device-bound WhatsApp session that several developers must not share. |
| `backend/data/chroma_db/` | Local RAG vector store. Rebuild with `python backend/scripts/ingest_knowledge.py`. |
| Redis on `localhost:6379` | Market-data cache with a working no-Redis fallback. |
| `error.log`, `oauth_debug.log` | Runtime logs. |

---

## 4. Configure your `.env`

Every developer does this on their own machine.

```bash
cp backend/.env.example backend/.env
```

Then edit `backend/.env`:

```ini
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=require
DB_APP_NAME=moneykal-yourname
```

- Get the ref, region and password from the team password manager.
- **Percent-encode special characters in the password.** `@` becomes `%40`,
  `#` becomes `%23`, `/` becomes `%2F`, `:` becomes `%3A`, `%` becomes `%25`.
  An unencoded `@` splits the URL in the wrong place and produces a confusing
  "could not translate host name" error.
- `DB_APP_NAME` is what Supabase shows next to your connection. With several
  developers on one database, an anonymous list of connections is useless.
- `sslmode=require` is added automatically for any non-local host, so you
  cannot accidentally send password hashes over an unencrypted connection.

`backend/.env` is gitignored and must stay that way. `backend/.env.example`
is the committed template and must never contain a real credential.

**Everything else in `.env` stays per-developer as it is today** — your own
`GROQ_API_KEY`, `GEMINI_API_KEY`, Gmail and Zoho OAuth clients, Vapi keys.
Only the database is shared.

### Required and optional variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | **yes** | Supabase session-pooler URI. No default any more — a missing value stops the backend with an explanation instead of silently falling back to a private SQLite file. |
| `JWT_SECRET` | **yes** | Must be **identical for every developer**, or tokens issued by one backend are rejected by another against the same shared user rows. Put it in the password manager. |
| `GROQ_API_KEY` / `GEMINI_API_KEY` | yes | Per developer. |
| `MIGRATION_SOURCE_URL` | migration only | The old local database. Read only by `scripts/migrate_to_supabase.py`; kept afterwards as the rollback target. |
| `DB_APP_NAME` | no | Defaults to `moneykal-<hostname>`. |
| `DB_AUTO_CREATE` | no | Default off; **refused** against a remote database. |
| `ENABLE_SCHEDULER` | no | Default off. See below. |
| `DB_POOL_SIZE`, `DB_MAX_OVERFLOW`, `DB_POOL_RECYCLE`, `DB_CONNECT_TIMEOUT`, `DB_ECHO` | no | Defaults 5 / 5 / 1800 / 10 / off. Keep the pools small: the connection budget is shared by the whole team. |

### Leave `ENABLE_SCHEDULER` off

The background jobs are now opt-in, and should stay off on developer machines.
They are not all idempotent: the daily metric snapshot is, but the WhatsApp
jobs send real messages to real people and the Gmail job scans real inboxes.
Three developers running them against one database means every user gets every
bill reminder three times. Run them on one designated machine only.

---

## 5. Run the project locally

Unchanged from before, except that the database is now in the cloud.

```bash
# Backend, from the project root
$env:PYTHONPATH="."                                  # PowerShell
uvicorn backend.main:app --reload --port 8000

# Frontend, in a second terminal
cd twin-app
python -m http.server 3000
```

Open <http://localhost:3000>. The API is on <http://localhost:8000>, docs at
`/docs`.

Check you are actually on Supabase:

```bash
python -c "from backend.database import describe_target; print(describe_target())"
# -> aws-0-ap-south-1.pooler.supabase.com:5432/postgres
```

**You no longer run `python migrate.py` after pulling.** Run this instead:

```bash
python -m alembic upgrade head
```

On the shared database that is usually a no-op, because whoever wrote the
migration already applied it. It is still the right habit: it is what makes a
teammate's schema change reach you.

---

## 6. Changing the schema later

This is the part that decides whether one shared database stays pleasant or
becomes a source of daily breakage.

### The rule

**Alembic owns the schema. Nothing else writes DDL to the shared database.**

Two things used to bypass it, and both are now closed:

- The backend called `Base.metadata.create_all()` on every start. Whoever
  started their backend first minted tables straight from their branch's
  models, with no migration recording it. It is now behind `DB_AUTO_CREATE`,
  default off, and **refused outright against a remote database**.
- `migrate.py` added missing columns by reading the models. Convenient on a
  private database, invisible schema drift on a shared one. It now refuses to
  run against a remote database and points you here.

That drift was not hypothetical. When this migration was written, the chain
could only build **22 of the schema's 39 tables** — all of Money Splits,
notifications and subscriptions existed solely because `create_all` had made
them on each developer's machine. Nobody noticed, because every existing
database was already ahead of the migrations. It surfaced the moment we pointed
Alembic at an empty database, which is exactly what a new teammate or a hosted
database is. Revision `1863a55d8be8` is the catch-up.

### Making a change

```bash
# 1. Start level. If this reports operations before you have changed anything,
#    stop and find out why — something has drifted.
python -m alembic check

# 2. Edit backend/models/domain.py.

# 3. Generate the revision.
python -m alembic revision --autogenerate -m "add whatever to wherever"

# 4. READ THE GENERATED FILE. Autogenerate is a first draft, not an answer.
#    Delete anything it proposes that you did not intend — a stray DROP is how
#    this codebase lost a table's history once already. Check especially:
#      - drops you did not ask for
#      - NOT NULL columns with no server_default on a table that has rows
#      - data that needs backfilling, which autogenerate never writes for you

# 5. Apply it to the shared database.
python -m alembic upgrade head

# 6. Commit the migration WITH the model change, in the same commit.
```

Step 6 is what keeps teammates working: a model change without its migration
is a broken pull for everyone else.

### Coordinating with teammates

- **Say so before you apply a migration** to the shared database. Everyone's
  running backend is talking to it.
- **Additive changes are safe** — a new nullable column, a new table. A
  teammate on older code simply does not use it.
- **Destructive changes need a two-step deploy.** To remove or rename a column:
  first ship the code that stops using it, let everyone pull, and only then
  ship the migration that drops it. A drop applied while a teammate's backend
  still selects that column takes their machine down instantly.
- **If two people generate a revision at the same time**, Alembic ends up with
  two heads and `upgrade head` fails with "Multiple head revisions". Fix it
  with a merge, never by editing someone else's `down_revision`:

  ```bash
  python -m alembic heads          # shows both
  python -m alembic merge -m "merge heads" <rev1> <rev2>
  python -m alembic upgrade head
  ```

- **New tables need RLS.** Migration `f1a9c3e7b204` locked down the 39 tables
  that existed when it ran; it does not reach into the future. Add this to any
  migration that creates a table:

  ```python
  op.execute("ALTER TABLE public.your_new_table ENABLE ROW LEVEL SECURITY")
  ```

  Belt and braces on top of removing `public` from the exposed schemas.

---

## 7. Rolling back

The old local PostgreSQL is untouched by any of this. It is still there, still
current, and still the fastest way back.

**To roll back, change one line** in `backend/.env`:

```ini
# DATABASE_URL=postgresql://postgres.<ref>:...@...pooler.supabase.com:5432/postgres
DATABASE_URL=postgresql://postgres:<local-password>@localhost:5432/zenith
```

Restart the backend. You are back on local PostgreSQL with all your data.

To restore a local database from the pre-migration backup:

```bash
& "C:\Program Files\PostgreSQL\18\bin\pg_restore.exe" `
    -h localhost -p 5432 -U postgres -d zenith `
    --clean --if-exists --no-owner --no-privileges `
    backups/zenith-before-supabase.dump
```

The code changes are independent of the destination: everything in this
migration works against local PostgreSQL and against Supabase, so rolling back
the database does **not** require rolling back the code. If you do want the
code back too, the schema guard rails are the only behavioural change, and
`DB_AUTO_CREATE=true` plus `ENABLE_SCHEDULER=true` restores the old defaults.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `DATABASE_URL is not set` on startup | No `backend/.env`, or the line is missing. The old silent SQLite fallback is gone on purpose. |
| `could not translate host name` | Unencoded special character in the password. `@` -> `%40`. |
| Connection hangs, then times out | You copied the **Direct connection** string. It is IPv6-only. Use the Session pooler. |
| Migration fails partway with a prepared-statement error | You copied the **Transaction pooler** (port 6543). Use the Session pooler (5432). |
| `SSL connection has been closed unexpectedly` | A stale pooled connection. `pool_pre_ping` should prevent it; if it persists, lower `DB_POOL_RECYCLE`. |
| `Multiple head revisions` | Two people generated revisions in parallel. `alembic merge` — see section 6. |
| `remaining connection slots are reserved` | Too many backends or pools too large. Lower `DB_POOL_SIZE`, and make sure nobody is running with `ENABLE_SCHEDULER=true` unintentionally. |
| Duplicate WhatsApp messages | More than one backend running with `ENABLE_SCHEDULER=true`. |
| `migrate.py` refuses to run | Working as intended against a shared database. Use Alembic — section 6. |
