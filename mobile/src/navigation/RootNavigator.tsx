import React, { useEffect, useState } from 'react';
import { NavigationContainer, type Theme as NavTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as SplashScreen from 'expo-splash-screen';

import { LoginScreen } from '../features/auth/LoginScreen';
import { RegisterScreen } from '../features/auth/RegisterScreen';
import { AccountTypeScreen } from '../features/onboarding/AccountTypeScreen';
import { IndividualProfileScreen } from '../features/onboarding/IndividualProfileScreen';
import { StartupFinancialSetupScreen } from '../features/onboarding/StartupFinancialSetupScreen';
import { StartupManualEntryScreen } from '../features/onboarding/StartupManualEntryScreen';
import { StartupProfileScreen } from '../features/onboarding/StartupProfileScreen';
import { loadDraft } from '../features/onboarding/draft';
import { useAuth } from '../store';
import { LockScreen } from '../features/lock/LockScreen';
import { SetPasscodeScreen } from '../features/lock/SetPasscodeScreen';
import { useTheme } from '../theme';
import { AppNavigator } from './AppNavigator';
import { AppHeader } from './AppHeader';
import { linking } from './linking';
import type { AuthStackParamList, OnboardingStackParamList, RootStackParamList } from './types';

const RootStack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const OnboardingStack = createNativeStackNavigator<OnboardingStackParamList>();

function AuthNavigator() {
  return (
    <AuthStack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Register" component={RegisterScreen} />
    </AuthStack.Navigator>
  );
}

/**
 * The onboarding wizard.
 *
 * Where it resumes depends on the saved draft, mirroring the web's
 * `register.html?resume=true` behaviour: a user who picked a type and then
 * closed the app comes back to their persona's form rather than to step one.
 */
function OnboardingNavigator() {
  const [initialRoute, setInitialRoute] = useState<keyof OnboardingStackParamList | null>(null);

  useEffect(() => {
    loadDraft().then((draft) => {
      setInitialRoute(
        draft.accountType === 'startup'
          ? 'StartupProfile'
          : draft.accountType === 'individual'
            ? 'IndividualProfile'
            : 'AccountType',
      );
    });
  }, []);

  // Nothing to show until the draft is read — a frame or two, and picking the
  // wrong start route would push the user through a step they already did.
  if (!initialRoute) return null;

  return (
    <OnboardingStack.Navigator
      initialRouteName={initialRoute}
      screenOptions={{ headerShown: false, animation: 'slide_from_right' }}
    >
      <OnboardingStack.Screen name="AccountType" component={AccountTypeScreen} />
      <OnboardingStack.Screen
        name="IndividualProfile"
        component={IndividualProfileScreen}
        options={({ navigation }) => ({
          headerShown: true,
          header: () => (
            <AppHeader
              title="Personal details"
              subtitle="Step 3 of 3"
              onBackPress={navigation.canGoBack() ? navigation.goBack : undefined}
            />
          ),
        })}
      />
      <OnboardingStack.Screen
        name="StartupProfile"
        component={StartupProfileScreen}
        options={({ navigation }) => ({
          headerShown: true,
          header: () => (
            <AppHeader
              title="Startup profile"
              subtitle="Step 3 of 5"
              onBackPress={navigation.canGoBack() ? navigation.goBack : undefined}
            />
          ),
        })}
      />
      <OnboardingStack.Screen
        name="StartupFinancialSetup"
        component={StartupFinancialSetupScreen}
        options={({ navigation }) => ({
          headerShown: true,
          header: () => (
            <AppHeader
              title="Financial setup"
              subtitle="Step 4 of 5"
              onBackPress={navigation.canGoBack() ? navigation.goBack : undefined}
            />
          ),
        })}
      />
      <OnboardingStack.Screen
        name="StartupManualEntry"
        component={StartupManualEntryScreen}
        options={({ navigation }) => ({
          headerShown: true,
          header: () => (
            <AppHeader
              title="Financial details"
              subtitle="Step 5 of 5"
              onBackPress={navigation.canGoBack() ? navigation.goBack : undefined}
            />
          ),
        })}
      />
    </OnboardingStack.Navigator>
  );
}

/** Bridges MoneyKal's palette into React Navigation's own theme, so the
 *  container background and card transitions match the app rather than
 *  flashing the library's default white. */
function useNavigationTheme(): NavTheme {
  const theme = useTheme();
  return {
    dark: theme.name === 'dark',
    colors: {
      primary: theme.colors.accent,
      background: theme.colors.bg,
      card: theme.colors.surface,
      text: theme.colors.ink,
      border: theme.colors.line,
      notification: theme.colors.accent,
    },
    fonts: {
      regular: { fontFamily: theme.fonts.body, fontWeight: '400' },
      medium: { fontFamily: theme.fonts.bodyMedium, fontWeight: '500' },
      bold: { fontFamily: theme.fonts.bodySemiBold, fontWeight: '600' },
      heavy: { fontFamily: theme.fonts.displayBold, fontWeight: '700' },
    },
  };
}

/**
 * Splash -> Auth -> Onboarding -> Persona app.
 *
 * The branch reproduces the web's login redirect (twin-app/js/auth.js):
 * a session with a `profile_key` goes to the dashboard, a session without one
 * goes back to finish onboarding, and no session goes to login. Rendering
 * whole stacks conditionally — rather than navigating imperatively — means the
 * signed-out user has no signed-in screens in their history to go back to.
 */
/** `SetPasscodeScreen` in create mode, as a component the navigator can take. */
function CreatePasscodeScreen() {
  return <SetPasscodeScreen mode="create" />;
}

export function RootNavigator() {
  const { status } = useAuth();
  const navTheme = useNavigationTheme();

  // Hold the native splash until the keychain has been read, so a returning
  // user never sees the login screen flash before their session resolves.
  useEffect(() => {
    if (status !== 'loading') {
      SplashScreen.hideAsync().catch(() => {
        /* Already hidden. */
      });
    }
  }, [status]);

  if (status === 'loading') return null;

  return (
    <NavigationContainer theme={navTheme} linking={linking}>
      <RootStack.Navigator screenOptions={{ headerShown: false }}>
        {status === 'signedOut' ? (
          <RootStack.Screen name="Auth" component={AuthNavigator} />
        ) : status === 'needsOnboarding' ? (
          <RootStack.Screen name="Onboarding" component={OnboardingNavigator} />
        ) : status === 'needsPasscode' ? (
          /* Onboarded but no passcode yet — first run, or straight after a
             reset. Rendered as the whole stack so it cannot be skipped. */
          <RootStack.Screen name="SetPasscode" component={CreatePasscodeScreen} />
        ) : status === 'locked' ? (
          /* The persona stack is not mounted at all while locked, so no screen
             holding financial data exists behind this one. */
          <RootStack.Screen name="Lock" component={LockScreen} />
        ) : (
          <RootStack.Screen name="App" component={AppNavigator} />
        )}
      </RootStack.Navigator>
    </NavigationContainer>
  );
}
