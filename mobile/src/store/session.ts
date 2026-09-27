import * as SecureStore from 'expo-secure-store';

import type { AuthResponse } from '../api/types';

/**
 * Session persistence.
 *
 * The web keeps this in `localStorage` under `twin_session` (twin-app/js/auth.js).
 * On a phone that would put a seven-day bearer token in plainly readable
 * storage, so it goes to the OS keychain (iOS Keychain / Android Keystore)
 * instead. The *shape* is kept deliberately close to the web's so the mental
 * model transfers: token, userId, username, profileKey.
 *
 * SecureStore values are strings and capped in size, so the session is stored
 * as one JSON blob under a single key rather than as separate entries.
 */

const SESSION_KEY = 'moneykal_session';

export interface Session {
  token: string;
  refreshToken: string | null;
  userId: number;
  username: string;
  /** null means onboarding is incomplete — the same signal the web branches on. */
  profileKey: string | null;
}

export function sessionFromAuthResponse(res: AuthResponse): Session {
  return {
    token: res.access_token,
    refreshToken: res.refresh_token ?? null,
    userId: res.user_id,
    username: res.username,
    profileKey: res.profile_key,
  };
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    // A stored blob without a token is not a session. Guarding here means a
    // corrupt or half-written entry logs the user out cleanly instead of
    // producing requests with `Bearer undefined`.
    if (!parsed?.token || typeof parsed.token !== 'string') return null;
    return {
      token: parsed.token,
      refreshToken: parsed.refreshToken ?? null,
      userId: Number(parsed.userId ?? 0),
      username: String(parsed.username ?? ''),
      profileKey: parsed.profileKey ?? null,
    };
  } catch {
    // Unreadable keychain or malformed JSON — treat as signed out rather than
    // crashing the app on launch.
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  try {
    await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  } catch (err) {
    // Persistence is a convenience, not part of signing in. The session is
    // already held in memory by AuthContext by the time this runs, so a
    // storage failure must not turn a successful login into a failed one.
    //
    // This is reachable on Expo Web, where expo-secure-store's web build is an
    // empty stub (`export default {}`) and every call throws — which used to
    // surface as "Registration failed. Please try again." after the account had
    // in fact been created. On native the keychain is real and this path is for
    // genuine storage errors, where the cost is only that the user signs in
    // again next launch.
    if (__DEV__) {
      console.warn(
        '[MoneyKal] Could not persist the session; you will be signed out on next launch.',
        err,
      );
    }
  }
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch {
    /* Already gone. */
  }
}
