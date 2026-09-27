import React from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';

import { Screen, Text } from '../../components';
import { useLanguage } from '../../i18n';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';

/**
 * The frame both auth screens sit in.
 *
 * The desktop pages (twin-app/login.html, register.html) are a two-panel
 * split with a cinematic brand column. On a phone that column becomes a
 * compact brand lockup at the top — the adaptation, rather than a shrunken
 * copy of the split.
 *
 * Carries the `EN | हिं` toggle, because the app bar does not exist yet at
 * this point in the stack and the language has to be changeable before
 * someone can read the form well enough to sign in.
 *
 * The keyboard handling matters more here than anywhere else in the app: the
 * password field is the last thing on a short screen, and on a small Android
 * device the soft keyboard covers it unless the scroll view is allowed to
 * grow. Hence `flexGrow: 1` plus `keyboardShouldPersistTaps` — tapping the
 * primary button while the keyboard is open must submit, not just dismiss.
 */
export function AuthShell({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const theme = useTheme();
  const { lang, toggle } = useLanguage();

  return (
    <Screen padded={false}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xxl,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Brand + language, on one line. */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
            }}
          >
            <Image
              source={require('../../../assets/brand/logo-icon.png')}
              style={{ width: 30, height: 30, resizeMode: 'contain' }}
              accessibilityLabel="MoneyKal"
            />
            <Text
              variant="heading"
              style={{ flex: 1, fontFamily: theme.fonts.displayBold, letterSpacing: -0.3 }}
            >
              MoneyKal
            </Text>

            <Pressable
              onPress={toggle}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={lang === 'en' ? 'Switch to Hindi' : 'अंग्रेज़ी में बदलें'}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 3,
                minHeight: MIN_TOUCH_SIZE - 12,
                paddingHorizontal: theme.spacing.sm,
                opacity: pressed ? 0.55 : 1,
              })}
            >
              <Text
                variant="label"
                style={{
                  color: lang === 'en' ? theme.colors.ink : theme.colors.inkFaint,
                  fontFamily: lang === 'en' ? theme.fonts.bodySemiBold : theme.fonts.bodyMedium,
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
                  fontFamily: lang === 'hi' ? theme.fonts.bodySemiBold : theme.fonts.bodyMedium,
                  textTransform: 'none',
                  fontSize: 11.5,
                }}
              >
                हिं
              </Text>
            </Pressable>
          </View>

          {children}

          {footer ? (
            <>
              <View style={{ flex: 1, minHeight: theme.spacing.xxl }} />
              {footer}
            </>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** The three trust marks the web login page carries, as a quiet ruled row. */
export function TrustRow({ items }: { items: string[] }) {
  const theme = useTheme();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: theme.spacing.sm,
        paddingTop: theme.spacing.lg,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {items.map((item, i) => (
        <React.Fragment key={item}>
          {i > 0 ? (
            <Text variant="label" color="faint">
              ·
            </Text>
          ) : null}
          <Text
            variant="label"
            color="faint"
            style={{ textTransform: 'none', letterSpacing: 0.3 }}
          >
            {item}
          </Text>
        </React.Fragment>
      ))}
    </View>
  );
}
