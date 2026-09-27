import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Chip, Divider, Glyph, Screen, Surface, Text } from '../../components';
import { ListRow } from '../../components/primitives/ListRow';
import { useT } from '../../i18n';
import { TabIcon } from '../../navigation/TabIcon';
import type { AppStackParamList } from '../../navigation/types';
import { useAuth, useProfile } from '../../store';
import { useTheme } from '../../theme';

/**
 * The Individual persona's fifth tab — the hub for everything that is not a
 * tab.
 *
 * The web sidebar carries eight items for an individual plus the
 * live.life.fully portal; five is the practical ceiling for a bottom tab bar,
 * so the four most-used become tabs and the rest live here. Nothing is
 * dropped: the Tax Calculator, Reports and Market Pulse are all reachable,
 * one level down.
 *
 * The Tax Calculator leads the list and is the one row with a filled mark,
 * because it is a headline feature that has no tab. It is Individual-only —
 * the web gates `navTax` on the profile key in tax.js and the backend answers
 * 403 for other personas — so it is hidden rather than offered and refused.
 */
export function MoreScreen() {
  const theme = useTheme();
  const t = useT();
  const { session } = useAuth();
  const { profile, persona } = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();

  const isIndividual = persona !== 'startup';

  return (
    <Screen scroll padded={false}>
      <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.lg }}>
        <Surface tone="inset" padded={theme.spacing.lg}>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" color="faint">
              {t('home.signedInAs')}
            </Text>
            <Text variant="title" numberOfLines={1}>
              {profile?.persona || session?.username || 'MoneyKal user'}
            </Text>
            <View
              style={{
                flexDirection: 'row',
                gap: theme.spacing.sm,
                marginTop: theme.spacing.xs,
                flexWrap: 'wrap',
              }}
            >
              <Chip
                label={persona === 'startup' ? t('auth.startup') : t('auth.individual')}
                tone="accent"
              />
              {profile?.currency ? <Chip label={`${profile.currency}`} /> : null}
            </View>
          </View>
        </Surface>
      </View>

      {/* ------------------------------------------------------- your money */}
      <SectionLabel>{t('nav.sub.home')}</SectionLabel>

      {isIndividual ? (
        <>
          <ListRow
            label={t('tax.title')}
            detail={t('tax.subtitle')}
            leading={<Glyph name="receipt" color={theme.colors.accent} size={20} />}
            onPress={() => navigation.navigate('Tax')}
          />
          <Divider />
        </>
      ) : null}

      <ListRow
        label={t('nav.liveLife')}
        detail={t('home.liveLifeTagline')}
        leading={<TabIcon name="liveLife" color={theme.colors.accent} size={20} />}
        onPress={() => navigation.navigate('LiveLife')}
      />
      <Divider />
      <ListRow
        label={t('nav.varta')}
        detail={t('home.vartaTagline')}
        leading={<Glyph name="mic" color={theme.colors.accent} size={19} />}
        onPress={() => navigation.navigate('Voice')}
      />
      <Divider />
      <ListRow
        label={t('nav.reports')}
        detail={t('nav.sub.reports')}
        leading={<TabIcon name="reports" color={theme.colors.inkMuted} size={20} />}
        onPress={() => navigation.navigate('Reports')}
      />
      <Divider />
      <ListRow
        label={t('nav.marketPulse')}
        detail={t('nav.sub.marketPulse')}
        leading={<TabIcon name="overview" color={theme.colors.inkMuted} size={20} />}
        onPress={() => navigation.navigate('MarketPulse')}
      />

      {/* ----------------------------------------------------------- account */}
      <SectionLabel>{t('settings.account')}</SectionLabel>

      <ListRow
        label={t('settings.editProfile')}
        detail={t('nav.sub.profile')}
        onPress={() => navigation.navigate('Profile')}
      />
      <Divider />
      <ListRow
        label={t('nav.settings')}
        detail={t('nav.sub.settings')}
        leading={<Glyph name="settings" color={theme.colors.inkMuted} size={19} />}
        onPress={() => navigation.navigate('Settings')}
      />

      <View style={{ height: theme.spacing.huge }} />
    </Screen>
  );
}

/** The small caps heading above each group of rows. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      variant="label"
      color="faint"
      style={{
        paddingHorizontal: theme.spacing.lg,
        marginTop: theme.spacing.xxl,
        marginBottom: theme.spacing.sm,
      }}
    >
      {children}
    </Text>
  );
}
