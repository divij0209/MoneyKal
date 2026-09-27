import React from 'react';
import { Pressable, View } from 'react-native';

import type { HomeResponse } from '../../../api/types';
import { Metric, Surface, Text } from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';

interface Props {
  snapshot: HomeResponse['financial_snapshot'];
  /** Only for `previous_total_display` — the one pre-formatted last-month
   *  figure, which lives on the spending overview rather than the snapshot. */
  spending: HomeResponse['spending_overview'];
  onEditProfile: () => void;
  onGoHisaab: () => void;
}

/**
 * Step 1 of the dashboard's hierarchy: WHAT IS MY POSITION RIGHT NOW.
 *
 * The one dark panel on Home, carrying the one number the screen is about.
 * Everything below it is context for this figure, which is why nothing else
 * on the screen is enclosed like this — the enclosure is what marks it as the
 * answer rather than as another section.
 *
 * The web renders the same three figures as three equal tiles (`.dh-snap`).
 * Three equal columns at phone width leaves every figure too small to scan,
 * so the hierarchy the numbers already have is made explicit: available money
 * is the position you check first and gets the hero treatment; spending and
 * savings sit under a rule as a pair.
 *
 * Every string is the server's. `display`, `current_display` and
 * `target_display` arrive pre-formatted and the empty-state copy in each
 * block's `note` is the backend's own wording — this file formats nothing.
 */
export function PositionPanel({ snapshot, spending, onEditProfile, onGoHisaab }: Props) {
  const theme = useTheme();
  const t = useT();

  const avail = snapshot.available_money;
  const spend = snapshot.monthly_spending;
  const savings = snapshot.savings_progress;

  const availEmpty = avail.status === 'insufficient_data';
  const spendEmpty = spend.status === 'insufficient_data';

  /* A month-over-month direction, when the server computed one. Cyan for
     "spending fell", neutral for "spending rose" — the palette has no red,
     and the direction is also spelled out in the caption. */
  const changePct = spend.change_pct;
  const hasChange = changePct !== null && changePct !== undefined;
  const spendingRose = hasChange && changePct > 0;

  /* Last month against this month.
     GET /home returns exactly two spending figures — `previous_month` and
     `value` — and no further history. Two points is not a trend, so this is
     drawn as a pair of bars rather than as a line: a two-point "sparkline"
     implies a series that does not exist, and a line between two dots is
     decoration pretending to be data. Rendered only when both figures are
     present. */
  const comparison =
    spend.previous_month !== null &&
    spend.previous_month !== undefined &&
    spend.value !== null &&
    spend.value !== undefined
      ? { previous: spend.previous_month, current: spend.value }
      : null;

  const barMax = comparison ? Math.max(comparison.previous, comparison.current, 1) : 1;

  return (
    <Surface tone="panel" padded={theme.spacing.xxl}>
      <View style={{ gap: theme.spacing.xl }}>
        {/* ---------------------------------------------- the headline figure */}
        <Pressable
          onPress={availEmpty ? onEditProfile : undefined}
          disabled={!availEmpty}
          accessibilityRole={availEmpty ? 'button' : undefined}
          accessibilityLabel={`${avail.label}: ${avail.display}`}
        >
          <Metric
            label={avail.label}
            value={avail.display}
            size="hero"
            tone="onPanel"
            caption={avail.note ?? undefined}
          />
        </Pressable>

        <View style={{ height: 1, backgroundColor: theme.colors.panelLine }} />

        {/* ------------------------------------------- spending and savings */}
        <View style={{ flexDirection: 'row', gap: theme.spacing.xl }}>
          <Pressable
            onPress={onGoHisaab}
            accessibilityRole="button"
            accessibilityLabel={`${spend.label}: ${spend.display}`}
            style={{ flex: 1 }}
          >
            <Metric
              label={spend.label}
              value={spend.display}
              size="md"
              tone="onPanel"
              delta={hasChange ? `${Math.abs(changePct as number)}%` : undefined}
              direction={hasChange ? (spendingRose ? 'up' : 'down') : 'flat'}
              caption={
                spendEmpty
                  ? (spend.note ?? undefined)
                  : hasChange
                    ? t('home.vsLastMonth')
                    : (spend.month ?? undefined)
              }
            />
          </Pressable>

          <View style={{ width: 1, backgroundColor: theme.colors.panelLine }} />

          <View style={{ flex: 1 }}>
            <Metric
              label={savings.label}
              value={savings.current_display}
              size="md"
              tone="onPanelAccent"
              caption={
                savings.status === 'actual' && savings.percentage !== null
                  ? `${Math.round(savings.percentage)}% of ${savings.target_display}`
                  : (savings.note ?? undefined)
              }
            />
          </View>
        </View>

        {/* The comparison, when there is one. Two labelled bars under a rule
            — no axis, no gridlines, no legend: the labels are the legend. */}
        {comparison ? (
          <View style={{ gap: theme.spacing.md }}>
            {/* No heading: the row labels below already say what the bars
                are, and repeating the metric's own label ("Spent this
                month") directly under it read as a duplicate. */}
            {(
              [
                {
                  key: 'previous',
                  label: t('home.lastMonth'),
                  value: comparison.previous,
                  current: false,
                },
                {
                  key: 'current',
                  label: t('home.thisMonth'),
                  value: comparison.current,
                  current: true,
                },
              ] as const
            ).map((bar) => (
              <View key={bar.key} style={{ gap: 5 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
                  <Text variant="bodySmall" color="onPanelMuted" style={{ flex: 1 }}>
                    {bar.label}
                  </Text>
                  <Text
                    variant="bodySmall"
                    tabular
                    numberOfLines={1}
                    style={{
                      color: bar.current ? theme.colors.panelInk : theme.colors.panelInkMuted,
                      fontFamily: bar.current ? theme.fonts.bodySemiBold : theme.fonts.body,
                    }}
                  >
                    {bar.current ? spend.display : (spending.previous_total_display ?? '')}
                  </Text>
                </View>
                <View
                  style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: theme.colors.panelLine,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      borderRadius: 3,
                      width: `${Math.max(2, (bar.value / barMax) * 100)}%`,
                      backgroundColor: bar.current
                        ? theme.colors.panelAccent
                        : theme.colors.panelInkMuted,
                    }}
                  />
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </Surface>
  );
}
