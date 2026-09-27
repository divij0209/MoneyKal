import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';
import { Surface } from './Surface';
import { Text } from './Text';

export interface CardProps {
  children: React.ReactNode;
  /** The uppercase eyebrow above a data block. */
  label?: string;
  title?: string;
  /** Makes the whole card a tap target. */
  onPress?: () => void;
  /** Draws the card in the accent tone — for the one callout on a screen. */
  accent?: boolean;
  padded?: boolean;
  style?: ViewStyle;
  testID?: string;
}

/**
 * An enclosed block with an optional eyebrow and title.
 *
 * Now a thin wrapper over <Surface>, which is where the app's surface tones
 * actually live. Kept as its own component because ~40 call sites use the
 * label/title convenience, and because the name documents intent: reach for
 * Card when a block is genuinely a discrete object. For a section — which is
 * most of what a screen contains — use a SectionHeader and no enclosure at
 * all, or <Surface tone="plain">.
 */
export function Card({
  children,
  label,
  title,
  onPress,
  accent = false,
  padded = true,
  style,
  testID,
}: CardProps) {
  const theme = useTheme();

  return (
    <Surface
      tone={accent ? 'accent' : 'raised'}
      padded={padded}
      onPress={onPress}
      style={style}
      testID={testID}
    >
      {label ? (
        <Text
          variant="label"
          color={accent ? 'accent' : 'faint'}
          style={{ marginBottom: theme.spacing.xs }}
        >
          {label}
        </Text>
      ) : null}
      {title ? (
        <Text variant="heading" style={{ marginBottom: theme.spacing.sm }}>
          {title}
        </Text>
      ) : null}
      <View>{children}</View>
    </Surface>
  );
}
