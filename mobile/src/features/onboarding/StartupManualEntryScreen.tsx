import React, { useCallback } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { Button, Input, Screen, Text } from '../../components';
import type { OnboardingStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { useStartupOnboarding } from './startup/useStartupOnboarding';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'StartupManualEntry'>;

/**
 * Step 5 — `#step5-startup`, "Enter Financial Details".
 *
 * The five figures the Startup Financial Twin is built from, then one POST to
 * /onboard/startup which creates the profile and the StartupProfile row. When
 * it succeeds the profile key becomes 'startup' and the root navigator moves
 * the founder into the Startup tabs.
 *
 * The web shows a live "Auto-calculated metrics" box here — runway and net cash
 * flow, computed in the browser as you type. That is deliberately not
 * reproduced: it is financial logic on the client, and the backend returns the
 * real figures the moment this submits. A founder sees computed metrics one
 * screen later, from the only place entitled to compute them.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function StartupManualEntryScreen(_props: Props) {
  const theme = useTheme();
  const { values, errors, loaded, submitting, submitError, setField, submit } =
    useStartupOnboarding();

  const onSubmit = useCallback(async () => {
    // On success the profile key flips and RootNavigator swaps the whole stack
    // for the Startup tabs, so there is nothing to navigate to from here.
    await submit();
  }, [submit]);

  if (!loaded) return <Screen scroll><View /></Screen>;

  return (
    <Screen scroll contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}>
      <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <Text variant="bodySmall" color="muted">
          Five numbers. Everything on your dashboard — runway, burn, health — is
          calculated from these by MoneyKal, not estimated here.
        </Text>

        <View style={{ gap: theme.spacing.lg }}>
          <Input
            label="Current cash in bank (₹)"
            required
            value={values.currentCash}
            onChangeText={(t) => setField('currentCash', t)}
            error={errors.currentCash}
            placeholder="2500000"
            keyboardType="number-pad"
          />
          <Input
            label="Monthly revenue (₹)"
            required
            value={values.monthlyRevenue}
            onChangeText={(t) => setField('monthlyRevenue', t)}
            error={errors.monthlyRevenue}
            placeholder="450000"
            keyboardType="number-pad"
            hint="Enter 0 if you are pre-revenue."
          />
          <Input
            label="Monthly expenses / burn (₹)"
            required
            value={values.monthlyBurn}
            onChangeText={(t) => setField('monthlyBurn', t)}
            error={errors.monthlyBurn}
            placeholder="800000"
            keyboardType="number-pad"
          />
          <Input
            label="Total funding raised (₹)"
            required
            value={values.totalFunding}
            onChangeText={(t) => setField('totalFunding', t)}
            error={errors.totalFunding}
            placeholder="15000000"
            keyboardType="number-pad"
          />
          <Input
            label="Debt / liabilities (₹)"
            required
            value={values.debt}
            onChangeText={(t) => setField('debt', t)}
            error={errors.debt}
            placeholder="0"
            keyboardType="number-pad"
          />
        </View>

        {submitError ? (
          <View
            style={{
              padding: theme.spacing.md,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.warnTint,
              borderWidth: 1,
              borderColor: theme.colors.warn,
            }}
          >
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              {submitError}
            </Text>
          </View>
        ) : null}

        <Button
          label={submitting ? 'Initializing Twin…' : 'Create Financial Twin'}
          loading={submitting}
          disabled={submitting}
          onPress={() => void onSubmit()}
        />
      </View>
    </Screen>
  );
}
