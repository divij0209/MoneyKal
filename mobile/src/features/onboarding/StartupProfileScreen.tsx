import React, { useCallback } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { Button, Input, Screen, Select, Text } from '../../components';
import type { OnboardingStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import {
  BUSINESS_MODEL_OPTIONS,
  INDUSTRY_OPTIONS,
  STAGE_OPTIONS,
} from './startup/constants';
import { useStartupOnboarding } from './startup/useStartupOnboarding';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'StartupProfile'>;

/**
 * Step 3 of the wizard — `#step3-startup` in twin-app/register.html.
 *
 * Six fields, five of them required, in the web's order. Nothing is sent yet:
 * the whole wizard posts once, from step 5, so this screen only records what
 * was typed and moves on. That is the web's sequence too.
 */
export function StartupProfileScreen({ navigation }: Props) {
  const theme = useTheme();
  const { values, errors, loaded, setField, validate } = useStartupOnboarding();

  const onNext = useCallback(() => {
    if (validate('profile')) navigation.navigate('StartupFinancialSetup');
  }, [validate, navigation]);

  if (!loaded) return <Screen scroll><View /></Screen>;

  return (
    <Screen scroll contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}>
      <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <Text variant="bodySmall" color="muted">
          This is what your Financial Twin is built on — the numbers come next.
        </Text>

        <View style={{ gap: theme.spacing.lg }}>
          <Input
            label="Startup name"
            required
            value={values.companyName}
            onChangeText={(t) => setField('companyName', t)}
            error={errors.companyName}
            placeholder="Acme Labs"
            autoCapitalize="words"
          />

          <Select
            label="Industry"
            value={values.industry}
            options={INDUSTRY_OPTIONS}
            onChange={(v) => setField('industry', v)}
            placeholder="Select industry"
          />
          {errors.industry ? (
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              {errors.industry}
            </Text>
          ) : null}

          <Select
            label="Business model"
            value={values.businessModel}
            options={BUSINESS_MODEL_OPTIONS}
            onChange={(v) => setField('businessModel', v)}
            placeholder="Select model"
          />
          {errors.businessModel ? (
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              {errors.businessModel}
            </Text>
          ) : null}

          <Select
            label="Startup stage"
            value={values.stage}
            options={STAGE_OPTIONS}
            onChange={(v) => setField('stage', v)}
            placeholder="Select stage"
          />
          {errors.stage ? (
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              {errors.stage}
            </Text>
          ) : null}

          <Input
            label="Team size (headcount)"
            required
            value={values.headcount}
            onChangeText={(t) => setField('headcount', t)}
            error={errors.headcount}
            placeholder="12"
            keyboardType="number-pad"
          />

          <Input
            label="GST number (GSTIN)"
            value={values.gstNumber}
            onChangeText={(t) => setField('gstNumber', t)}
            error={errors.gstNumber}
            placeholder="15-digit GSTIN (optional)"
            autoCapitalize="characters"
            autoCorrect={false}
            hint="Optional. Checked by the server when you finish."
          />
        </View>

        <Button label="Next: Financial data →" onPress={onNext} />
      </View>
    </Screen>
  );
}
