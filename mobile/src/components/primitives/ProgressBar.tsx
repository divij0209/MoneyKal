import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';

export interface ProgressBarProps {
  /** 0-100. Clamped, so an over-funded goal renders full rather than overflowing. */
  percent: number;
  height?: number;
  style?: ViewStyle;
}

/** The goal/meter bar, matching the web's `.mk-meter__track` + `--ov-ring-track`. */
export function ProgressBar({ percent, height = 6, style }: ProgressBarProps) {
  const theme = useTheme();
  const clamped = Math.max(0, Math.min(Number.isFinite(percent) ? percent : 0, 100));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped) }}
      style={[
        {
          height,
          borderRadius: height / 2,
          backgroundColor: theme.colors.ringTrack,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <View
        style={{
          width: `${clamped}%`,
          height: '100%',
          borderRadius: height / 2,
          backgroundColor: theme.colors.accent,
        }}
      />
    </View>
  );
}
