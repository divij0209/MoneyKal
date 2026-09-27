import React from 'react';
import { View } from 'react-native';

import { Text } from '../../../components';
import { useTheme } from '../../../theme';
import type { WeeklyReportResponse } from '../../../api/types';
import { money, months, score, weekOverWeekBits } from '../constants';

/**
 * The weekly financial health report — the web's `suWeeklyReportHtml()`.
 *
 * A note, the week-over-week deltas, then one timeline entry per tracked day.
 * When the backend has no snapshots for the window it returns `points: []` with
 * a note explaining why, and that note is the whole panel — the web shows
 * exactly that rather than an empty chart.
 */

interface Props {
  report: WeeklyReportResponse;
  currency: string;
}

export function WeeklyHealthReport({ report, currency }: Props) {
  const theme = useTheme();

  const points = report.points ?? [];
  const bits = weekOverWeekBits(report);

  if (!points.length) {
    return (
      <Text variant="bodySmall" color="faint">
        {report.note || 'No tracking history yet for this week.'}
      </Text>
    );
  }

  return (
    <View style={{ gap: theme.spacing.lg }}>
      {report.note ? (
        <Text variant="bodySmall" color="faint">
          {report.note}
        </Text>
      ) : null}

      {bits.length ? (
        <Text variant="bodySmall" color="muted">
          Week-over-week: {bits.join(' · ')}
        </Text>
      ) : null}

      <View style={{ gap: theme.spacing.lg }}>
        {points.map((p, i) => {
          const last = i === points.length - 1;
          const rows: [string, string][] = [
            ['Cash', money(p.cash, currency)],
            ['Net burn', money(p.net_burn, currency)],
            ['Runway', months(p.runway_months)],
            ['Health', score(p.financial_health_score)],
          ];

          return (
            <View key={`${p.date}-${i}`} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
              {/* The web's `.timeline-step__dot` and its connecting rail. */}
              <View style={{ alignItems: 'center', width: 10 }}>
                <View
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: 5,
                    marginTop: 4,
                    backgroundColor: theme.colors.accent,
                  }}
                />
                {!last ? (
                  <View
                    style={{
                      flex: 1,
                      width: 1,
                      marginTop: 4,
                      backgroundColor: theme.colors.line,
                    }}
                  />
                ) : null}
              </View>

              <View style={{ flex: 1, gap: theme.spacing.xs, paddingBottom: theme.spacing.sm }}>
                <Text variant="bodySmall">{p.date}</Text>
                {rows.map(([label, value]) => (
                  <View
                    key={label}
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      gap: theme.spacing.md,
                    }}
                  >
                    <Text variant="bodySmall" color="faint">
                      {label}
                    </Text>
                    <Text variant="bodySmall" tabular>
                      {value}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
