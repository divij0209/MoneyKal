import React from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, type GlyphName } from '../icons/MoneyKalIcons';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { Text } from './Text';

export interface SectionHeaderProps {
  title: string;
  icon?: GlyphName;
  /** Optional right-hand action, matching the web's `.dh-head__action`. */
  actionLabel?: string;
  onAction?: () => void;
  actionIcon?: GlyphName;
  subtitle?: string;
}

/**
 * A section heading, reproducing the web's `.dh-head` — icon, title, and an
 * optional text action on the right.
 *
 * Sections on this screen are separated by headings and whitespace rather than
 * by wrapping each one in a card. The web nests these inside `.dh-block`
 * panels because a desktop grid needs the panel to define a column; a single
 * phone column does not, and stacking eight bordered boxes would read as a
 * settings list rather than a dashboard.
 */
export function SectionHeader({
  title,
  icon,
  actionLabel,
  onAction,
  actionIcon,
  subtitle,
}: SectionHeaderProps) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.xxs }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
          minHeight: MIN_TOUCH_SIZE - 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flex: 1 }}>
          {icon ? <Glyph name={icon} color={theme.colors.inkFaint} size={16} /> : null}
          <Text variant="heading" numberOfLines={1} style={{ flex: 1 }}>
            {title}
          </Text>
        </View>

        {actionLabel && onAction ? (
          <Pressable
            onPress={onAction}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              opacity: pressed ? 0.6 : 1,
              paddingVertical: theme.spacing.xs,
            })}
          >
            {actionIcon ? <Glyph name={actionIcon} color={theme.colors.accent} size={13} /> : null}
            <Text variant="bodySmall" color="accent">
              {actionLabel}
            </Text>
          </Pressable>
        ) : null}
      </View>

      {subtitle ? (
        <Text variant="bodySmall" color="faint">
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}
