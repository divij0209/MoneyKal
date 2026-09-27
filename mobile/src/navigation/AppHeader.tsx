import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Text } from '../components';
import { useLanguage } from '../i18n';
import { MIN_TOUCH_SIZE, useTheme, useThemeControls } from '../theme';

/**
 * The app bar.
 *
 * Deliberately quiet: a hairline, a title in Poppins, a subtitle in Inter, and
 * at most three 44pt controls. No filled ground, no elevation — the page
 * scrolls under a rule, which is what keeps the screens below feeling like
 * documents rather than like a stack of chrome.
 *
 * The three controls mirror the web's topbar plus the landing page's language
 * switch: `EN | हिं` (twin-app/js/i18n.js), the sun/moon theme toggle from
 * dashboard.html, and an account button that replaces the web's bare "Log
 * out" link because a phone needs somewhere to put settings.
 *
 * That account button is also how the Startup persona reaches Settings: its
 * five web nav items fill the tab bar exactly, leaving no room for a "More"
 * tab the way the Individual persona has.
 */
export interface AppHeaderProps {
  title: string;
  subtitle?: string;
  onAccountPress?: () => void;
  /** Shows a back chevron instead of the account button. */
  onBackPress?: () => void;
  /** Hides the language and theme toggles — for pushed detail screens where
   *  the back affordance and the title are the whole job. */
  minimal?: boolean;
}

function IconButton({
  onPress,
  label,
  children,
}: {
  onPress: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        minWidth: MIN_TOUCH_SIZE - 8,
        height: MIN_TOUCH_SIZE - 8,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.55 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

export function AppHeader({
  title,
  subtitle,
  onAccountPress,
  onBackPress,
  minimal = false,
}: AppHeaderProps) {
  const theme = useTheme();
  const { toggle: toggleTheme } = useThemeControls();
  const { lang, toggle: toggleLang } = useLanguage();
  const insets = useSafeAreaInsets();

  const iconColor = theme.colors.inkMuted;

  return (
    <View
      style={{
        paddingTop: insets.top,
        backgroundColor: theme.colors.bg,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.xs,
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.sm,
          paddingBottom: theme.spacing.md,
        }}
      >
        {onBackPress ? (
          <Pressable
            onPress={onBackPress}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => ({
              width: 32,
              height: MIN_TOUCH_SIZE - 8,
              justifyContent: 'center',
              marginLeft: -6,
              opacity: pressed ? 0.55 : 1,
            })}
          >
            <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path
                d="m15 18-6-6 6-6"
                stroke={theme.colors.ink}
                strokeWidth={1.9}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </Pressable>
        ) : null}

        <View style={{ flex: 1, gap: 1 }}>
          <Text variant="title" numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text variant="bodySmall" color="faint" numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {!minimal ? (
          <>
            {/* Language — the landing page's `EN | हिं` switch. The active
                side is the one in full ink; the other is the affordance. */}
            <IconButton
              onPress={toggleLang}
              label={lang === 'en' ? 'Switch to Hindi' : 'अंग्रेज़ी में बदलें'}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
                <Text
                  variant="label"
                  style={{
                    color: lang === 'en' ? theme.colors.ink : theme.colors.inkFaint,
                    fontFamily:
                      lang === 'en' ? theme.fonts.bodySemiBold : theme.fonts.bodyMedium,
                  }}
                >
                  EN
                </Text>
                <Text variant="label" color="faint">
                  |
                </Text>
                <Text
                  variant="label"
                  style={{
                    color: lang === 'hi' ? theme.colors.ink : theme.colors.inkFaint,
                    fontFamily:
                      lang === 'hi' ? theme.fonts.bodySemiBold : theme.fonts.bodyMedium,
                    // Devanagari sits taller than Latin; the label variant's
                    // uppercase transform is also meaningless for it.
                    textTransform: 'none',
                    fontSize: 11.5,
                  }}
                >
                  हिं
                </Text>
              </View>
            </IconButton>

            {/* Theme — the same sun/moon pair the web topbar carries. Shows
                the icon of the theme you would switch *to*. */}
            <IconButton onPress={toggleTheme} label="Switch theme">
              {theme.name === 'dark' ? (
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                  <Circle cx="12" cy="12" r="4.5" stroke={iconColor} strokeWidth={1.8} />
                  {[
                    [12, 1.5, 12, 3.5],
                    [12, 20.5, 12, 22.5],
                    [4.2, 4.2, 5.6, 5.6],
                    [18.4, 18.4, 19.8, 19.8],
                    [1.5, 12, 3.5, 12],
                    [20.5, 12, 22.5, 12],
                    [4.2, 19.8, 5.6, 18.4],
                    [18.4, 5.6, 19.8, 4.2],
                  ].map(([x1, y1, x2, y2], i) => (
                    <Line
                      key={i}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={iconColor}
                      strokeWidth={1.8}
                      strokeLinecap="round"
                    />
                  ))}
                </Svg>
              ) : (
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                  <Path
                    d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
                    stroke={iconColor}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
              )}
            </IconButton>
          </>
        ) : null}

        {onAccountPress ? (
          <IconButton onPress={onAccountPress} label="Account and settings">
            <Svg width={19} height={19} viewBox="0 0 24 24" fill="none">
              <Path
                d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"
                stroke={iconColor}
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Circle cx="12" cy="7" r="3.6" stroke={iconColor} strokeWidth={1.8} />
            </Svg>
          </IconButton>
        ) : null}
      </View>
    </View>
  );
}
