import React from 'react';
import { ActivityIndicator, Pressable, View, type ViewStyle } from 'react-native';

import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { Text } from './Text';

export type ButtonVariant =
  | 'primary'
  | 'outline'
  | 'ghost'
  | 'danger'
  /** For use inside a `tone="panel"` Surface, where the ground is ink. */
  | 'onPanel';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  /** Rendered before the label — an icon, usually. */
  leading?: React.ReactNode;
  /** Rendered after the label. */
  trailing?: React.ReactNode;
  fullWidth?: boolean;
  style?: ViewStyle;
  testID?: string;
  accessibilityHint?: string;
}

const HEIGHTS: Record<ButtonSize, number> = {
  sm: MIN_TOUCH_SIZE,
  md: 50,
  lg: 56,
};

/**
 * The button family.
 *
 * `primary` is a solid accent fill and there should be one visible at a time —
 * on a financial screen, two equally-weighted filled buttons means neither is
 * the answer. Everything secondary is `outline` or `ghost`.
 *
 * Every size clears the 44pt minimum touch target. Labels wrap to two lines
 * rather than truncating, because a Hindi label is routinely wider than its
 * English counterpart and a clipped verb is worse than a taller button.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  leading,
  trailing,
  fullWidth = true,
  style,
  testID,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();
  const isDisabled = disabled || loading;

  const base: ViewStyle = {
    minHeight: HEIGHTS[size],
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: theme.spacing.sm,
    paddingHorizontal: size === 'sm' ? theme.spacing.lg : theme.spacing.xl,
    paddingVertical: theme.spacing.sm,
    alignSelf: fullWidth ? 'stretch' : 'flex-start',
    opacity: isDisabled ? 0.45 : 1,
  };

  const variants: Record<ButtonVariant, ViewStyle> = {
    primary: { backgroundColor: theme.colors.btnBgSolid },
    outline: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.colors.lineStrong,
    },
    ghost: { backgroundColor: 'transparent', paddingHorizontal: theme.spacing.sm },
    danger: {
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: theme.colors.warn,
    },
    onPanel: { backgroundColor: theme.colors.panelAccent },
  };

  const labelColor =
    variant === 'primary' ? theme.colors.onAccent
    : variant === 'onPanel' ? theme.colors.panel
    : variant === 'danger' ? theme.colors.warn
    : variant === 'outline' ? theme.colors.ink
    : theme.colors.accent;

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      style={({ pressed }) => [
        base,
        variants[variant],
        pressed && !isDisabled ? { opacity: 0.75 } : null,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={labelColor} />
      ) : (
        <>
          {leading ? <View>{leading}</View> : null}
          <Text
            variant="button"
            numberOfLines={2}
            style={{ color: labelColor, textAlign: 'center', flexShrink: 1 }}
          >
            {label}
          </Text>
          {trailing ? <View>{trailing}</View> : null}
        </>
      )}
    </Pressable>
  );
}
