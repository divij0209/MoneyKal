import React, { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { Button, Chip, Screen, Text } from '../../components';
import type { OnboardingStackParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { saveDraft } from './draft';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'StartupFinancialSetup'>;

/**
 * Step 4 — `#step4-startup`, "How do you manage your finances?".
 *
 * The web offers three options and lets you pick one. Manual is preselected
 * there and is the only one that can complete a signup here:
 *
 *   - **Zoho Books** is shown but not selectable. Its flow is a browser OAuth
 *     redirect to `/api/zoho/auth`, and backend/routers/zoho.py has no mobile
 *     client path — no `client=mobile`, no `moneykal://` deep link, unlike
 *     routers/gmail.py which has both. It would also 500 today: ZOHO_CLIENT_ID,
 *     ZOHO_CLIENT_SECRET and ZOHO_REDIRECT_URI are unset. Offering it would be
 *     offering a dead end.
 *   - **Other (Quickbooks, Xero…)** is disabled on the web too, as
 *     "Coming soon" — reproduced exactly.
 *
 * Both are kept visible rather than hidden, because the choice a founder is
 * being offered is part of the product's story about where its numbers come
 * from. Neither is a mobile-only limitation invented here.
 */

interface OptionSpec {
  key: 'zoho' | 'manual' | 'other';
  title: string;
  blurb: string;
  disabled: boolean;
  note?: string;
}

const OPTIONS: OptionSpec[] = [
  {
    key: 'zoho',
    title: 'Zoho Books',
    blurb: 'Connect securely to import data',
    disabled: true,
    note: 'On the web only',
  },
  {
    key: 'manual',
    title: 'Manual Entry',
    blurb: 'I will enter the key numbers myself',
    disabled: false,
  },
  {
    key: 'other',
    title: 'Other (Quickbooks, Xero, etc.)',
    blurb: 'Coming soon…',
    disabled: true,
  },
];

export function StartupFinancialSetupScreen({ navigation }: Props) {
  const theme = useTheme();
  // Manual is preselected, as it is on the web.
  const [selected] = useState<'manual'>('manual');

  const onContinue = useCallback(async () => {
    await saveDraft({ financialSetup: selected });
    navigation.navigate('StartupManualEntry');
  }, [selected, navigation]);

  return (
    <Screen scroll contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}>
      <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.md }}>
        <Text variant="title">How do you manage your finances?</Text>

        <View style={{ gap: theme.spacing.md }}>
          {OPTIONS.map((o) => {
            const active = !o.disabled && o.key === selected;
            return (
              <Pressable
                key={o.key}
                disabled={o.disabled}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: o.disabled }}
                accessibilityLabel={`${o.title} — ${o.blurb}`}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: theme.spacing.md,
                  padding: theme.spacing.lg,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : theme.colors.line,
                  backgroundColor: active ? theme.colors.accentTint : 'transparent',
                  opacity: o.disabled ? 0.45 : pressed ? 0.75 : 1,
                })}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <Text variant="heading" color={active ? 'accent' : 'ink'}>
                    {o.title}
                  </Text>
                  <Text variant="bodySmall" color="faint">
                    {o.blurb}
                  </Text>
                </View>
                {o.note ? <Chip label={o.note} /> : null}
              </Pressable>
            );
          })}
        </View>

        <Button label="Continue →" onPress={() => void onContinue()} />
      </View>
    </Screen>
  );
}
