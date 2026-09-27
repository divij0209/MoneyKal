import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AppState, Platform, type AppStateStatus } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

import { authApi, configureApiClient } from '../api';
import { discoverApiBaseUrl, loadApiBaseUrlOverride } from '../config/env';
import { clearPasscode, hasPasscode, LOCK_SUPPORTED } from './passcode';
import type { AuthResponse, TermsAcceptance } from '../api/types';
import {
  clearSession,
  loadSession,
  saveSession,
  sessionFromAuthResponse,
  type Session,
} from './session';

/**
 * Who is signed in, and what the app should show because of it.
 *
 * The routing decision reproduces the web's login branch (twin-app/js/auth.js):
 *   no token                  -> the auth screens
 *   token, profile_key null   -> finish onboarding
 *   token, profile_key set    -> the persona app
 *
 * `status` exists so the splash screen can stay up while the keychain is read,
 * rather than flashing the login screen at a user who is already signed in.
 *
 * Two states were added for the MoneyKal passcode:
 *
 *   needsPasscode  onboarded, but no passcode has been created yet
 *   locked         a passcode exists and the app is waiting for it
 *
 * They are statuses rather than an overlay on purpose. RootNavigator renders
 * whole stacks off `status`, so while the app is locked the persona stack is
 * not mounted at all — no screen holding financial data exists to be revealed
 * by a race, a deep link, or a stray navigation. The lock is structural.
 */

export type AuthStatus =
  | 'loading'
  | 'signedOut'
  | 'needsOnboarding'
  | 'needsPasscode'
  | 'locked'
  | 'ready';

/**
 * How long the app may sit in the background before it re-locks.
 *
 * Short enough that a phone left on a table is protected, long enough that
 * glancing at a notification or switching to the OTP app does not become a
 * passcode prompt.
 */
const LOCK_AFTER_BACKGROUND_MS = 2 * 60 * 1000;

/** Namespaces the Android FLAG_SECURE claim so another caller cannot clear it. */
const SNAPSHOT_KEY = 'moneykal-lock';

interface AuthContextValue {
  status: AuthStatus;
  session: Session | null;
  /** `terms` is the acceptance record from the consent checkbox. The screens
   *  refuse to call these without it; it is optional in the signature so the
   *  backend's own optional field is mirrored rather than widened. */
  signIn: (username: string, password: string, terms?: TermsAcceptance) => Promise<void>;
  signUp: (username: string, password: string, terms?: TermsAcceptance) => Promise<void>;
  signOut: () => Promise<void>;
  /** Called when onboarding completes and the backend has assigned a persona. */
  setProfileKey: (key: string) => Promise<void>;
  /** Called by the lock screen once a passcode has been accepted. */
  unlock: () => void;
  /** Called after a passcode is created, so the app can proceed. */
  onPasscodeCreated: () => void;
  /** Re-locks immediately. Used after "forgot passcode" clears the old one. */
  requirePasscodeSetup: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>('loading');

  // The client reads the token through a ref so a request never captures a
  // stale value from a closure — refresh rotates it mid-flight.
  const sessionRef = useRef<Session | null>(null);
  // Concurrent 401s must not each fire their own refresh; they share this one.
  const refreshInFlight = useRef<Promise<string | null> | null>(null);

  /**
   * Where a session lands.
   *
   * Signing in freshly does not re-lock: the user has just proved themselves
   * with their account password, and demanding the passcode immediately after
   * is friction with no security value. It routes to `needsPasscode` only when
   * one has never been created.
   */
  const applySession = useCallback(async (next: Session | null) => {
    sessionRef.current = next;
    setSession(next);
    if (next) {
      await saveSession(next);
      if (!next.profileKey) {
        setStatus('needsOnboarding');
        return;
      }
      // On a platform with no lock there is nothing to set up, so the app
      // goes straight in rather than to a passcode screen it cannot satisfy.
      setStatus(!LOCK_SUPPORTED || (await hasPasscode()) ? 'ready' : 'needsPasscode');
    } else {
      await clearSession();
      setStatus('signedOut');
    }
  }, []);

  const handleAuthResponse = useCallback(
    async (res: AuthResponse) => {
      await applySession(sessionFromAuthResponse(res));
    },
    [applySession],
  );

  const doRefresh = useCallback(async (): Promise<string | null> => {
    const current = sessionRef.current;
    if (!current?.refreshToken) return null;

    if (refreshInFlight.current) return refreshInFlight.current;

    refreshInFlight.current = (async () => {
      try {
        const res = await authApi.refresh(current.refreshToken as string);
        const next = sessionFromAuthResponse(res);
        sessionRef.current = next;
        setSession(next);
        await saveSession(next);
        return next.token;
      } catch {
        // Refresh itself failed — the session is over. The API client will
        // surface the 401 and call onUnauthorized, which signs out.
        return null;
      } finally {
        refreshInFlight.current = null;
      }
    })();

    return refreshInFlight.current;
  }, []);

  /**
   * Signing out clears the passcode as well.
   *
   * The verifier guards *this account's* session on *this device*. Leaving it
   * behind would mean the next person to sign in inherits a lock they never
   * set and cannot open.
   */
  const signOut = useCallback(async () => {
    await clearPasscode();
    await applySession(null);
  }, [applySession]);

  // Wire the API client before anything can issue a request.
  useEffect(() => {
    configureApiClient({
      getToken: () => sessionRef.current?.token ?? null,
      refreshToken: doRefresh,
      onUnauthorized: () => {
        void applySession(null);
      },
    });
  }, [doRefresh, applySession]);

  // Restore a stored session on launch.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Before the session, so the very first request already goes to the
      // address the user last chose rather than the one baked into the build.
      await loadApiBaseUrlOverride();

      // Then, when there is no explicit choice, find a backend this device can
      // actually reach. A single baked address goes stale whenever the network
      // does — a different Wi-Fi, mobile data, an APK built elsewhere — and the
      // symptom is every screen failing at once with nothing to act on. This
      // costs one parallel round of /health probes and is skipped entirely in
      // production builds. See discoverApiBaseUrl() in src/config/env.ts.
      await discoverApiBaseUrl();

      const stored = await loadSession();
      const locked = stored ? await hasPasscode() : false;
      if (cancelled) return;
      sessionRef.current = stored;
      setSession(stored);
      if (!stored) {
        setStatus('signedOut');
      } else if (!stored.profileKey) {
        setStatus('needsOnboarding');
      } else if (!LOCK_SUPPORTED) {
        setStatus('ready');
      } else {
        // Cold start always re-locks when a passcode exists: the process died,
        // so there is no "recently unlocked" to trust.
        setStatus(locked ? 'locked' : 'needsPasscode');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (username: string, password: string, terms?: TermsAcceptance) => {
      await handleAuthResponse(await authApi.login(username.trim(), password, terms));
    },
    [handleAuthResponse],
  );

  const signUp = useCallback(
    async (username: string, password: string, terms?: TermsAcceptance) => {
      await handleAuthResponse(await authApi.register(username.trim(), password, terms));
    },
    [handleAuthResponse],
  );

  const setProfileKey = useCallback(
    async (key: string) => {
      const current = sessionRef.current;
      if (!current) return;
      await applySession({ ...current, profileKey: key });
    },
    [applySession],
  );

  /* ------------------------------------------- task-switcher snapshot ----
     Protection has to be armed *before* the app leaves the foreground, not
     while it is locked. Both platforms capture the switcher snapshot on the
     way out, at which point `status` is still 'ready' — so gating this on
     'locked' would blur the lock screen, which needs no blurring, and leave
     the dashboard frame that was actually captured untouched.

     The rule is therefore: protect for as long as a passcode is configured and
     a persona screen can be on display.

       iOS      enableAppSwitcherProtectionAsync blurs the app while it is out
                of focus and nothing else — screenshots taken by the user while
                the app is active still work.
       Android  the only mechanism is FLAG_SECURE, which blanks the recents
                entry but also blocks screenshots for as long as it is set.
                That trade-off is deliberate and matches what banking apps do,
                but it is a real behaviour change, not a free win. */
  useEffect(() => {
    const guarded = status === 'ready' || status === 'locked';
    let cancelled = false;

    void (async () => {
      const on = guarded && (await hasPasscode());
      if (cancelled) return;
      try {
        if (Platform.OS === 'android') {
          await (on
            ? ScreenCapture.preventScreenCaptureAsync(SNAPSHOT_KEY)
            : ScreenCapture.allowScreenCaptureAsync(SNAPSHOT_KEY));
        } else if (Platform.OS === 'ios') {
          await (on
            ? ScreenCapture.enableAppSwitcherProtectionAsync()
            : ScreenCapture.disableAppSwitcherProtectionAsync());
        }
      } catch {
        /* Unsupported surface or OS version — the lock itself still holds. */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status]);

  const unlock = useCallback(() => setStatus('ready'), []);
  const onPasscodeCreated = useCallback(() => setStatus('ready'), []);
  const requirePasscodeSetup = useCallback(() => setStatus('needsPasscode'), []);

  /* ------------------------------------------------------ background lock --
     The app re-locks when it comes back from the background after more than
     LOCK_AFTER_BACKGROUND_MS. The timestamp is taken on the way out rather
     than a timer being run while backgrounded, because the OS suspends timers
     and a suspended timer would never fire.

     `statusRef` is read instead of `status` so the listener does not need to be
     torn down and re-added on every status change — re-subscribing mid
     transition is how a background event gets missed. */
  const statusRef = useRef<AuthStatus>('loading');
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const backgroundedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!LOCK_SUPPORTED) return;

    const onChange = (next: AppStateStatus) => {
      if (next === 'active') {
        const since = backgroundedAt.current;
        backgroundedAt.current = null;
        if (
          since !== null &&
          Date.now() - since >= LOCK_AFTER_BACKGROUND_MS &&
          statusRef.current === 'ready'
        ) {
          // Only an unlocked, fully onboarded app can lock. Locking during
          // onboarding or the auth flow would strand the user.
          void hasPasscode().then((exists) => {
            if (exists && statusRef.current === 'ready') setStatus('locked');
          });
        }
      } else if (next === 'background' || next === 'inactive') {
        // 'inactive' covers the iOS app switcher and incoming calls. Recording
        // it here means a long stay in the switcher also counts.
        if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
      }
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      session,
      signIn,
      signUp,
      signOut,
      setProfileKey,
      unlock,
      onPasscodeCreated,
      requirePasscodeSetup,
    }),
    [
      status,
      session,
      signIn,
      signUp,
      signOut,
      setProfileKey,
      unlock,
      onPasscodeCreated,
      requirePasscodeSetup,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
