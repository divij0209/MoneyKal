import React from 'react';
import { getFocusedRouteNameFromRoute, type RouteProp } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { LiveLifeScreen } from '../features/liveLife/LiveLifeScreen';
import { MarketPulseScreen } from '../features/marketPulse/MarketPulseScreen';
import { ReportsScreen } from '../features/reports/ReportsScreen';
import { SettingsScreen } from '../features/more/SettingsScreen';
import { TaxScreen } from '../features/tax/TaxScreen';
import { ProfileScreen } from '../features/profile/ProfileScreen';
import { VoiceScreen } from '../features/voice/VoiceScreen';
import { PaymentDetectionProvider } from '../features/paymentDetection';
import { useT } from '../i18n';
import { useProfile } from '../store';
import { AppHeader } from './AppHeader';
import { IndividualTabs, StartupTabs } from './Tabs';
import { INDIVIDUAL_TAB_META, STARTUP_TAB_META, type AppStackParamList } from './types';

const Stack = createNativeStackNavigator<AppStackParamList>();

/**
 * The signed-in app.
 *
 * A stack wrapping the persona tab bar, so the full-screen surfaces the web
 * opens as overlays — live.life.fully, VARTA — can be pushed over the tabs
 * rather than living inside them. That is the same relationship the web has:
 * the live.life.fully portal is deliberately not a `.navitem`.
 */
export function AppNavigator() {
  const { persona } = useProfile();
  const t = useT();

  /** The topbar title/subtitle track the focused tab, as the web's does. */
  function tabHeader(route: RouteProp<AppStackParamList, 'Tabs'>, openSettings: () => void) {
    const meta = persona === 'startup' ? STARTUP_TAB_META : INDIVIDUAL_TAB_META;
    const fallback = persona === 'startup' ? 'Overview' : 'Home';
    const focused = (getFocusedRouteNameFromRoute(route) ?? fallback) as keyof typeof meta;
    const entry = meta[focused] ?? meta[fallback as keyof typeof meta];
    return (
      <AppHeader
        title={t(entry.title)}
        subtitle={t(entry.subtitle)}
        onAccountPress={openSettings}
      />
    );
  }

  return (
    /* Payment detection lives here rather than at the app root on purpose.
       This subtree is mounted only once there is a session AND the app lock
       has been passed (see RootNavigator), so a sheet showing an amount can
       never appear over the lock screen or in front of a signed-out user. */
    <PaymentDetectionProvider>
    <Stack.Navigator screenOptions={{ headerShown: true, animation: 'slide_from_right' }}>
      <Stack.Screen
        name="Tabs"
        component={persona === 'startup' ? StartupTabs : IndividualTabs}
        options={({ route, navigation }) => ({
          header: () =>
            tabHeader(route as RouteProp<AppStackParamList, 'Tabs'>, () =>
              navigation.navigate('Settings'),
            ),
        })}
      />

      {/* Full-screen experiences. Presented as modals so they own the screen,
          matching the web overlays they come from. */}
      <Stack.Group screenOptions={{ presentation: 'fullScreenModal', headerShown: false }}>
        <Stack.Screen name="LiveLife" component={LiveLifeScreen} />
        <Stack.Screen name="Voice" component={VoiceScreen} />
      </Stack.Group>

      {/* Pushed screens. Each supplies its own AppHeader so the back affordance
          and the topbar copy stay together with the screen they belong to. */}
      <Stack.Group screenOptions={{ headerShown: false }}>
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={({ navigation }) => ({
            headerShown: true,
            header: () => (
              <AppHeader
                title={t('nav.settings')}
                subtitle={t('nav.sub.settings')}
                onBackPress={navigation.goBack}
              />
            ),
          })}
        />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
          options={({ navigation }) => ({
            headerShown: true,
            header: () => (
              <AppHeader
                title={t('nav.profile')}
                subtitle={t('nav.sub.profile')}
                onBackPress={navigation.goBack}
              />
            ),
          })}
        />
        {/* Tax — the Individual Tax Calculator. The screen renders its own
            403 state if the backend refuses a non-Individual profile, which
            is the real boundary (backend/routers/tax.py); the entry points
            are hidden for other personas as a courtesy, not as security. */}
        <Stack.Screen
          name="Tax"
          component={TaxScreen}
          options={({ navigation }) => ({
            headerShown: true,
            header: () => (
              <AppHeader
                title={t('tax.title')}
                subtitle={t('tax.subtitle')}
                onBackPress={navigation.goBack}
                minimal
              />
            ),
          })}
        />

        <Stack.Screen
          name="MarketPulse"
          component={MarketPulseScreen}
          options={({ navigation }) => ({
            headerShown: true,
            header: () => (
              <AppHeader
                title={t('nav.marketPulse')}
                subtitle={t('nav.sub.marketPulse')}
                onBackPress={navigation.goBack}
              />
            ),
          })}
        />
        <Stack.Screen
          name="Reports"
          component={ReportsScreen}
          options={({ navigation }) => ({
            headerShown: true,
            header: () => (
              <AppHeader
                title={t('nav.reports')}
                subtitle={t('nav.sub.reports')}
                onBackPress={navigation.goBack}
              />
            ),
          })}
        />
      </Stack.Group>
    </Stack.Navigator>
    </PaymentDetectionProvider>
  );
}
