import React from 'react';
import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { useTheme } from '../../theme';
import type { TypeVariant } from '../../theme/typography';

type ColorRole =
  | 'ink'
  | 'muted'
  | 'faint'
  | 'accent'
  | 'onAccent'
  | 'pos'
  | 'neg'
  | 'warn'
  /** Inside a `tone="panel"` Surface, where the ground is ink. */
  | 'onPanel'
  | 'onPanelMuted'
  | 'onPanelAccent'
  | 'inherit';

export interface TextProps extends RNTextProps {
  variant?: TypeVariant;
  color?: ColorRole;
  /** Line up digits in a column — balances, tables, calendars. */
  tabular?: boolean;
  center?: boolean;
}

/**
 * Every string in the app goes through here.
 *
 * React Native's default font is the platform's system face, so a bare <Text>
 * silently renders in Roboto instead of MoneyKal's Poppins/Inter. This
 * component makes that impossible: pick a role, get the right face.
 *
 * `allowFontScaling` is left at its default (on), so the OS font-size setting
 * is respected; the layouts that hold these are built to grow rather than
 * clip, which is also what makes them survive Hindi.
 */
export function Text({
  variant = 'body',
  color = 'ink',
  tabular,
  center,
  style,
  ...rest
}: TextProps) {
  const theme = useTheme();

  const colorMap: Record<Exclude<ColorRole, 'inherit'>, string> = {
    ink: theme.colors.ink,
    muted: theme.colors.inkMuted,
    faint: theme.colors.inkFaint,
    accent: theme.colors.accent,
    onAccent: theme.colors.onAccent,
    pos: theme.colors.pos,
    neg: theme.colors.neg,
    warn: theme.colors.warn,
    onPanel: theme.colors.panelInk,
    onPanelMuted: theme.colors.panelInkMuted,
    onPanelAccent: theme.colors.panelAccent,
  };

  const resolved: TextStyle = {
    ...theme.type[variant],
    ...(color === 'inherit' ? {} : { color: colorMap[color] }),
    ...(tabular ? { fontVariant: ['tabular-nums' as const] } : {}),
    ...(center ? { textAlign: 'center' as const } : {}),
  };

  return <RNText {...rest} style={[resolved, style]} />;
}
