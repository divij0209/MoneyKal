import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { ApiError, authApi } from '../../api';
import { Button, Glyph, Input, Screen, Sheet, Text } from '../../components';
import { useT } from '../../i18n';
import { useAuth } from '../../store';
import {
  attemptsRemaining,
  formatLockout,
  getAttempts,
  isBiometricEnabled,
  remainingLockout,
  verifyPasscode,
} from '../../store/passcode';
import { useTheme } from '../../theme';
import { PinPad } from './PinPad';

/**
 * The lock screen.
 *
 * Rendered by RootNavigator as the *entire* stack while `status === 'locked'`,
 * so no screen holding financial data is mounted behind it. There is
 * deliberately no way past this except a correct passcode, a successful
 * biometric check, or signing in again through "Forgot passcode".
 *
 * Nothing here talks to the API except the forgot-passcode path, which
 * re-authenticates with the account password — the one credential the backend
 * actually knows about.
 */
export function LockScreen() {
  const theme = useTheme();
  const t = useT();
  const { session, unlock, signOut, requirePasscodeSetup } = useAuth();

  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockoutMs, setLockoutMs] = useState(0);
  const [bio, setBio] = useState<{ available: boolean; label: string }>({
    available: false,
    label: 'Biometrics',
  });

  const [forgotOpen, setForgotOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [forgotBusy, setForgotBusy] = useState(false);

  /** Guards the auto-prompt so it fires once per mount, not on every render. */
  const promptedRef = useRef(false);

  /* ------------------------------------------------- lockout countdown --- */

  useEffect(() => {
    let alive = true;
    void getAttempts().then((a) => {
      if (alive) setLockoutMs(remainingLockout(a));
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (lockoutMs <= 0) return;
    const id = setInterval(() => {
      setLockoutMs((ms) => {
        const next = ms - 1000;
        if (next <= 0) {
          setError(null);
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [lockoutMs > 0]);

  /* ------------------------------------------------------- biometrics --- */

  const runBiometric = useCallback(async () => {
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock MoneyKal',
        // The OS passcode is not offered as a fallback: falling back to the
        // device PIN would let anyone who can unlock the phone into the app,
        // which is exactly what this lock exists to prevent. The MoneyKal
        // passcode below is the fallback.
        disableDeviceFallback: true,
        cancelLabel: 'Use passcode',
      });
      if (res.success) unlock();
    } catch {
      /* Cancelled or unavailable — the pad is still there. */
    }
  }, [unlock]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [enabled, hardware, enrolled, types] = await Promise.all([
        isBiometricEnabled(),
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
      ]);
      if (!alive) return;

      const available = enabled && hardware && enrolled;
      const label = types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
        ? 'Face ID'
        : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
          ? 'Fingerprint'
          : 'Biometrics';
      setBio({ available, label });

      // Offer it immediately, but only when the user is not serving a lockout.
      const attempts = await getAttempts();
      if (available && remainingLockout(attempts) === 0 && !promptedRef.current) {
        promptedRef.current = true;
        void runBiometric();
      }
    })();
    return () => {
      alive = false;
    };
  }, [runBiometric]);

  /* ---------------------------------------------------------- verify --- */

  const submit = useCallback(
    async (candidate: string) => {
      setBusy(true);
      setError(null);
      const res = await verifyPasscode(candidate);
      setBusy(false);

      if (res.ok) {
        setPin('');
        unlock();
        return;
      }

      setPin('');

      if (res.reason === 'no_passcode') {
        // The verifier vanished — send the user to create one rather than
        // leaving them at a lock with nothing to match against.
        requirePasscodeSetup();
        return;
      }

      if (res.reason === 'locked_out') {
        setLockoutMs(res.remainingMs);
        setError(`Too many attempts. Try again in ${formatLockout(res.remainingMs)}.`);
        return;
      }

      if (res.shouldWipe) {
        // Ten consecutive failures: end the session. The account password is
        // now the only way back in, which is the point.
        await signOut();
        return;
      }

      if (res.remainingMs > 0) {
        setLockoutMs(res.remainingMs);
        setError(`Too many attempts. Try again in ${formatLockout(res.remainingMs)}.`);
      } else {
        const left = attemptsRemaining(res.failed);
        setError(
          left <= 2
            ? `Incorrect passcode. ${left} attempt${left === 1 ? '' : 's'} left.`
            : 'Incorrect passcode.',
        );
      }
    },
    [unlock, signOut, requirePasscodeSetup],
  );

  /* ---------------------------------------------------------- forgot --- */

  const submitForgot = useCallback(async () => {
    if (!session?.username || !password) return;
    setForgotBusy(true);
    setForgotError(null);
    try {
      // The account password is the only credential the backend knows, so it
      // is what a passcode reset has to be proved against. A success here does
      // not change the session — it just authorises setting a new passcode.
      await authApi.login(session.username, password);
      setForgotOpen(false);
      setPassword('');
      requirePasscodeSetup();
    } catch (err) {
      setForgotError(
        err instanceof ApiError ? err.detail : 'Could not verify your password. Try again.',
      );
    } finally {
      setForgotBusy(false);
    }
  }, [session, password, requirePasscodeSetup]);

  const lockedOut = lockoutMs > 0;

  return (
    <Screen>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.xxl,
          paddingHorizontal: theme.spacing.lg,
        }}
      >
        {/* The brand mark, then the ask. A lock screen is the one place the
            app should say who it is before it asks for anything. */}
        <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
          <View
            style={{
              width: 52,
              height: 52,
              borderRadius: 26,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.accentTint,
            }}
          >
            <Glyph name="wallet" color={theme.colors.accent} size={22} />
          </View>
          <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="title">{t('lock.title')}</Text>
            <Text variant="bodySmall" color="muted" center>
              MoneyKal
            </Text>
          </View>
        </View>

        <PinPad
          value={pin}
          onChange={(v) => {
            setPin(v);
            if (error) setError(null);
          }}
          onComplete={(v) => void submit(v)}
          disabled={busy || lockedOut}
          onBiometric={bio.available && !lockedOut ? () => void runBiometric() : undefined}
          biometricLabel={`${t('lock.useBiometric')} — ${bio.label}`}
          error={!!error}
        />

        <View style={{ minHeight: 44, alignItems: 'center', gap: theme.spacing.sm }}>
          {error ? (
            <Text variant="bodySmall" style={{ color: theme.colors.warn }} center>
              {error}
            </Text>
          ) : null}

          <Button
            label="Forgot passcode?"
            variant="ghost"
            size="sm"
            fullWidth={false}
            onPress={() => {
              setForgotError(null);
              setPassword('');
              setForgotOpen(true);
            }}
          />
        </View>
      </View>

      <Sheet
        visible={forgotOpen}
        onClose={() => setForgotOpen(false)}
        title="Reset your passcode"
        subtitle="Confirm your account password, then choose a new 6-digit passcode."
        error={forgotError}
        footer={
          <Button
            label={forgotBusy ? 'Checking…' : 'Confirm password'}
            loading={forgotBusy}
            disabled={forgotBusy || !password}
            onPress={() => void submitForgot()}
          />
        }
      >
        <View style={{ gap: theme.spacing.lg }}>
          <Input
            label="Account password"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            secureToggle
            autoCapitalize="none"
            editable={!forgotBusy}
            required
          />
          <Text variant="bodySmall" color="faint">
            Signed in as {session?.username ?? '—'}. If you have forgotten this too, sign out and
            reset it from the login screen.
          </Text>
          <Button
            label="Sign out instead"
            variant="outline"
            disabled={forgotBusy}
            onPress={() => void signOut()}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
