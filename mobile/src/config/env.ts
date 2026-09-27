import Constants from 'expo-constants';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Where the backend lives.
 *
 * The web client hardcodes `http://127.0.0.1:8000` (twin-app/js/api.js). That
 * value is meaningless on a phone: loopback on a device is the device itself,
 * and on the Android emulator the host machine is reachable only at 10.0.2.2.
 * So the URL is resolved here, in this order:
 *
 *   1. EXPO_PUBLIC_API_URL — an explicit override. Always wins. This is what
 *      you set for a staging or production build.
 *   2. The Expo dev server's own host. When you run `npx expo start`, the
 *      packager URL already contains the dev machine's LAN IP — the same
 *      address the phone just downloaded the bundle from, so it is reachable
 *      by definition. Swapping the port for the API's gives the right URL on
 *      a physical device with nothing to configure.
 *   3. A per-platform localhost fallback, for the emulator/simulator case
 *      where no dev-server host is exposed.
 */

const extra: Record<string, unknown> = Constants.expoConfig?.extra ?? {};

/**
 * Read one `extra` value as a string, whatever it actually turns out to be.
 *
 * `extra` crosses a JSON serialisation boundary between app.config.ts and
 * expo-constants, and what comes out the other side is not always what went
 * in — a `null` arrives as `{}`, which is truthy and has no string methods.
 * Trusting the declared type here cost a crash at module scope, which on web
 * meant a blank page rather than an error anyone could act on. So this reads
 * defensively and returns '' for anything that is not a string.
 */
function extraString(key: string): string {
  const value = extra[key];
  return typeof value === 'string' ? value.trim() : '';
}

const API_PORT = extraString('apiPort') || '8000';

/** The configured override, or '' when none was set. */
const CONFIGURED_API_URL = extraString('apiUrl');

/** The `host:port` Expo served this bundle from, e.g. "192.168.1.7:8081". */
function devServerHost(): string | null {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // Older/other runtimes surface it here instead.
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)?.debuggerHost ??
    null;
  if (!hostUri) return null;
  const host = hostUri.split(':')[0]?.trim();
  return host && host.length > 0 ? host : null;
}

function fallbackHost(): string {
  // 10.0.2.2 is the Android emulator's alias for the host machine's loopback.
  // The iOS simulator shares the host's network stack, so localhost is right
  // there. Neither is correct on a physical device — that is what rule 2 is
  // for, and this is only ever reached when the dev-server host is unknown.
  return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
}

function resolveApiUrl(): string {
  if (CONFIGURED_API_URL) return CONFIGURED_API_URL.replace(/\/+$/, '');

  const host = devServerHost() ?? fallbackHost();
  return `http://${host}:${API_PORT}`;
}

/** What the build was compiled to talk to, before any on-device override. */
export const DEFAULT_API_BASE_URL = resolveApiUrl();

/** True when the default was derived rather than configured — surfaced in
 *  Settings so "why can't it reach the server" is answerable without reading
 *  code. */
export const API_URL_IS_DERIVED = !CONFIGURED_API_URL;

/**
 * True when the derived host is loopback — i.e. `adb reverse`.
 *
 * This is the USB case, and it is worth naming because it produces the single
 * most confusing failure this app has. `npx expo run:android --device` sets up
 * ONE reverse tunnel, `adb reverse tcp:8081 tcp:8081`, so the phone can reach
 * Metro. Expo then reports its own `hostUri` as `127.0.0.1:8081`, rule 2 above
 * takes the host from it, and the API URL becomes `http://127.0.0.1:8000`.
 *
 * That address is *correct* — but only if port 8000 is tunnelled too, and
 * nothing does that automatically. Without it, every request in the app fails
 * against the phone's own loopback, and the symptom is not "wrong address": it
 * is a screen that looks blank or stuck while each query returns a network
 * error.
 *
 * The fix is one command, which `npm run android` now runs for you:
 *
 *     adb reverse tcp:8000 tcp:8000
 *
 * Settings shows this when the probe fails against a loopback host, so the
 * answer is on screen rather than in this comment.
 */
export const API_HOST_IS_LOOPBACK =
  API_URL_IS_DERIVED && /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(DEFAULT_API_BASE_URL);

/** The command that fixes a loopback API host. Shown verbatim in Settings. */
export const ADB_REVERSE_HINT = `adb reverse tcp:${API_PORT} tcp:${API_PORT}`;

/* ------------------------------------------------- on-device override ----
   A LAN address baked into an APK stops being true the moment the machine
   moves to another network — a different Wi-Fi, a phone hotspot, a tunnel —
   and every one of those changes would otherwise mean a fresh ~15-minute EAS
   build just to edit one string. So the base URL can be re-pointed from
   Settings at runtime and is remembered on the device.

   This is deliberately NOT available in production builds. A switch that
   redirects every authenticated request, bearer token included, to an
   arbitrary host is a genuine attack surface: anyone who could get a user to
   paste a URL would receive their session. `easBuildProfile` comes from
   app.config.ts, so development and preview builds get the convenience and a
   store build does not. */

const API_OVERRIDE_KEY = 'moneykal_api_base_url';

/** The EAS profile this build came from ('' for a local dev run). */
export const BUILD_PROFILE = extraString('easBuildProfile');

export const API_URL_OVERRIDE_SUPPORTED = BUILD_PROFILE !== 'production';

let overrideUrl: string | null = null;

/**
 * Accepts what someone would actually type.
 *
 * A bare `192.168.43.1:8000` gets the scheme it obviously meant, trailing
 * slashes go, and anything that is not http(s) is rejected rather than being
 * silently turned into a request that fails later with a confusing message.
 * Returns null when the input cannot be made into a usable base URL.
 */
export function normalizeApiUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const cleaned = withScheme.replace(/\/+$/, '');

  // Matched with a regex rather than `new URL()` on purpose: React Native ships
  // its own URL polyfill, and it does not reliably throw on malformed input, so
  // a try/catch around `new URL()` would accept nonsense here and fail later as
  // an unexplained network error. IPv6 literals are not accepted — a dev
  // pointing a phone at a laptop is typing an IPv4 address or a hostname.
  if (!/^https?:\/\/[a-z0-9._-]+(:\d{1,5})?(\/[^\s]*)?$/i.test(cleaned)) return null;

  return cleaned;
}

/** The address the API client should use right now.
 *
 *  Precedence: the user's explicit override, then whatever auto-discovery
 *  settled on, then the address this build was compiled with. */
export function getApiBaseUrl(): string {
  return overrideUrl ?? discoveredUrl ?? DEFAULT_API_BASE_URL;
}

/** The override, or null when the build default is in use. */
export function getApiBaseUrlOverride(): string | null {
  return overrideUrl;
}

/**
 * Restores a saved override. Called once during the auth bootstrap, before
 * any screen is mounted, so no request can go out against the wrong host.
 */
export async function loadApiBaseUrlOverride(): Promise<void> {
  if (!API_URL_OVERRIDE_SUPPORTED) return;
  try {
    const stored = await SecureStore.getItemAsync(API_OVERRIDE_KEY);
    overrideUrl = stored ? normalizeApiUrl(stored) : null;
  } catch {
    // Unreadable store, or the empty web stub — fall back to the build default.
    overrideUrl = null;
  }
}

/* ==========================================================================
 * Auto-discovery
 * ========================================================================== */

/**
 * The address the app *settled* on after probing, when probing found one.
 *
 * Separate from `overrideUrl` on purpose: an override is the user's explicit
 * choice and must survive a network change, while this is a guess the app
 * made and is free to re-make. `getApiBaseUrl()` prefers the override, then
 * this, then the build default.
 */
let discoveredUrl: string | null = null;

/**
 * Every address worth trying, best first, de-duplicated.
 *
 * The order encodes what is most likely to be true during development:
 *
 *   1. the baked EXPO_PUBLIC_API_URL — someone chose it deliberately
 *   2. loopback — correct whenever `adb reverse tcp:8000` is up, which is the
 *      USB case and the only one that keeps working when the phone and the
 *      computer are on different Wi-Fi networks
 *   3. the Expo dev-server host — the LAN address the bundle came from, so
 *      reachable by definition when Metro is being used over Wi-Fi
 *   4. the platform fallback — emulator only
 */
function candidateApiUrls(): string[] {
  const out: string[] = [];
  const push = (url: string) => {
    const clean = url.replace(/\/+$/, '');
    if (clean && !out.includes(clean)) out.push(clean);
  };

  if (CONFIGURED_API_URL) push(CONFIGURED_API_URL);
  push(`http://127.0.0.1:${API_PORT}`);
  const host = devServerHost();
  if (host) push(`http://${host}:${API_PORT}`);
  push(`http://${fallbackHost()}:${API_PORT}`);

  return out;
}

/** One quick reachability probe. Resolves to the URL on success, else null. */
async function probe(url: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}/health`, { signal: controller.signal });
    return res.ok ? url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find a backend this device can actually reach.
 *
 * WHY THIS EXISTS. The base URL used to be a single value decided once, at
 * build time or from the dev-server host. Both go stale the moment anything
 * about the network changes — the laptop joins a different Wi-Fi, the phone
 * is on mobile data, the APK was built on another network — and the symptom
 * is every screen in the app failing identically with no hint as to why. It
 * happened twice in one session on the same device.
 *
 * So instead of trusting one address, the app asks: which of these answers?
 * All candidates are probed in parallel and the first healthy one wins.
 *
 * Deliberately limited:
 *   - An explicit user override always wins and is never probed away.
 *   - It only runs where the override is already allowed, i.e. NOT in
 *     production builds. A shipped app talks to exactly one host that it was
 *     configured with; probing a list would be both pointless and a way to
 *     end up somewhere unintended.
 *   - It never invents a host. Every candidate is one the app would already
 *     have used under the old single-value rules.
 *
 * Failure is not an error: if nothing answers the build default stands, and
 * the existing "Can't reach MoneyKal at <address>" state explains itself.
 */
export async function discoverApiBaseUrl(timeoutMs = 2500): Promise<string> {
  if (!API_URL_OVERRIDE_SUPPORTED) return getApiBaseUrl();
  // An explicit choice is not second-guessed.
  if (overrideUrl) return overrideUrl;

  const candidates = candidateApiUrls();
  if (candidates.length <= 1) return getApiBaseUrl();

  const winner = await new Promise<string | null>((resolve) => {
    let outstanding = candidates.length;
    let settled = false;

    candidates.forEach((url) => {
      void probe(url, timeoutMs).then((ok) => {
        if (settled) return;
        if (ok) {
          settled = true;
          resolve(ok);
          return;
        }
        outstanding -= 1;
        if (outstanding === 0) resolve(null);
      });
    });
  });

  if (winner) discoveredUrl = winner;
  return getApiBaseUrl();
}

/** What discovery settled on, or null when it did not run or found nothing. */
export function getDiscoveredApiBaseUrl(): string | null {
  return discoveredUrl;
}

/**
 * Points the app at a different backend, or clears the override with null.
 * Returns the address now in effect so the caller can show it.
 */
export async function setApiBaseUrlOverride(input: string | null): Promise<string> {
  if (!API_URL_OVERRIDE_SUPPORTED) return getApiBaseUrl();

  const next = input === null ? null : normalizeApiUrl(input);
  overrideUrl = next;
  // A fresh explicit choice retires the guess; clearing one lets the next
  // discovery run decide again rather than resurrecting a stale winner.
  discoveredUrl = null;
  try {
    if (next) await SecureStore.setItemAsync(API_OVERRIDE_KEY, next);
    else await SecureStore.deleteItemAsync(API_OVERRIDE_KEY);
  } catch {
    // Persistence is a convenience; the in-memory value still applies for this
    // session, which is what the user just asked for.
  }
  return getApiBaseUrl();
}

/** Custom scheme for deep links. Must match `scheme` in app.config.ts and
 *  MOBILE_REDIRECT_SCHEME in the backend's .env. */
export const APP_SCHEME = 'moneykal';

/** How long to wait on a request before giving up. Ask Twin runs a multi-agent
 *  pipeline plus live market lookups, so it gets its own, longer budget. */
export const REQUEST_TIMEOUT_MS = 20_000;
export const AI_REQUEST_TIMEOUT_MS = 90_000;
