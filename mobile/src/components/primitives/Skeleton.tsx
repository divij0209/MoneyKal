import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: number;
  style?: ViewStyle;
}

/**
 * A loading placeholder.
 *
 * Pulses gently between 0.65 and 1 rather than 0.4 and 0.85. The old floor
 * made the bar nearly invisible against the off-white ground for half of
 * every cycle, so a screen waiting on a slow request looked blank instead of
 * busy — which is how "it's loading" and "it's broken" become
 * indistinguishable. The fill is `colors.skeleton`, a solid step off the
 * page, for the same reason.
 */
export function Skeleton({ width = '100%', height = 16, radius, style }: SkeletonProps) {
  const theme = useTheme();
  const pulse = useRef(new Animated.Value(0.65)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.65, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: radius ?? theme.radius.sm,
          backgroundColor: theme.colors.skeleton,
          opacity: pulse,
        },
        style as ViewStyle,
      ]}
    />
  );
}

/** A few stacked skeleton lines — the usual "card is loading" shape. */
export function SkeletonBlock({ lines = 3 }: { lines?: number }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.sm }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </View>
  );
}
