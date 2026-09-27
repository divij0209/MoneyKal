import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';

import { Button, Screen, Text } from '../../components';
import { useAuth } from '../../store';
import {
  isValidPasscode,
  setPasscode,
  verifyPasscode,
  weakPasscodeReason,
} from '../../store/passcode';
import { useTheme } from '../../theme';
import { PinPad } from './PinPad';

/**
 * Creating or changing the MoneyKal passcode.
 *
 * Three modes, one flow:
 *
 *   create   choose -> confirm                  (first run, and after a reset)
 *   change   current -> choose -> confirm       (from Settings)
 *
 * The confirm step is not decoration: a mistyped passcode that is stored
 * without confirmation locks the user out of their own app, and the only way
 * back is the account password. Requiring the digits twice is what makes the
 * lock safe to enable.
 */

type Step = 'current' | 'choose' | 'confirm';

interface Props {
  mode: 'create' | 'change';
  /** Change mode only — dismisses the screen. */
  onDone?: () => void;
  onCancel?: () => void;
}

export function SetPasscodeScreen({ mode, onDone, onCancel }: Props) {
  const theme = useTheme();
  const { onPasscodeCreated } = useAuth();

  const [step, setStep] = useState<Step>(mode === 'change' ? 'current' : 'choose');
  const [pin, setPin] = useState('');
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set once the digits are confirmed, while the biometric opt-in is shown. */
  const [awaitingBio, setAwaitingBio] = useState(false);
  const [bioOffer, setBioOffer] = useState<{ show: boolean; label: string }>({
    show: false,
    label: 'Biometrics',
  });

  // Only offer biometrics on hardware that has it and an enrolled user.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [hardware, enrolled, types] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
        LocalAuthentication.supportedAuthenticationTypesAsync(),
      ]);
      if (!alive) return;
      setBioOffer({
        show: hardware && enrolled,
        label: types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
          ? 'Face ID'
          : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
            ? 'Fingerprint'
            : 'Biometrics',
      });
    })();
    return () => {
      alive = false;
    };
  }, []);

  const finish = useCallback(
    async (value: string, withBiometric: boolean) => {
      setBusy(true);
      await setPasscode(value, withBiometric);
      setBusy(false);
      if (mode === 'change') onDone?.();
      else onPasscodeCreated();
    },
    [mode, onDone, onPasscodeCreated],
  );

  const submit = useCallback(
    async (value: string) => {
      setError(null);

      if (step === 'current') {
        setBusy(true);
        const res = await verifyPasscode(value);
        setBusy(false);
        setPin('');
        if (!res.ok) {
          setError('That is not your current passcode.');
          return;
        }
        setStep('choose');
        return;
      }

      if (step === 'choose') {
        if (!isValidPasscode(value)) {
          setPin('');
          setError('Your passcode must be 6 digits.');
          return;
        }
        const weak = weakPasscodeReason(value);
        if (weak) {
          setPin('');
          setError(weak);
          return;
        }
        setChosen(value);
        setPin('');
        setStep('confirm');
        return;
      }

      // confirm
      if (value !== chosen) {
        setPin('');
        setChosen('');
        setStep('choose');
        setError('Those did not match. Choose a passcode again.');
        return;
      }

      if (bioOffer.show) {
        // Ask before enabling — biometrics are a convenience the user opts
        // into, not something switched on for them. The passcode is not
        // written until that question is answered either way.
        setPin('');
        setAwaitingBio(true);
        return;
      }

      await finish(value, false);
    },
    [step, chosen, bioOffer.show, finish],
  );

  const COPY: Record<Step, { title: string; body: string }> = {
    current: {
      title: 'Enter your current passcode',
      body: 'Confirm the passcode you use today before choosing a new one.',
    },
    choose: {
      title: mode === 'change' ? 'Choose a new passcode' : 'Create your MoneyKal passcode',
      body:
        mode === 'change'
          ? 'Six digits. You will use this to unlock MoneyKal.'
          : 'Six digits, separate from your account password. You will use it to unlock MoneyKal on this device.',
    },
    confirm: {
      title: 'Confirm your passcode',
      body: 'Enter the same six digits again.',
    },
  };

  if (awaitingBio) {
    return (
      <Screen>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.xl,
            paddingHorizontal: theme.spacing.xl,
          }}
        >
          <Text variant="title" center>
            Use {bioOffer.label} to unlock?
          </Text>
          <Text variant="bodySmall" color="muted" center>
            Faster than typing your passcode. Your passcode still works, and is required after a
            restart.
          </Text>
          <View style={{ alignSelf: 'stretch', gap: theme.spacing.md }}>
            <Button
              label={`Use ${bioOffer.label}`}
              loading={busy}
              disabled={busy}
              onPress={() => {
                void (async () => {
                  const res = await LocalAuthentication.authenticateAsync({
                    promptMessage: `Enable ${bioOffer.label} for MoneyKal`,
                    disableDeviceFallback: true,
                  });
                  // `finish` writes the record with this flag already set, so
                  // there is nothing more to persist either way.
                  await finish(chosen, res.success);
                })();
              }}
            />
            <Button
              label="Not now"
              variant="outline"
              disabled={busy}
              onPress={() => void finish(chosen, false)}
            />
          </View>
        </View>
      </Screen>
    );
  }

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
        <View style={{ alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="title" center>
            {COPY[step].title}
          </Text>
          <Text variant="bodySmall" color="muted" center>
            {COPY[step].body}
          </Text>
        </View>

        <PinPad
          value={pin}
          onChange={(v) => {
            setPin(v);
            if (error) setError(null);
          }}
          onComplete={(v) => void submit(v)}
          disabled={busy}
          error={!!error}
        />

        <View style={{ minHeight: 40, alignItems: 'center' }}>
          {error ? (
            <Text variant="bodySmall" style={{ color: theme.colors.warn }} center>
              {error}
            </Text>
          ) : null}
        </View>

        {mode === 'change' && onCancel ? (
          <Button label="Cancel" variant="ghost" fullWidth={false} onPress={onCancel} />
        ) : null}
      </View>
    </Screen>
  );
}
