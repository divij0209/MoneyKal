import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTheme } from '../../theme';

export type SurfaceTone =
  /** No chrome at all. Structure comes from spacing and type. The default,
   *  and what most sections should use. */
  | 'plain'
  /** A barely-there tinted ground. For grouping a few related rows. */
  | 'inset'
  /** A hairline outline, no fill. For a block that must be enclosed but not
   *  emphasised — a disclaimer, a secondary readout. */
  | 'outlined'
  /** Filled + hairline. The closest thing to a traditional card. Use when a
   *  block is genuinely a discrete object, not just a section. */
  | 'raised'
  /** The dark feature panel. Exactly one per screen, carrying the hero
   *  figure. This is what makes a screen look designed. */
  | 'panel'
  /** Cyan-tinted, accent hairline. For the single most important callout on
   *  a screen — an insight, a recommendation. */
  | 'accent';

export interface SurfaceProps {
  children: React.ReactNode;
  tone?: SurfaceTone;
  /** Interior padding. `false` for edge-to-edge content like a chart or a
   *  list of rows that supply their own padding. */
  padded?: boolean | number;
  radius?: number;
  onPress?: () => void;
  style?: ViewStyle;
  testID?: string;
  accessibilityLabel?: string;
}

/**
 * The app's surface primitive.
 *
 * The point of this component is the `plain` default. A dashboard where every
 * section is a bordered box reads as a settings list; hierarchy has to come
 * from type size, weight and whitespace, with enclosure reserved for the few
 * blocks that genuinely are objects rather than sections. So a screen reaches
 * for `plain` by default and has to justify anything else.
 *
 * `panel` is the counterweight: one dark, high-contrast block per screen
 * carrying the number the screen is about. On the light theme that is near-
 * black on off-white, which is where the bright brand cyan becomes usable at
 * full strength — see `panelAccent` in the tokens.
 *
 * Replaces the old `Card`, which is now a thin alias over `tone="raised"`.
 */
export function Surface({
  children,
  tone = 'plain',
  padded = true,
  radius,
  onPress,
  style,
  testID,
  accessibilityLabel,
}: SurfaceProps) {
  const theme = useTheme();

  const pad = padded === true ? theme.spacing.lg : padded === false ? 0 : padded;
  const corner = radius ?? (tone === 'panel' ? theme.radius.xl : theme.radius.lg);

  const tones: Record<SurfaceTone, ViewStyle> = {
    plain: {},
    inset: {
      backgroundColor: theme.colors.surface,
      borderRadius: corner,
    },
    outlined: {
      borderWidth: 1,
      borderColor: theme.colors.line,
      borderRadius: corner,
    },
    raised: {
      backgroundColor: theme.colors.cardBgSolid,
      borderWidth: 1,
      borderColor: theme.colors.line,
      borderRadius: corner,
      ...theme.shadow,
    },
    panel: {
      backgroundColor: theme.colors.panel,
      borderRadius: corner,
      ...theme.panelShadow,
    },
    accent: {
      backgroundColor: theme.colors.accentTint,
      borderWidth: 1,
      borderColor: theme.colors.accentBorder,
      borderRadius: corner,
    },
  };

  const base: ViewStyle = { padding: pad, ...tones[tone] };

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [base, pressed ? { opacity: 0.9 } : null, style]}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View style={[base, style]} testID={testID} accessibilityLabel={accessibilityLabel}>
      {children}
    </View>
  );
}
