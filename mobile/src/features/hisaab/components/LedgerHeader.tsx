import React from 'react';
import { View } from 'react-native';

import type { HisaabSummary } from '../../../api/types';
import { BarMeter, DonutChart, Metric, Surface, Text } from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';
import { formatAmount } from '../constants';

interface Props {
  data: HisaabSummary;
}

/**
 * The ledger's position: money in, money out, net.
 *
 * All three figures come straight from GET /startup/hisaab and are never
 * recomputed. Worth knowing what they mean: the endpoint returns the profile's
 * *entire* ledger, so these are lifetime totals rather than this month's. The
 * label says "all time" for that reason — "Money out ₹58,158" with no
 * qualifier would read as a monthly figure and be wrong by however long the
 * account has existed.
 *
 * Net is the hero, because it is the one number that answers "am I ahead?".
 * In and out sit under a rule as the two halves that produced it.
 */
export function LedgerHeader({ data }: Props) {
  const theme = useTheme();
  const t = useT();

  const currency = data.currency || '₹';

  return (
    <Surface tone="panel" padded={theme.spacing.xxl}>
      <View style={{ gap: theme.spacing.xl }}>
        <Metric
          label={`${t('common.netFlow')} · ${t('common.total')}`}
          value={formatAmount(data.net, currency)}
          size="hero"
          tone={data.net >= 0 ? 'onPanelAccent' : 'onPanel'}
        />

        <View style={{ height: 1, backgroundColor: theme.colors.panelLine }} />

        <View style={{ flexDirection: 'row', gap: theme.spacing.xl }}>
          <Metric
            label={t('hisaab.moneyIn')}
            value={formatAmount(data.money_in, currency)}
            size="md"
            tone="onPanel"
            style={{ flex: 1 }}
          />
          <View style={{ width: 1, backgroundColor: theme.colors.panelLine }} />
          <Metric
            label={t('hisaab.moneyOut')}
            value={formatAmount(data.money_out, currency)}
            size="md"
            tone="onPanel"
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Surface>
  );
}

/**
 * The category composition — a donut plus a ruled legend.
 *
 * `by_category` from the same response, expenses only. Income categories are
 * excluded rather than mixed in: a ring that adds a salary slice to a rent
 * slice is not a composition of anything, and "where does my money go" is the
 * question this answers.
 */
export function CategoryBreakdown({ data }: { data: HisaabSummary }) {
  const theme = useTheme();
  const t = useT();

  const currency = data.currency || '₹';
  const outgoing = (data.by_category ?? []).filter((c) => c.type === 'out');

  if (!outgoing.length) return null;

  const total = outgoing.reduce((sum, c) => sum + c.amount, 0);
  const ordered = [...outgoing].sort((a, b) => b.amount - a.amount);

  // Six slices then "Other" — beyond that the ring is unreadable and the
  // legend is a list rather than a summary.
  const top = ordered.slice(0, 6);
  const rest = ordered.slice(6);
  const slices = [
    ...top.map((c) => ({
      label: c.category,
      value: c.amount,
      display: formatAmount(c.amount, currency),
    })),
    ...(rest.length
      ? [
          {
            label: `Other (${rest.length})`,
            value: rest.reduce((sum, c) => sum + c.amount, 0),
            display: formatAmount(
              rest.reduce((sum, c) => sum + c.amount, 0),
              currency,
            ),
          },
        ]
      : []),
  ];

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <Text variant="title">{t('hisaab.spendByCategory')}</Text>

      <View style={{ alignItems: 'center' }}>
        <DonutWithCenter
          slices={slices}
          centerValue={formatAmount(total, currency)}
          centerLabel={t('hisaab.moneyOut')}
        />
      </View>

      <LegendRows slices={slices} total={total} />
    </View>
  );
}

function DonutWithCenter({
  slices,
  centerValue,
  centerLabel,
}: {
  slices: { label: string; value: number; display?: string }[];
  centerValue: string;
  centerLabel: string;
}) {
  return (
    <DonutChart
      slices={slices}
      size={190}
      thickness={26}
      centerValue={centerValue}
      centerLabel={centerLabel}
    />
  );
}

/**
 * The legend, as ruled rows rather than chips.
 *
 * A row can carry the amount, the share and a meter; a chip can carry a
 * colour and a word. On a ledger the amount is the point, so rows win.
 */
function LegendRows({
  slices,
  total,
}: {
  slices: { label: string; value: number; display?: string }[];
  total: number;
}) {
  const theme = useTheme();
  const ramp = [
    theme.colors.chartBlue,
    theme.colors.chartOrange,
    theme.colors.chartAqua,
    theme.colors.chartMagenta,
    theme.colors.chartYellow,
    theme.colors.chartViolet,
  ];

  return (
    <View>
      {slices.map((slice, i) => {
        const share = total > 0 ? slice.value / total : 0;
        return (
          <View
            key={`${slice.label}-${i}`}
            style={{
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.md,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: ramp[i % ramp.length],
                }}
              />
              <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
                {slice.label}
              </Text>
              <Text variant="bodySmall" color="faint" tabular>
                {Math.round(share * 100)}%
              </Text>
              <Text
                variant="mono"
                tabular
                numberOfLines={1}
                style={{ minWidth: 84, textAlign: 'right' }}
              >
                {slice.display}
              </Text>
            </View>
            <BarMeter fraction={share} height={4} color={ramp[i % ramp.length]} />
          </View>
        );
      })}
    </View>
  );
}
