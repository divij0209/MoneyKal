import React from 'react';
import { View } from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export interface StepProgressProps {
  /** 0-based index of the current step. */
  current: number;
  total: number;
  /** The step's own name, shown beside the counter. */
  label?: string;
}

/**
 * "Step 2 of 3" plus a segmented bar.
 *
 * Segments rather than one continuous fill, so the number of steps left is
 * countable at a glance and not just inferred from a percentage.
 */
export function StepProgress({ current, total, label }: StepProgressProps) {
  const theme = useTheme();

  return (
    <View
      style={{ gap: theme.spacing.sm }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 1, max: total, now: current + 1 }}
      accessibilityLabel={`Step ${current + 1} of ${total}${label ? `: ${label}` : ''}`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text variant="label" color="accent">
          Step {current + 1} of {total}
        </Text>
        {label ? (
          <Text variant="label" color="faint">
            {label}
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: 4 }}>
        {Array.from({ length: total }).map((_, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: 3,
              borderRadius: 2,
              backgroundColor: i <= current ? theme.colors.accent : theme.colors.ringTrack,
            }}
          />
        ))}
      </View>
    </View>
  );
}
