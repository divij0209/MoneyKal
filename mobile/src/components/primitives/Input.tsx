import React, { useState } from 'react';
import {
  Pressable,
  TextInput,
  View,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { Text } from './Text';

export interface InputProps extends Omit<TextInputProps, 'style'> {
  label?: string;
  /** Shown under the field, in the warn colour. */
  error?: string;
  hint?: string;
  required?: boolean;
  /** Adds the show/hide eye control, mirroring the web login form. */
  secureToggle?: boolean;
  containerStyle?: ViewStyle;
}

/**
 * The app's text field, matching the web's `.ob-input`: surface-2 ground,
 * hairline border that turns accent on focus, `--radius` corners.
 */
export function Input({
  label,
  error,
  hint,
  required,
  secureToggle,
  containerStyle,
  secureTextEntry,
  ...rest
}: InputProps) {
  const theme = useTheme();
  const t = useT();
  const [focused, setFocused] = useState(false);
  const [revealed, setRevealed] = useState(false);

  const isSecure = secureToggle ? !revealed : secureTextEntry;

  return (
    <View style={[{ gap: theme.spacing.xs }, containerStyle]}>
      {label ? (
        <Text variant="label" color="faint">
          {label}
          {required ? <Text variant="label" color="accent">{' *'}</Text> : null}
        </Text>
      ) : null}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: theme.colors.surface2,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: error
            ? theme.colors.warn
            : focused
              ? theme.colors.accent
              : theme.colors.line,
          paddingHorizontal: theme.spacing.md,
        }}
      >
        <TextInput
          {...rest}
          secureTextEntry={isSecure}
          onFocus={(e) => {
            setFocused(true);
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            rest.onBlur?.(e);
          }}
          placeholderTextColor={theme.colors.inkFaint}
          selectionColor={theme.colors.accent}
          style={{
            flex: 1,
            height: 48,
            color: theme.colors.ink,
            ...theme.type.body,
          }}
        />

        {secureToggle ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={revealed ? t('auth.hide') : t('auth.show')}
            style={{ paddingLeft: theme.spacing.sm }}
          >
            <Text
              variant="label"
              color="accent"
              // Devanagari has no case, so the label variant's uppercase
              // transform would be a no-op there and the tracking too wide.
              style={{ textTransform: 'none', letterSpacing: 0.6 }}
            >
              {revealed ? t('auth.hide') : t('auth.show')}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {error ? (
        <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
          {error}
        </Text>
      ) : hint ? (
        <Text variant="bodySmall" color="faint">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}
