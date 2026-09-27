import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';
import { Text } from './Text';

export type ChipTone = 'neutral' | 'accent' | 'warn' | 'positive';

export interface ChipProps {
  label: string;
  tone?: ChipTone;
  style?: ViewStyle;
}

/** The small uppercase mono pill the web uses for status, persona and source
 *  tags (`.chip`, `.ov-cal__key`, the Hisaab source badges). */
export function Chip({ label, tone = 'neutral', style }: ChipProps) {
  const theme = useTheme();

  const tones: Record<ChipTone, { bg: string; fg: string }> = {
    neutral: { bg: theme.colors.surface3, fg: theme.colors.inkMuted },
    accent: { bg: theme.colors.accentTint, fg: theme.colors.accent },
    warn: { bg: theme.colors.warnTint, fg: theme.colors.warn },
    positive: { bg: theme.colors.posTint, fg: theme.colors.pos },
  };
  const { bg, fg } = tones[tone];

  return (
    <View
      style={[
        {
          backgroundColor: bg,
          borderRadius: theme.radius.sm,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: 3,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text variant="label" style={{ color: fg, letterSpacing: 0.8 }}>
        {label}
      </Text>
    </View>
  );
}
