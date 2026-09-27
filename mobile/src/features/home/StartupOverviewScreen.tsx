import React from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { startupApi } from '../../api';
import { Card, ErrorState, Screen, Text } from '../../components';
import { useTheme } from '../../theme';
import { MetricCard } from '../startupOverview/Sections';
import {
  AlertsSection,
  CashRunwaySection,
  DecisionsSection,
  ExpenseSection,
  GoalsSection,
  HealthSection,
  RevenueSection,
} from '../startupOverview/Sections';
import { STAT_GRID_ORDER } from '../startupOverview/constants';

export const startupOverviewQueryKey = ['startup', 'overview'] as const;

/**
 * The Startup Financial Twin's dashboard — the startup branch of the web's
 * `#view-overview`.
 *
 * One request drives all of it. Every metric, chart series, goal, alert and
 * decision arrives from GET /startup/overview already computed and already
 * formatted, so this screen renders display strings and draws geometry; it
 * derives no financial figure of its own.
 *
 * Sections follow the web's order: persona strip, headline stats, Financial
 * Health, Cash & Runway, Revenue Intelligence, Expense Intelligence, Goals,
 * Daily Brief, Risk alerts, Recent decisions.
 */
export function StartupOverviewScreen() {
  const theme = useTheme();

  const query = useQuery({
    queryKey: startupOverviewQueryKey,
    queryFn: startupApi.fetchStartupOverview,
    staleTime: 60_000,
  });

  const d = query.data;

  if (query.isLoading && !d) {
    return (
      <Screen scroll>
        <Text variant="bodySmall" color="faint">
          Loading your Financial Twin…
        </Text>
      </Screen>
    );
  }

  if (query.isError && !d) {
    return (
      <Screen scroll>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Screen>
    );
  }
  if (!d) return null;

  const currency = d.currency || '₹';
  const company = d.company ?? {};
  const metrics = d.metrics ?? {};

  /* `renderStartupPersonaStrip()` — name · stage · industry, then the lead
     goal's progress. Both are strings the payload already carries. */
  const personaBits = [company.company_name, company.stage, company.industry].filter(Boolean);
  const goals = d.goals ?? [];
  const leadGoal = goals[0];
  const goalStrip = leadGoal
    ? `${leadGoal.label} — ${
        leadGoal.progress_pct !== null && leadGoal.progress_pct !== undefined
          ? `${leadGoal.progress_pct.toFixed(0)}% there`
          : 'tracking'
      }${goals.length > 1 ? ` (+${goals.length - 1} more goal${goals.length > 2 ? 's' : ''})` : ''}`
    : 'No goals set yet';

  const briefBullets = d.daily_brief?.bullets ?? [];

  return (
    <Screen scroll onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
      <View style={{ gap: theme.spacing.xxl, paddingBottom: theme.spacing.xl }}>
        {/* -------------------------------------------------- persona strip */}
        <View style={{ gap: 4 }}>
          <Text variant="title">{personaBits.join(' · ') || 'Your Startup'}</Text>
          <Text variant="bodySmall" color="faint">
            {goalStrip}
          </Text>
        </View>

        {/* ----------------------------------------------------- stat grid */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
          {STAT_GRID_ORDER.map((id) =>
            metrics[id] ? <MetricCard key={id} metric={metrics[id]} /> : null,
          )}
        </View>

        <HealthSection health={metrics.financial_health} indicators={d.health_indicators ?? []} />

        <CashRunwaySection
          history={d.history ?? []}
          projection={d.cash_projection ?? {}}
          currency={currency}
        />

        <RevenueSection
          metrics={metrics}
          history={d.history ?? []}
          breakdown={d.revenue_breakdown ?? {}}
          currency={currency}
        />

        <ExpenseSection
          metrics={metrics}
          breakdown={d.expense_breakdown ?? {}}
          hiring={d.hiring_capacity ?? {}}
          currency={currency}
        />

        <GoalsSection goals={goals} currency={currency} />

        {/* --------------------------------------------------- daily brief */}
        <Card label="Daily Financial Brief">
          {briefBullets.length ? (
            <View style={{ gap: theme.spacing.sm }}>
              {briefBullets.map((b, i) => (
                <View
                  key={i}
                  style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-start' }}
                >
                  <View
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: 3,
                      marginTop: 8,
                      backgroundColor: theme.colors.accent,
                    }}
                  />
                  <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
                    {b}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text variant="bodySmall" color="faint">
              No brief available yet.
            </Text>
          )}
        </Card>

        <AlertsSection alerts={d.alerts ?? []} />
        <DecisionsSection decisions={d.recent_decisions ?? []} />
      </View>
    </Screen>
  );
}
