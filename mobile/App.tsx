import React, { useCallback, useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClientProvider } from '@tanstack/react-query';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';

import {
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from '@expo-google-fonts/poppins';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';

import { I18nProvider } from './src/i18n';
import { RootNavigator } from './src/navigation/RootNavigator';
import { AuthProvider, ProfileProvider, queryClient } from './src/store';
import { ThemeProvider } from './src/theme';

/**
 * MoneyKal — app entry.
 *
 * Provider order matters: the theme is needed by every screen, the query
 * client by anything that fetches, auth wires the API client before a request
 * can be made, and the profile query depends on auth having resolved.
 */

// Called at module scope, as the SDK 57 docs require — inside a component it
// would run after the first frame, which is too late to hold the splash.
SplashScreen.preventAutoHideAsync().catch(() => {
  /* Already hidden, or unsupported in this runtime. */
});

export default function App() {
  // Two families, four weights each. See src/theme/typography.ts for why the
  // app carries Poppins + Inter and nothing else.
  const [fontsLoaded, fontError] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  // A font that fails to load must not brick the app — React Native falls back
  // to the system face, which is ugly but usable. Better than a blank screen.
  const ready = fontsLoaded || !!fontError;

  useEffect(() => {
    if (fontError) {
      console.warn('MoneyKal fonts failed to load; falling back to system faces.', fontError);
    }
  }, [fontError]);

  const onLayout = useCallback(() => {
    if (ready) {
      SplashScreen.hideAsync().catch(() => {
        /* RootNavigator may have hidden it already. */
      });
    }
  }, [ready]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={{ flex: 1 }} onLayout={onLayout}>
        <SafeAreaProvider>
          <ThemeProvider>
            <I18nProvider>
              <QueryClientProvider client={queryClient}>
                <AuthProvider>
                  <ProfileProvider>
                    <RootNavigator />
                  </ProfileProvider>
                </AuthProvider>
              </QueryClientProvider>
            </I18nProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </View>
    </GestureHandlerRootView>
  );
}
