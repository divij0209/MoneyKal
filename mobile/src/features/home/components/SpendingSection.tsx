import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import type { SpendingOverview } from '../../../api/types';
import { Button, SectionHeader, Text } from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  spending: SpendingOverview;
  onGoHisaab: () => void;
}

const COLLAPSED_COUNT = 5;

/**
 * This month's outflow by the user's own Hisaab categories.
 *
 * Every figure comes from GET /home — the same rows that total the headline
 * "Spent this month" above, so the two can never disagree. Categories are the
 * user's own stored categories, never a re-grouping: a summary that renames
 * what the user files things under stops being a summary of their data.
 *
 * Bars are scaled against the largest category rather than the total, matching
 * the web, so the shape of the month stays legible when one category dominates.
 */
export function SpendingSection({ spending, onGoHisaab }: Props) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);

  const categories = spending.categories ?? [];

  if (spending.status !== 'actual' || !categories.length) {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <SectionHeader title="Spending overview" icon="trend" />
        <Text variant="bodySmall" color="muted">
          {spending.note || 'No expenses logged this month yet.'}
        </Text>
        <Button
          label="Log an expense"
          variant="outline"
          size="sm"
          fullWidth={false}
          onPress={onGoHisaab}
        />
      </View>
    );
  }

  const max = categories[0].amount || 1;
  const visible = expanded ? categories : categories.slice(0, COLLAPSED_COUNT);
  const hiddenCount = categories.length - visible.length;

  const diff =
    spending.previous_total != null && spending.previous_total > 0 && spending.total != null
      ? spending.total - spending.previous_total
      : null;

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader
        title="Spending overview"
        icon="trend"
        actionLabel="View Hisaab"
        onAction={onGoHisaab}
      />

      {/* Total for the period */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <View style={{ gap: 2 }}>
          <Text variant="metric" tabular>
            {spending.total_display}
          </Text>
          <Text variant="bodySmall" color="faint">
            {spending.period}
          </Text>
        </View>
        {diff !== null ? (
          <Text variant="bodySmall" color={diff > 0 ? 'neg' : 'pos'} style={{ paddingBottom: 2 }}>
            {diff > 0 ? '↑' : '↓'} vs {spending.previous_total_display} last month
          </Text>
        ) : null}
      </View>

      {/* Category rows */}
      <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.xs }}>
        {visible.map((c, i) => {
          const width = Math.max(2, Math.round((c.amount / max) * 100));
          const lead = i === 0;

          let change: React.ReactNode = null;
          if (c.is_new) {
            change = (
              <Text variant="bodySmall" color="faint">
                new this month
              </Text>
            );
          } else if (c.change_pct !== null && Math.abs(c.change_pct) >= 1) {
            const up = c.change_pct > 0;
            change = (
              <Text variant="bodySmall" color={up ? 'neg' : 'pos'} tabular>
                {up ? '↑' : '↓'} {Math.abs(Math.round(c.change_pct))}% vs last month
              </Text>
            );
          }

          return (
            <View key={c.category} style={{ gap: 6 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                <Text variant="body" style={{ fontSize: 15 }}>
                  {c.icon}
                </Text>
                <Text
                  variant="body"
                  style={{ flex: 1 }}
                  numberOfLines={1}
                  color={lead ? 'ink' : 'muted'}
                >
                  {c.category}
                </Text>
                <Text variant="body" tabular>
                  {c.display}
                </Text>
              </View>

              <View
                style={{
                  height: 4,
                  borderRadius: 2,
                  backgroundColor: theme.colors.ringTrack,
                  overflow: 'hidden',
                }}
              >
                <View
                  style={{
                    width: `${width}%`,
                    height: '100%',
                    borderRadius: 2,
                    // The leading category is the accent; the rest step back so
                    // the ranking reads without eight competing colours.
                    backgroundColor: lead ? theme.colors.accent : theme.colors.accentBorder,
                  }}
                />
              </View>

              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: theme.spacing.sm,
                }}
              >
                <Text variant="bodySmall" color="faint" tabular>
                  {c.share_pct}% of spend
                </Text>
                {change}
              </View>
            </View>
          );
        })}
      </View>

      {hiddenCount > 0 || expanded ? (
        <Pressable
          onPress={() => setExpanded((v) => !v)}
          hitSlop={10}
          accessibilityRole="button"
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingTop: theme.spacing.xs })}
        >
          <Text variant="bodySmall" color="accent">
            {expanded
              ? 'Show fewer categories'
              : `Show ${hiddenCount} more categor${hiddenCount === 1 ? 'y' : 'ies'}`}
          </Text>
        </Pressable>
      ) : null}

      {spending.insight ? (
        <Text
          variant="bodySmall"
          color="muted"
          style={{
            paddingTop: theme.spacing.sm,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          {spending.insight}
        </Text>
      ) : null}
    </View>
  );
}
