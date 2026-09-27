import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export type MetricSize = 'hero' | 'lg' | 'md' | 'sm';
export type MetricTone = 'ink' | 'accent' | 'onPanel' | 'onPanelAccent';
export type DeltaDirection = 'up' | 'down' | 'flat';

export interface MetricProps {
  label?: string;
  /**
   * Already formatted. This component never formats currency: every figure in
   * MoneyKal arrives from the backend as a display string (`*_display`), and
   * a client that re-formats is a client that will eventually disagree with
   * the server about what a number says.
   */
  value: string;
  caption?: string;
  delta?: string;
  /** Which way the delta points. Drives the caret and the colour. */
  direction?: DeltaDirection;
  size?: MetricSize;
  tone?: MetricTone;
  style?: ViewStyle;
}

const VARIANT: Record<MetricSize, 'hero' | 'metric' | 'metricSmall' | 'heading'> = {
  hero: 'hero',
  lg: 'metric',
  md: 'metricSmall',
  sm: 'heading',
};

/** How far the figure may shrink before it wraps instead. A long rupee amount
 *  — ₹1,24,50,000 — has to fit on one line at every size. */
const MIN_SCALE: Record<MetricSize, number> = {
  hero: 0.55,
  lg: 0.6,
  md: 0.7,
  sm: 0.8,
};

/**
 * A labelled financial figure.
 *
 * The delta is carried by a caret and by cyan-vs-neutral, never by red/green:
 * the palette has three colours and "down" is not a fourth. Direction is also
 * stated in the accessibility label, so it does not depend on colour at all.
 */
export function Metric({
  label,
  value,
  caption,
  delta,
  direction = 'flat',
  size = 'lg',
  tone = 'ink',
  style,
}: MetricProps) {
  const theme = useTheme();

  const onPanel = tone === 'onPanel' || tone === 'onPanelAccent';

  const valueColor =
    tone === 'accent' ? theme.colors.accent
    : tone === 'onPanelAccent' ? theme.colors.panelAccent
    : onPanel ? theme.colors.panelInk
    : theme.colors.ink;

  const labelColor = onPanel ? theme.colors.panelInkMuted : theme.colors.inkFaint;
  const captionColor = onPanel ? theme.colors.panelInkMuted : theme.colors.inkMuted;

  const deltaColor =
    direction === 'flat'
      ? captionColor
      : onPanel
        ? theme.colors.panelAccent
        : theme.colors.accent;

  const caret = direction === 'up' ? '↑' : direction === 'down' ? '↓' : '';
  const directionWord =
    direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'unchanged';

  return (
    <View style={[{ gap: size === 'hero' ? theme.spacing.sm : theme.spacing.xxs }, style]}>
      {label ? (
        <Text variant="label" style={{ color: labelColor }}>
          {label}
        </Text>
      ) : null}

      <Text
        variant={VARIANT[size]}
        tabular
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={MIN_SCALE[size]}
        style={{ color: valueColor }}
      >
        {value}
      </Text>

      {delta || caption ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: theme.spacing.sm,
          }}
        >
          {delta ? (
            <Text
              variant="bodySmall"
              tabular
              accessibilityLabel={`${delta} ${directionWord}`}
              style={{ color: deltaColor, fontFamily: theme.fonts.bodySemiBold }}
            >
              {caret ? `${caret} ` : ''}
              {delta}
            </Text>
          ) : null}
          {caption ? (
            <Text variant="bodySmall" style={{ color: captionColor }}>
              {caption}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
