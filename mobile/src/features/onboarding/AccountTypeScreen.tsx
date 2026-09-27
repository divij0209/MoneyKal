import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { PersonaKey } from '../../api/types';
import { Button, Screen, Text } from '../../components';
import { useT } from '../../i18n';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import type { OnboardingStackParamList } from '../../navigation/types';
import { saveDraft } from './draft';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'AccountType'>;

/**
 * Step 1 of the wizard, as a resume point.
 *
 * Normally the account type is chosen on the Register screen before the
 * account exists, matching the web's step order. This screen is what a user
 * lands on when they have an account but no profile and no draft — they
 * registered, then closed the app, or they are logging in on a new device
 * mid-onboarding. The web handles the same case with `register.html?resume=true`.
 */
export function AccountTypeScreen({ navigation }: Props) {
  const theme = useTheme();
  const t = useT();
  const [selected, setSelected] = useState<PersonaKey>('individual');
  const [busy, setBusy] = useState(false);

  async function onContinue() {
    setBusy(true);
    await saveDraft({ accountType: selected });
    navigation.navigate(selected === 'startup' ? 'StartupProfile' : 'IndividualProfile');
    setBusy(false);
  }

  const options: { key: PersonaKey; title: string; desc: string }[] = [
    { key: 'individual', title: t('auth.individual'), desc: t('auth.individualDesc') },
    { key: 'startup', title: t('auth.startup'), desc: t('auth.startupDesc') },
  ];

  return (
    <Screen scroll>
      <View style={{ paddingTop: theme.spacing.xxl, gap: theme.spacing.xs }}>
        <Text variant="display">{t('onb.welcome')}</Text>
        <Text variant="body" color="muted">
          {t('onb.chooseAccount')}
        </Text>
      </View>

      <View style={{ height: theme.spacing.xxl }} />

      <Text variant="label" color="faint">
        {t('auth.accountType')}
      </Text>

      {/* Ruled radio rows rather than two filled cards, matching the Register
          screen so the two entry points into the same choice look the same. */}
      <View style={{ marginTop: theme.spacing.sm }}>
        {options.map((opt, i) => {
          const isSelected = selected === opt.key;
          return (
            <Pressable
              key={opt.key}
              onPress={() => setSelected(opt.key)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${opt.title}. ${opt.desc}`}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'flex-start',
                gap: theme.spacing.md,
                minHeight: MIN_TOUCH_SIZE,
                paddingVertical: theme.spacing.lg,
                borderTopWidth: i === 0 ? 1 : 0,
                borderTopColor: theme.colors.line,
                borderBottomWidth: 1,
                borderBottomColor: theme.colors.line,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  marginTop: 1,
                  borderWidth: isSelected ? 6 : 1.5,
                  borderColor: isSelected ? theme.colors.accent : theme.colors.lineStrong,
                }}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  variant="heading"
                  style={{ color: isSelected ? theme.colors.ink : theme.colors.inkMuted }}
                >
                  {opt.title}
                </Text>
                <Text variant="bodySmall" color="faint">
                  {opt.desc}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={{ height: theme.spacing.xxl }} />

      <Button label={t('common.continue')} onPress={onContinue} loading={busy} size="lg" />
    </Screen>
  );
}
