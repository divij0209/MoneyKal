import React from 'react';
import { Pressable, View } from 'react-native';

import type { Insight } from '../../../api/types';
import { Glyph, INSIGHT_GLYPHS, PRIORITY_LABEL, Surface, Text } from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';

interface Props {
  insight: Insight | null | undefined;
  /** The insight's own action, e.g. {label: "Review in Hisaab", view: "hisaab"}. */
  onAction: (view: string) => void;
}

/**
 * Step 4 of the dashboard's hierarchy: WHAT MONEYKAL RECOMMENDS.
 *
 * The single most useful thing the backend can truthfully say about this
 * user's money right now, chosen by rules in backend/services/home_insights.py.
 * The title, the message and the action label are rendered verbatim — this
 * component picks an icon and a priority word and nothing else.
 *
 * One of only two enclosed blocks on Home, and the only tinted one. That is
 * what marks it as a statement rather than another readout: the position
 * panel is the answer, this is the advice, and everything between them is
 * evidence.
 */
export function InsightCard({ insight, onAction }: Props) {
  const theme = useTheme();
  const t = useT();
  if (!insight) return null;

  const priority = insight.priority || 'medium';
  const glyph = INSIGHT_GLYPHS[insight.type] ?? 'spark';

  return (
    <View style={{ gap: theme.spacing.md }}>
      <Text variant="title">{t('home.recommends')}</Text>

      <Surface tone="accent" padded={theme.spacing.lg}>
        <View style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
            <Glyph name={glyph} color={theme.colors.accent} size={17} />
            <Text variant="label" color="accent" style={{ flex: 1 }}>
              {t('home.insight')}
            </Text>
            <Text variant="label" color="faint">
              {PRIORITY_LABEL[priority] ?? priority}
            </Text>
          </View>

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="heading">{insight.title}</Text>
            <Text variant="bodySmall" color="muted">
              {insight.message}
            </Text>
          </View>

          {insight.action ? (
            <Pressable
              onPress={() => onAction(insight.action!.view)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={insight.action.label}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingTop: theme.spacing.xs,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text
                variant="bodySmall"
                color="accent"
                style={{ fontFamily: theme.fonts.bodySemiBold }}
              >
                {insight.action.label}
              </Text>
              <Glyph name="arrowRight" color={theme.colors.accent} size={13} />
            </Pressable>
          ) : null}
        </View>
      </Surface>
    </View>
  );
}
