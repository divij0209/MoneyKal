import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { elevation, palettes, radius, spacing, type Palette, type ThemeName } from './tokens';
import { fontFamily, typeScale } from './typography';

/**
 * Theme state, mirroring how the web app behaves.
 *
 * The web stores an explicit choice under `moneykal_ov_theme` and treats dark
 * as the default when nothing is stored. Mobile keeps the explicit choice but
 * adds a third state the web has no concept of: "follow the device", which is
 * what a phone user expects and what `userInterfaceStyle: automatic` in
 * app.config.ts enables. An explicit choice always beats the device setting.
 *
 * Under "system", an unknown device scheme resolves to LIGHT rather than dark:
 * MoneyKal on a phone leads with the off-white ground, and dark is the
 * alternate rather than the default.
 */

export type ThemePreference = ThemeName | 'system';

const STORAGE_KEY = 'moneykal_theme_preference';

export interface Theme {
  name: ThemeName;
  colors: Palette;
  spacing: typeof spacing;
  radius: typeof radius;
  type: typeof typeScale;
  fonts: typeof fontFamily;
  shadow: (typeof elevation)['card'][ThemeName];
  /** The one genuinely raised surface — the feature panel and sheets. */
  panelShadow: (typeof elevation)['panel'][ThemeName];
}

interface ThemeContextValue {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function buildTheme(name: ThemeName): Theme {
  return {
    name,
    colors: palettes[name],
    spacing,
    radius,
    type: typeScale,
    fonts: fontFamily,
    shadow: elevation.card[name],
    panelShadow: elevation.panel[name],
  };
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const deviceScheme = useColorScheme();
  const [preference, setPreferenceState] = useState<ThemePreference>('system');

  // Restore the stored preference. Until it resolves the app renders against
  // the device scheme, which is the same answer in the overwhelming majority
  // of cases and avoids a flash of the wrong theme.
  useEffect(() => {
    let cancelled = false;
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) return;
        if (stored === 'light' || stored === 'dark' || stored === 'system') {
          setPreferenceState(stored);
        }
      })
      .catch(() => {
        /* Storage unavailable — the device scheme is a fine answer. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    SecureStore.setItemAsync(STORAGE_KEY, next).catch(() => {
      /* Non-fatal: the choice just won't survive a restart. */
    });
  }, []);

  // Resolve to a concrete theme. `system` follows the device; anything else
  // wins over it. Matches the web's "explicit choice beats default" rule.
  const resolved: ThemeName =
    preference === 'system' ? (deviceScheme === 'dark' ? 'dark' : 'light') : preference;

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setPreference]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme: buildTheme(resolved), preference, setPreference, toggle }),
    [resolved, preference, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx.theme;
}

export function useThemeControls() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemeControls must be used inside <ThemeProvider>');
  return { preference: ctx.preference, setPreference: ctx.setPreference, toggle: ctx.toggle };
}
