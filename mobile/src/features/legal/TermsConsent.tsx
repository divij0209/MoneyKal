import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '../../components';
import { useT } from '../../i18n';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { TermsSheet } from './TermsSheet';

export interface TermsConsentProps {
  value: boolean;
  onChange: (next: boolean) => void;
  /** Shown under the row once a submit has been blocked. */
  error?: string | null;
  disabled?: boolean;
}

/**
 * The acceptance checkbox both auth screens carry.
 *
 * The row is one checkbox target — tapping the box or the words toggles it —
 * except on the two document names, which open the Terms in a sheet instead.
 * Reading is not accepting, so those taps must not tick the box; a nested
 * `<Text onPress>` claims the touch before the surrounding Pressable sees it.
 *
 * The mark is drawn rather than imported: the icon set has no tick, and this
 * matches the web's `.mk-check__box` — a hairline square that fills with the
 * accent when checked.
 */
export function TermsConsent({ value, onChange, error, disabled }: TermsConsentProps) {
  const theme = useTheme();
  const t = useT();
  const [sheet, setSheet] = useState<{ open: boolean; section: string | null }>({
    open: false,
    section: null,
  });

  const linkStyle = {
    color: theme.colors.accent,
    fontFamily: theme.fonts.bodySemiBold,
    textDecorationLine: 'underline' as const,
  };

  function openTerms(section: string | null) {
    setSheet({ open: true, section });
  }

  return (
    <View>
      <Pressable
        onPress={() => !disabled && onChange(!value)}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: value, disabled: !!disabled }}
        accessibilityLabel={t('terms.consentA11y')}
        accessibilityHint={t('terms.consentHint')}
        hitSlop={8}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: theme.spacing.md,
          minHeight: MIN_TOUCH_SIZE,
          paddingVertical: theme.spacing.xs,
          opacity: pressed || disabled ? 0.7 : 1,
        })}
      >
        <View
          style={{
            width: 20,
            height: 20,
            marginTop: 2,
            borderRadius: theme.radius.sm,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1.5,
            borderColor: value
              ? theme.colors.accent
              : error
                ? theme.colors.warn
                : theme.colors.lineStrong,
            backgroundColor: value ? theme.colors.accent : 'transparent',
          }}
        >
          {value ? (
            /* A tick, drawn from two rotated rules — no icon dependency. */
            <View style={{ width: 11, height: 11 }}>
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 5,
                  width: 5,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: theme.colors.onAccent,
                  transform: [{ rotate: '45deg' }],
                }}
              />
              <View
                style={{
                  position: 'absolute',
                  left: 2.5,
                  top: 3.5,
                  width: 9,
                  height: 2,
                  borderRadius: 1,
                  backgroundColor: theme.colors.onAccent,
                  transform: [{ rotate: '-50deg' }],
                }}
              />
            </View>
          ) : null}
        </View>

        <Text variant="bodySmall" color="muted" style={{ flex: 1, lineHeight: 19 }}>
          {t('terms.agreePrefix')}{' '}
          <Text
            variant="bodySmall"
            style={linkStyle}
            onPress={() => openTerms(null)}
            accessibilityRole="button"
            accessibilityLabel={t('terms.openTermsA11y')}
            suppressHighlighting
          >
            {t('terms.title')}
          </Text>
          {' '}
          {t('terms.and')}{' '}
          <Text
            variant="bodySmall"
            style={linkStyle}
            onPress={() => openTerms('privacy')}
            accessibilityRole="button"
            accessibilityLabel={t('terms.openPrivacyA11y')}
            suppressHighlighting
          >
            {t('terms.privacy')}
          </Text>
          .
        </Text>
      </Pressable>

      {error ? (
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.warn, marginTop: theme.spacing.xs, marginLeft: 32 }}
          accessibilityLiveRegion="assertive"
          accessibilityRole="alert"
        >
          {error}
        </Text>
      ) : null}

      <TermsSheet
        visible={sheet.open}
        initialSection={sheet.section}
        onClose={() => setSheet({ open: false, section: null })}
      />
    </View>
  );
}
