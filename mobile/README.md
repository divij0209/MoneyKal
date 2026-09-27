# MoneyKal — Mobile

A native React Native (Expo, TypeScript) client for the **existing** MoneyKal
backend. It is not a second product and not a WebView wrapper: it talks to the
same FastAPI app in `../backend`, the same database, the same authentication and
the same AI agents that `../twin-app` uses.

Nothing in `../backend` or `../twin-app` needs to change for this app to run,
beyond the additive backend endpoints listed at the bottom of this file.

## Status

**Phase 2 in progress.** The foundation is complete and the Individual Home
screen is built against the live API. The remaining feature screens are routed
but not yet implemented — each shows what it will contain and which endpoints
it reads.

| Working | Pending |
| --- | --- |
| Splash → Auth → Onboarding → Persona app routing | Hisaab + receipt scan |
| Login, Register, session persistence, token refresh | Ask Twin / TATHYA, VARTA |
| Individual and Startup bottom tab bars | Simulate, Reports, Alerts |
| Theme system (light/dark/system), design tokens | live.life.fully |
| Settings with connection diagnostics | Startup Overview |
| Shared component library | Onboarding wizard forms |
| **Individual Home — the full Daily Home** | Edit profile |
| Market Pulse | |

## Running it

### 1. Start the backend, reachable from your phone

The web client hardcodes `127.0.0.1`, which a phone cannot reach. Bind to all
interfaces instead — from the **repository root**:

```bash
# Windows PowerShell
$env:PYTHONPATH="."
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000

# macOS / Linux
PYTHONPATH="." python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` is the only change from the documented command. Confirm it
worked by opening `http://<your-LAN-IP>:8000/health` on your phone's browser.

> **Windows Firewall** will usually prompt the first time. Allow Python on
> *private* networks. If you dismissed it, add an inbound rule for TCP 8000.

### 2. Start the app

```bash
cd mobile
npm install     # first time only
npm start
```

### 3. Open it on Android

**Physical device (recommended — no Android SDK needed):**

1. Install **Expo Go** from the Play Store.
2. Put the phone on the **same Wi-Fi** as your computer.
3. Scan the QR code in the terminal.

No configuration is needed. The app derives the API address from the Expo dev
server it loaded from, which is your machine's LAN IP by definition — see
`src/config/env.ts`.

**Android emulator** (needs Android Studio installed):

```bash
# .env in mobile/ — the emulator reaches the host at 10.0.2.2, not localhost
EXPO_PUBLIC_API_URL=http://10.0.2.2:8000
```

then `npm run android`.

### 4. Check the connection

If a screen can't load, open **More → Settings → MoneyKal API**. It shows the
address the app resolved, whether it was auto-detected or configured, and a
**Test connection** button that pings `/health`. That distinguishes "phone is
offline", "wrong address" and "server is down", which otherwise look identical.

## Configuration

Copy `.env.example` to `.env`. Everything is optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_PUBLIC_API_URL` | auto-detected | Explicit backend URL. Always wins. |
| `EXPO_PUBLIC_API_PORT` | `8000` | Port used when the host is auto-detected. |

## Checks

```bash
npx tsc --noEmit                              # type check (strict)
npx expo export --platform android            # verify it bundles
```

## Layout

```
src/
  api/         HTTP client, endpoint modules, TS mirrors of the Pydantic schemas
  components/  The shared design system — primitives, feedback states
  config/      Environment and API host resolution
  features/    One folder per product area, matching the web's view boundaries
  navigation/  Root/auth/onboarding stacks, the two persona tab bars, deep links
  store/       Auth session, profile/persona, React Query client
  theme/       Design tokens ported from ../twin-app/css/app-theme.css
```

### Where things come from

This app reproduces the web client rather than reinventing it. The mapping:

| Mobile | Web source of truth |
| --- | --- |
| `src/theme/tokens.ts` | `twin-app/css/app-theme.css` — hex values are identical |
| `src/theme/typography.ts` | Outfit / Plus Jakarta Sans / IBM Plex Mono, as `styles.css` loads them |
| `src/navigation/TabIcon.tsx` | The sidebar SVG paths in `dashboard.html` |
| `src/navigation/types.ts` | The `titles` and `STARTUP_TITLES` maps in `js/app.js` and `js/startup.js` |
| `src/navigation/Tabs.tsx` | `applyPersonaNav()` gating in `js/startup.js` |
| `src/store/session.ts` | The `twin_session` shape in `js/auth.js`, moved to the OS keychain |
| `src/api/types.ts` | `backend/schemas/*.py` (and `GET /openapi.json`, which is the arbiter) |
| `src/features/home/*` | `twin-app/js/home.js` + the `/home` and `/home/calendar` routes |
| `src/components/icons/MoneyKalIcons.tsx` | the `ICONS`, `CATEGORY_MARKS` and category lists in `js/home.js` |

Business logic, financial calculations, currency formatting and AI responses all
stay on the server. Where the API returns a `*_display` string, the app renders
that string rather than formatting a number itself.

### Persona gating

Which tabs each persona sees is copied from the web, not invented:

- **Individual** — Home, Hisaab, Ask Twin, Simulate, More
  (More holds Reports, Agent team, About, Market Pulse, live.life.fully, Settings)
- **Startup** — Overview, Ask Twin, Simulate, Alerts, Reports
  (Settings via the account button in the header)

Note that **Hisaab, and with it the Gmail auto-import UI, is Individual-only on
the web today** — `applyPersonaNav()` hides the nav item for founders and
`syncPreviewsToNav()` hides the matching Overview cards, even though the backend
serves `/startup/hisaab` for both personas. That gating is reproduced as-is.
It may be unintentional on the web; changing it is a product decision, not a
port, so it has been flagged rather than silently "fixed".

## Backend changes this app depends on

All additive and backwards-compatible. `twin-app/` is byte-for-byte unmodified.

| Change | File |
| --- | --- |
| `GET /health` — reachability probe | `backend/main.py` |
| `POST /auth/refresh` + `refresh_token` in login/register responses | `backend/routers/auth.py` |
| `POST /gmail/oauth-ticket` — short-lived OAuth handoff | `backend/routers/gmail.py` |
| `moneykal://` deep-link return for mobile OAuth; signed `state` | `backend/routers/gmail.py` |
| Auth required on `/hisaab/scan-receipt` and `/twin/tts` | `backend/routers/hisaab.py`, `routers/twin.py` |
| Token helpers for the above | `backend/core/auth.py` |

Optional `.env` addition (defaults to `moneykal` if absent):

```
MOBILE_REDIRECT_SCHEME=moneykal
```

## Known limits

- **Not yet run on a device by the author** — this machine has no Android SDK.
  Verified by type check, a production Android bundle, a full Metro compile and
  an HTTP contract test against the running backend.
- **Expo Go is enough for the foundation.** The camera receipt scan still wants
  a development build. VARTA no longer does: it records with `expo-audio`, an
  SDK module that ships inside Expo Go, and transcribes on the server via
  `POST /twin/stt` rather than through a third-party native recogniser. The
  microphone itself still has to be exercised on a real device — neither
  simulator gives reliable mic input.
- **Refresh is a sliding window, not revocation.** A new refresh token is issued
  on each use, but the previous one stays valid until it expires — stateless
  JWTs have nothing to revoke against. See `create_refresh_token()`.
