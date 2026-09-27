import React from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Text, type GlyphName } from '../../../components';
import { MIN_TOUCH_SIZE, useTheme } from '../../../theme';

/**
 * The entry into a full-screen experience — VARTA and live.life.fully.
 *
 * Both are deliberately not tabs, matching the web, where the
 * live.life.fully portal is explicitly not a `.navitem`. On the phone they
 * are a pair of rows at the foot of Home.
 *
 * Drawn as a ruled row with a cyan glyph rather than as a bordered card. The
 * old version gave each an accent-bordered box, which put two more enclosures
 * on a screen that already has two and made the bottom of the dashboard read
 * as heavier than the top.
 */
export function PortalRow({
  title,
  subtitle,
  glyph,
  onPress,
  first = false,
}: {
  title: string;
  subtitle: string;
  glyph: GlyphName;
  onPress: () => void;
  /** Draws the top rule. Set on the first row of a pair. */
  first?: boolean;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title} — ${subtitle}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.lg,
        minHeight: MIN_TOUCH_SIZE + 16,
        paddingVertical: theme.spacing.lg,
        borderTopWidth: first ? 1 : 0,
        borderTopColor: theme.colors.line,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
        backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
      })}
    >
      <View
        style={{
          width: 38,
          height: 38,
          borderRadius: 19,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.accentTint,
        }}
      >
        <Glyph name={glyph} color={theme.colors.accent} size={18} />
      </View>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="heading" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="bodySmall" color="faint" numberOfLines={2}>
          {subtitle}
        </Text>
      </View>

      <Glyph name="chevronRight" color={theme.colors.inkFaint} size={16} />
    </Pressable>
  );
}
