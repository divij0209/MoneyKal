import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { AlertsScreen } from '../features/alerts/AlertsScreen';
import { AskScreen } from '../features/ask/AskScreen';
import { HisaabScreen } from '../features/hisaab/HisaabScreen';
import { HomeScreen } from '../features/home/HomeScreen';
import { StartupOverviewScreen } from '../features/home/StartupOverviewScreen';
import { MoreScreen } from '../features/more/MoreScreen';
import { ReportsScreen } from '../features/reports/ReportsScreen';
import { SimulateScreen } from '../features/simulate/SimulateScreen';
import { useT } from '../i18n';
import { useTheme } from '../theme';
import { TabIcon, type IconName } from './TabIcon';
import {
  INDIVIDUAL_TAB_META,
  STARTUP_TAB_META,
  type IndividualTabParamList,
  type StartupTabParamList,
} from './types';

/**
 * The two persona tab bars.
 *
 * Which tabs each persona sees is taken from the web's own gating, not
 * invented here. `applyPersonaNav()` in twin-app/js/startup.js hides every
 * `.navitem[data-persona]` that doesn't match the current persona, and
 * `syncPreviewsToNav()` in js/overview.js hides the matching Overview cards.
 * The result on the current web build is:
 *
 *   Individual  Overview · Hisaab · Ask Twin · Simulate · Reports
 *   Startup     Overview · Ask Twin · Simulate · Alerts · Reports  (5 items)
 *
 * Startup's five map one-to-one onto five tabs. Individual's eight do not, so
 * the four most-used become tabs and the rest move behind "More" — nothing is
 * dropped, it is one level deeper.
 *
 * Note: Hisaab (and with it Gmail auto-import, whose UI lives inside the
 * Hisaab view) is Individual-only on the web today, even though the backend
 * serves /startup/hisaab for both personas. That gating is reproduced rather
 * than corrected — changing it would be new product behaviour, not a port.
 */

const IndividualTab = createBottomTabNavigator<IndividualTabParamList>();
const StartupTab = createBottomTabNavigator<StartupTabParamList>();

function useTabScreenOptions() {
  const theme = useTheme();

  return {
    headerShown: false,
    tabBarActiveTintColor: theme.colors.accent,
    tabBarInactiveTintColor: theme.colors.inkFaint,
    tabBarStyle: {
      backgroundColor: theme.colors.bg,
      borderTopColor: theme.colors.line,
      borderTopWidth: 1,
      // Room for the gesture bar; the safe-area inset is added by the
      // navigator. Taller than the old 62 so a two-line Devanagari label
      // ("ट्विन से पूछें") has somewhere to go instead of being clipped.
      height: 68,
      paddingTop: 8,
      paddingBottom: 6,
    },
    tabBarLabelStyle: {
      ...theme.type.tab,
      // Devanagari has ascenders above and matras below; the Latin line
      // height crops them.
      lineHeight: 14,
      paddingTop: 1,
    },
    tabBarLabelPosition: 'below-icon' as const,
    tabBarAllowFontScaling: false,
    tabBarHideOnKeyboard: true,
  } as const;
}

function icon(name: IconName) {
  return ({ color }: { color: string }) => <TabIcon name={name} color={color} />;
}

export function IndividualTabs() {
  const screenOptions = useTabScreenOptions();
  const t = useT();

  return (
    <IndividualTab.Navigator initialRouteName="Home" screenOptions={screenOptions}>
      <IndividualTab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarLabel: t(INDIVIDUAL_TAB_META.Home.tabLabel), tabBarIcon: icon('overview') }}
      />
      <IndividualTab.Screen
        name="Hisaab"
        component={HisaabScreen}
        options={{ tabBarLabel: t(INDIVIDUAL_TAB_META.Hisaab.tabLabel), tabBarIcon: icon('hisaab') }}
      />
      <IndividualTab.Screen
        name="Ask"
        component={AskScreen}
        options={{ tabBarLabel: t(INDIVIDUAL_TAB_META.Ask.tabLabel), tabBarIcon: icon('ask') }}
      />
      <IndividualTab.Screen
        name="Simulate"
        component={SimulateScreen}
        options={{ tabBarLabel: t(INDIVIDUAL_TAB_META.Simulate.tabLabel), tabBarIcon: icon('simulate') }}
      />
      <IndividualTab.Screen
        name="More"
        component={MoreScreen}
        options={{ tabBarLabel: t(INDIVIDUAL_TAB_META.More.tabLabel), tabBarIcon: icon('more') }}
      />
    </IndividualTab.Navigator>
  );
}

export function StartupTabs() {
  const screenOptions = useTabScreenOptions();
  const t = useT();

  return (
    <StartupTab.Navigator initialRouteName="Overview" screenOptions={screenOptions}>
      <StartupTab.Screen
        name="Overview"
        component={StartupOverviewScreen}
        options={{ tabBarLabel: t(STARTUP_TAB_META.Overview.tabLabel), tabBarIcon: icon('overview') }}
      />
      <StartupTab.Screen
        name="Ask"
        component={AskScreen}
        options={{ tabBarLabel: t(STARTUP_TAB_META.Ask.tabLabel), tabBarIcon: icon('ask') }}
      />
      <StartupTab.Screen
        name="Simulate"
        component={SimulateScreen}
        options={{ tabBarLabel: t(STARTUP_TAB_META.Simulate.tabLabel), tabBarIcon: icon('simulate') }}
      />
      <StartupTab.Screen
        name="Alerts"
        component={AlertsScreen}
        options={{ tabBarLabel: t(STARTUP_TAB_META.Alerts.tabLabel), tabBarIcon: icon('alerts') }}
      />
      <StartupTab.Screen
        name="Reports"
        component={ReportsScreen}
        options={{ tabBarLabel: t(STARTUP_TAB_META.Reports.tabLabel), tabBarIcon: icon('reports') }}
      />
    </StartupTab.Navigator>
  );
}
