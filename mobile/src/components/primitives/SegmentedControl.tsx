import React from 'react';
import { Pressable, ScrollView, View, type ViewStyle } from 'react-native';

import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { Text } from './Text';

export interface Segment<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  segments: readonly Segment<T>[];
  value: T;
  onChange: (next: T) => void;
  /**
   * Lets the row scroll horizontally instead of dividing the width evenly.
   * Required for Hindi: "अवलोकन / श्रेणियाँ / रुझान" is materially wider than
   * "Overview / Categories / Trends", and three equal columns would clip it.
   */
  scrollable?: boolean;
  style?: ViewStyle;
}

/**
 * The in-screen view switcher — Overview / Categories / Trends on Hisaab, the
 * step switcher on Tax.
 *
 * Drawn as an underline rather than as a pill group. A filled pill on an
 * off-white ground competes with the buttons; an underline reads as
 * navigation and leaves the accent free to mean "action".
 */
export function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
  scrollable = false,
  style,
}: SegmentedControlProps<T>) {
  const theme = useTheme();

  const items = segments.map((segment) => {
    const active = segment.value === value;
    return (
      <Pressable
        key={segment.value}
        onPress={() => onChange(segment.value)}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        accessibilityLabel={segment.label}
        style={({ pressed }) => ({
          flex: scrollable ? undefined : 1,
          minHeight: MIN_TOUCH_SIZE - 8,
          paddingHorizontal: scrollable ? theme.spacing.lg : theme.spacing.sm,
          paddingBottom: theme.spacing.sm,
          alignItems: 'center',
          justifyContent: 'flex-end',
          borderBottomWidth: 2,
          borderBottomColor: active ? theme.colors.accent : 'transparent',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Text
          variant="bodySmall"
          numberOfLines={1}
          style={{
            fontFamily: active ? theme.fonts.bodySemiBold : theme.fonts.bodyMedium,
            color: active ? theme.colors.ink : theme.colors.inkFaint,
          }}
        >
          {segment.label}
        </Text>
      </Pressable>
    );
  });

  const rail: ViewStyle = {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.line,
  };

  if (scrollable) {
    return (
      <View style={[rail, style]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ flexGrow: 1 }}
        >
          {items}
        </ScrollView>
      </View>
    );
  }

  return <View style={[{ flexDirection: 'row' }, rail, style]}>{items}</View>;
}
