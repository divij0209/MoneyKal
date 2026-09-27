import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/**
 * The MoneyKal passcode — a six-digit lock on app access.
 *
 * WHAT THIS IS, PRECISELY
 * ----------------------
 * This is a privacy / app-access lock, not a cryptographic boundary. It stops
 * someone who picks up an unlocked phone from reading the owner's finances. It
 * does *not* protect the bearer token: anyone who can read SecureStore already
 * has the session and can call the API directly without going near this screen.
 * The passcode is deliberately not part of API authentication, and account
 * password auth and JWT semantics are untouched.
 *
 * Everything here is on-device and works offline. Nothing is sent to the
 * backend, and no schema exists for it.
 *
 * THE VERIFIER
 * ------------
 * Only a verifier is stored — never the digits. A 16-byte random salt is
 * generated per passcode, and the stored value is
 *
 *     H_n(salt || pin)   where H is SHA-256 applied ITERATIONS times
 *
 * Two honest limits, stated here so nobody mistakes this for more than it is:
 *
 *  - `expo-crypto` exposes SHA-256 and secure random, but no PBKDF2/scrypt.
 *    Each `digestStringAsync` is a native round trip, so a real KDF's hundreds
 *    of thousands of rounds would take minutes on the JS bridge. ITERATIONS is
 *    therefore set to a value that keeps unlock responsive while still costing
 *    an attacker that many hashes per guess.
 *  - A six-digit PIN has 10^6 possibilities. Against someone who has extracted
 *    the salt and verifier from the keystore and can hash offline, this buys
 *    time, not safety. What actually deters guessing *on the device* is the
 *    attempt limiter below, and ultimately the wipe.
 */

/**
 * Whether this platform can hold a passcode at all.
 *
 * `expo-secure-store` has no web build — it ships an empty stub whose every
 * call throws — so on web there is nowhere to keep a verifier, and a lock that
 * lives only in JavaScript on a page the user can open devtools on would be
 * theatre. This is a mobile lock, as decided, and web has none.
 *
 * It matters that every entry point checks this rather than relying on
 * `hasPasscode()` returning false: web *can* reach a signed-in state, because
 * `saveSession` deliberately tolerates the same storage failure. Without this
 * flag a web user would be routed to "create your passcode" and stranded
 * there, since the save behind that screen can only ever throw.
 */
export const LOCK_SUPPORTED = Platform.OS !== 'web';

const VERIFIER_KEY = 'moneykal_passcode_v1';
const ATTEMPTS_KEY = 'moneykal_passcode_attempts_v1';

/** Six digits, matching the product decision. */
export const PASSCODE_LENGTH = 6;

/**
 * Rounds of SHA-256 over the salted PIN.
 *
 * Each round is a bridge call, so this trades unlock latency for guessing cost
 * roughly linearly. 256 keeps a verification well inside a few hundred
 * milliseconds on a mid-range phone while making a brute-force pass 256x more
 * expensive than a bare digest. Raising it is safe and backwards-compatible
 * only if the stored record's own `iterations` is honoured on verify — which
 * is why it is written into the record rather than assumed.
 */
const ITERATIONS = 256;

interface PasscodeRecord {
  /** Hex-encoded 16-byte salt, unique per passcode. */
  salt: string;
  /** Hex digest after `iterations` rounds. */
  verifier: string;
  iterations: number;
  /** Set when the user opts into biometric unlock. */
  biometricEnabled: boolean;
  createdAt: string;
}

export interface AttemptState {
  /** Consecutive failures since the last success. */
  failed: number;
  /** Epoch ms until which entry is refused, or 0. */
  lockedUntil: number;
}

const NO_ATTEMPTS: AttemptState = { failed: 0, lockedUntil: 0 };

/* --------------------------------------------------------------- helpers -- */

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Iterated SHA-256. Each round hashes the previous digest with the salt, so a
 * precomputed table for one salt is useless against another.
 */
async function derive(pin: string, salt: string, iterations: number): Promise<string> {
  let acc = `${salt}:${pin}`;
  for (let i = 0; i < iterations; i++) {
    acc = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, acc);
  }
  return acc;
}

/**
 * Constant-time-ish comparison.
 *
 * JavaScript cannot promise constant time, but comparing every character and
 * accumulating differences avoids the trivial early-exit leak that `===` on
 * strings can have. The values are equal-length hex digests, so length is not
 * secret.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readRecord(): Promise<PasscodeRecord | null> {
  try {
    const raw = await SecureStore.getItemAsync(VERIFIER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PasscodeRecord>;
    if (!parsed?.salt || !parsed?.verifier) return null;
    return {
      salt: parsed.salt,
      verifier: parsed.verifier,
      iterations: typeof parsed.iterations === 'number' ? parsed.iterations : ITERATIONS,
      biometricEnabled: !!parsed.biometricEnabled,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
    };
  } catch {
    // Unreadable keystore is treated as "no passcode" rather than a crash. The
    // session itself lives behind the same store, so this state is already a
    // signed-out-ish one.
    return null;
  }
}

/* ----------------------------------------------------------------- API --- */

export async function hasPasscode(): Promise<boolean> {
  if (!LOCK_SUPPORTED) return false;
  return (await readRecord()) !== null;
}

export async function isBiometricEnabled(): Promise<boolean> {
  return (await readRecord())?.biometricEnabled ?? false;
}

/** True only for exactly six digits — no spaces, no letters. */
export function isValidPasscode(pin: string): boolean {
  return new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(pin);
}

/**
 * Rejects the handful of sequences that make a six-digit lock pointless.
 * Deliberately small: a long blocklist trains users to pick the next-worst
 * thing rather than a good one.
 */
export function weakPasscodeReason(pin: string): string | null {
  if (/^(\d)\1{5}$/.test(pin)) return 'Six identical digits is too easy to guess.';
  const asc = '0123456789';
  const desc = '9876543210';
  if (asc.includes(pin) || desc.includes(pin)) return 'A run of consecutive digits is too easy to guess.';
  return null;
}

/** Creates or replaces the passcode. A fresh salt is generated every time. */
export async function setPasscode(pin: string, biometricEnabled = false): Promise<void> {
  const salt = toHex(await Crypto.getRandomBytesAsync(16));
  const record: PasscodeRecord = {
    salt,
    verifier: await derive(pin, salt, ITERATIONS),
    iterations: ITERATIONS,
    biometricEnabled,
    createdAt: new Date().toISOString(),
  };
  await SecureStore.setItemAsync(VERIFIER_KEY, JSON.stringify(record));
  await resetAttempts();
}

export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  const record = await readRecord();
  if (!record) return;
  await SecureStore.setItemAsync(
    VERIFIER_KEY,
    JSON.stringify({ ...record, biometricEnabled: enabled }),
  );
}

/** Removes the passcode entirely — used by "forgot" before setting a new one. */
export async function clearPasscode(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(VERIFIER_KEY);
  } catch {
    /* Already gone. */
  }
  await resetAttempts();
}

/* ------------------------------------------------- attempts and lockout -- */

/**
 * Progressive lockout after five consecutive failures.
 *
 * Index is (failures - THRESHOLD): 30s, 1m, 5m, 15m, then 15m thereafter.
 * The counter lives in SecureStore, which means an attacker who can already
 * read the keystore can also reset it — the same attacker this lock does not
 * claim to stop. It is aimed at someone holding the phone, and for that it
 * works: five tries then a wait, escalating to a wipe.
 */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_STEPS_MS = [30_000, 60_000, 5 * 60_000, 15 * 60_000];

/** After this many consecutive failures the session is cleared and the user
 *  must sign in with their account password again. */
export const WIPE_AFTER_FAILURES = 10;

export async function getAttempts(): Promise<AttemptState> {
  try {
    const raw = await SecureStore.getItemAsync(ATTEMPTS_KEY);
    if (!raw) return { ...NO_ATTEMPTS };
    const parsed = JSON.parse(raw) as Partial<AttemptState>;
    return {
      failed: typeof parsed.failed === 'number' ? parsed.failed : 0,
      lockedUntil: typeof parsed.lockedUntil === 'number' ? parsed.lockedUntil : 0,
    };
  } catch {
    return { ...NO_ATTEMPTS };
  }
}

async function writeAttempts(state: AttemptState): Promise<void> {
  try {
    await SecureStore.setItemAsync(ATTEMPTS_KEY, JSON.stringify(state));
  } catch {
    /* Non-fatal: the limiter degrades, the passcode still gates entry. */
  }
}

export async function resetAttempts(): Promise<void> {
  await writeAttempts({ ...NO_ATTEMPTS });
}

/** Milliseconds still to wait, or 0. */
export function remainingLockout(state: AttemptState, now = Date.now()): number {
  return state.lockedUntil > now ? state.lockedUntil - now : 0;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'no_passcode' }
  | { ok: false; reason: 'locked_out'; remainingMs: number }
  | { ok: false; reason: 'wrong'; failed: number; remainingMs: number; shouldWipe: boolean };

/**
 * Checks a passcode and updates the attempt state.
 *
 * Returns rather than throws, because every outcome here is an expected user
 * state the lock screen has to render differently.
 */
export async function verifyPasscode(pin: string): Promise<VerifyResult> {
  const record = await readRecord();
  if (!record) return { ok: false, reason: 'no_passcode' };

  const attempts = await getAttempts();
  const waiting = remainingLockout(attempts);
  if (waiting > 0) return { ok: false, reason: 'locked_out', remainingMs: waiting };

  const candidate = await derive(pin, record.salt, record.iterations);

  if (timingSafeEqual(candidate, record.verifier)) {
    await resetAttempts();
    return { ok: true };
  }

  const failed = attempts.failed + 1;
  let lockedUntil = 0;
  if (failed >= LOCKOUT_THRESHOLD) {
    const step = Math.min(failed - LOCKOUT_THRESHOLD, LOCKOUT_STEPS_MS.length - 1);
    lockedUntil = Date.now() + LOCKOUT_STEPS_MS[step];
  }
  await writeAttempts({ failed, lockedUntil });

  return {
    ok: false,
    reason: 'wrong',
    failed,
    remainingMs: lockedUntil > 0 ? lockedUntil - Date.now() : 0,
    shouldWipe: failed >= WIPE_AFTER_FAILURES,
  };
}

/** Attempts left before the next lockout kicks in. */
export function attemptsRemaining(failed: number): number {
  return Math.max(0, LOCKOUT_THRESHOLD - failed);
}

/** "30 seconds" / "5 minutes" — for the lockout message. */
export function formatLockout(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.ceil(secs / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}
