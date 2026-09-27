import React from 'react';
import { View } from 'react-native';

import { Text } from '../../../components';
import { useTheme } from '../../../theme';
import type { WeeklySpendReportResponse } from '../../../api/types';
import {
  formatDateRange,
  formatGeneratedAt,
  money,
  pctChangeLabel,
} from '../constants';

/**
 * The weekly spend report card — the web's `.report-card`.
 *
 * A masthead, a three-stat hero, a spend-by-category bar list and the
 * suggestions, in that order. The web renders this as a printable card because
 * it is the thing its PDF export screenshots; the PDF has no mobile equivalent
 * (it is html2canvas over the DOM, not a backend document), so this is the card
 * without that affordance.
 */

interface Props {
  report: WeeklySpendReportResponse;
  /** The web's masthead uses the profile persona — a person's name here. */
  personaName: string;
}

export function WeeklySpendCard({ report, personaName }: Props) {
  const theme = useTheme();

  const currency = report.currency || '₹';
  const spend = report.category_spend ?? {};
  const categories = spend.categories ?? [];
  const flagCount = (report.flags ?? []).length;
  const suggestions = report.suggestions ?? [];
  const topCategory = categories.length ? categories[0] : null;
  const totalDelta = pctChangeLabel(spend.pct_change);

  /* The web charts bars only when the week has real logged spend. A week can
     report `insufficient_data` and still carry categories whose `this_week`
     are all zero — charting those would draw an empty grid and imply data that
     is not there — so the status decides, not the array length. */
  const showBars = spend.status === 'actual' && categories.length > 0;
  const maxVal = showBars ? Math.max(...categories.map((c) => c.this_week), 1) : 1;

  return (
    <View
      style={{
        gap: theme.spacing.xl,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.surface,
      }}
    >
      {/* ------------------------------------------------------- masthead */}
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text variant="label" color="accent">
            ◆ MoneyKal
          </Text>
        </View>
        <Text variant="title">Weekly Spend Report</Text>
        <Text variant="bodySmall" color="faint">
          {personaName} · {formatDateRange(report.week_start, report.week_end)}
        </Text>
        <Text variant="label" color="faint">
          Generated {formatGeneratedAt(report.created_at)}
        </Text>
      </View>

      {/* ----------------------------------------------------------- hero */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.md }}>
        <View style={{ flexGrow: 1, flexBasis: '46%', gap: 2 }}>
          <Text variant="label" color="faint">
            This week&apos;s spend
          </Text>
          <Text variant="metric" tabular>
            {money(spend.this_week_total ?? 0, currency)}
          </Text>
          {totalDelta ? (
            <Text
              variant="label"
              style={{
                color:
                  (spend.pct_change ?? 0) > 0 ? theme.colors.neg : theme.colors.pos,
              }}
            >
              {totalDelta}
            </Text>
          ) : null}
        </View>

        <View style={{ flexGrow: 1, flexBasis: '46%', gap: 2 }}>
          <Text variant="label" color="faint">
            Top category
          </Text>
          <Text variant="heading">{topCategory ? topCategory.category : '—'}</Text>
          {topCategory ? (
            <Text variant="label" color="muted" tabular>
              {money(topCategory.this_week, currency)}
            </Text>
          ) : null}
        </View>

        <View style={{ flexGrow: 1, flexBasis: '46%', gap: 2 }}>
          <Text variant="label" color="faint">
            Flags this week
          </Text>
          <Text variant="metric" tabular>
            {flagCount}
          </Text>
        </View>
      </View>

      {/* --------------------------------------------- spend by category */}
      <View style={{ gap: theme.spacing.md }}>
        <Text variant="label" color="muted">
          Spend by category
        </Text>

        {showBars ? (
          <View style={{ gap: theme.spacing.md }}>
            {categories.map((c) => {
              // The web floors the bar at 4% so a tiny category still reads as
              // a bar rather than a hairline.
              const pct = Math.max(4, Math.round((c.this_week / maxVal) * 100));
              const delta =
                c.is_new
                  ? 'New'
                  : c.pct_change !== null &&
                      c.pct_change !== undefined &&
                      Math.abs(c.pct_change) >= 1
                    ? pctChangeLabel(c.pct_change, '')
                    : null;

              return (
                <View key={c.category} style={{ gap: 6 }}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: theme.spacing.sm,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 6,
                        flex: 1,
                      }}
                    >
                      <Text variant="bodySmall" numberOfLines={1} style={{ flexShrink: 1 }}>
                        {c.category}
                      </Text>
                      {delta ? (
                        <Text
                          variant="label"
                          style={{
                            color: c.is_new
                              ? theme.colors.accent
                              : (c.pct_change ?? 0) > 0
                                ? theme.colors.neg
                                : theme.colors.pos,
                          }}
                        >
                          {delta}
                        </Text>
                      ) : null}
                    </View>
                    <Text variant="bodySmall" tabular>
                      {money(c.this_week, currency)}
                    </Text>
                  </View>

                  <View
                    style={{
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: theme.colors.surface3,
                      overflow: 'hidden',
                    }}
                  >
                    <View
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        borderRadius: 3,
                        backgroundColor: theme.colors.accent,
                      }}
                    />
                  </View>
                </View>
              );
            })}
          </View>
        ) : (
          <Text variant="bodySmall" color="faint">
            {spend.note || 'No categorized spending yet this week.'}
          </Text>
        )}
      </View>

      {/* ---------------------------------------------------- suggestions */}
      <View style={{ gap: theme.spacing.md }}>
        <Text variant="label" color="muted">
          Suggestions
        </Text>

        {suggestions.length ? (
          suggestions.map((s, i) => (
            <View
              key={`${s.title}-${i}`}
              style={{
                gap: 4,
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.line,
                backgroundColor: theme.colors.surface2,
              }}
            >
              <Text variant="bodySmall">💡 {s.title}</Text>
              <Text variant="bodySmall" color="muted">
                {s.detail}
              </Text>
            </View>
          ))
        ) : (
          <Text variant="bodySmall" color="faint">
            No suggestions available yet.
          </Text>
        )}
      </View>

      <Text variant="label" color="faint">
        This report is educational and based on your logged Hisaab transactions. Not
        financial advice.
      </Text>
    </View>
  );
}
