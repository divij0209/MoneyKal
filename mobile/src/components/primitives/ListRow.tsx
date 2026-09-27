import React from 'react';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { Text } from './Text';

export interface ListRowProps {
  label: string;
  detail?: string;
  /** Rendered on the left — usually a TabIcon. */
  leading?: React.ReactNode;
  /** Replaces the chevron on the right. */
  trailing?: React.ReactNode;
  onPress?: () => void;
  /** Renders the label in the warn colour, for destructive rows like Log out. */
  destructive?: boolean;
  showChevron?: boolean;
}

/** A tappable settings/navigation row. */
export function ListRow({
  label,
  detail,
  leading,
  trailing,
  onPress,
  destructive = false,
  showChevron = true,
}: ListRowProps) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        minHeight: MIN_TOUCH_SIZE,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        backgroundColor: pressed && onPress ? theme.colors.surface2 : 'transparent',
      })}
    >
      {leading ? <View style={{ width: 24, alignItems: 'center' }}>{leading}</View> : null}

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" style={destructive ? { color: theme.colors.warn } : undefined}>
          {label}
        </Text>
        {detail ? (
          <Text variant="bodySmall" color="faint" numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>

      {trailing ??
        (onPress && showChevron ? (
          <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
            <Path
              d="m9 18 6-6-6-6"
              stroke={theme.colors.inkFaint}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </Svg>
        ) : null)}
    </Pressable>
  );
}
