import React from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Text, type GlyphName } from '../../../components';
import { MIN_TOUCH_SIZE, useTheme } from '../../../theme';

export interface QuickAction {
  key: string;
  label: string;
  glyph: GlyphName;
  onPress: () => void;
}

/**
 * Step 5 of the dashboard's hierarchy: WHAT CAN I DO ABOUT IT.
 *
 * A row of four verbs, directly under the recommendation that prompted them.
 * Drawn as icon-over-label tiles with a hairline, not as four filled cards:
 * these are affordances, and filling them would give them the same visual
 * weight as the position panel above.
 *
 * Four is the limit. A fifth makes the labels too narrow to survive Hindi,
 * and anything that does not fit belongs on More.
 */
export function ActionRow({ actions }: { actions: QuickAction[] }) {
  const theme = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
      {actions.map((action) => (
        <Pressable
          key={action.key}
          onPress={action.onPress}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={({ pressed }) => ({
            flex: 1,
            minHeight: MIN_TOUCH_SIZE + 28,
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.xs,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: pressed ? theme.colors.accentBorder : theme.colors.line,
            backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
          })}
        >
          <Glyph name={action.glyph} color={theme.colors.accent} size={19} />
          <Text
            variant="label"
            center
            numberOfLines={2}
            style={{
              fontSize: 9.5,
              letterSpacing: 0.3,
              // Devanagari action labels are longer and must not be cropped;
              // the uppercase transform means nothing for them either.
              textTransform: 'none',
              color: theme.colors.inkMuted,
            }}
          >
            {action.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
