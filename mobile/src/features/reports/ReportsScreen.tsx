import React, { useState } from 'react';
import { View } from 'react-native';

import { ApiError } from '../../api';
import { Divider, Screen, SectionHeader, Text } from '../../components';
import { useProfile } from '../../store';
import { useTheme } from '../../theme';
import { HistorySheet } from './components/HistorySheet';
import { WeeklyHealthReport } from './components/WeeklyHealthReport';
import { WeeklySpendCard } from './components/WeeklySpendCard';
import { formatDateRange } from './constants';
import { useReports } from './hooks';

/**
 * Reports — the mobile counterpart of `#view-reports`.
 *
 * Three panels, in the web's order: the daily financial brief, the weekly
 * financial health report, and the weekly spend report. Every figure is
 * computed server-side from the same profile and the same Hisaab transactions
 * the website reads; this screen asks four questions and renders four answers.
 *
 * These live under `/startup/*` on the backend, which reads oddly for an
 * Individual. The prefix is historical: the routes resolve the caller's own
 * profile and `_get_flexible_context()` serves either persona, which is why the
 * web shows this view to both. Nothing here is startup-specific.
 *
 * Each panel loads and fails independently, as the web's three do — a daily
 * brief that errors leaves the rest of the page intact.
 */

/** One panel's body: loading, failure, or content — never a blank space. */
function Panel({
  loading,
  error,
  failureMessage,
  children,
}: {
  loading: boolean;
  error: unknown;
  failureMessage: string;
  children: React.ReactNode;
}) {
  if (loading) {
    return (
      <Text variant="bodySmall" color="faint">
        Loading…
      </Text>
    );
  }
  if (error) {
    return (
      <Text variant="bodySmall" color="faint">
        {error instanceof ApiError && error.isNetworkError ? error.detail : failureMessage}
      </Text>
    );
  }
  return <>{children}</>;
}

export function ReportsScreen() {
  const theme = useTheme();
  const { profile } = useProfile();
  const currency = profile?.currency || '₹';
  const personaName = profile?.persona || 'You';

  const reports = useReports();
  const [historyOpen, setHistoryOpen] = useState(false);

  const brief = reports.brief.data?.daily_brief;
  const bullets = brief?.bullets ?? [];
  const history = reports.history.data ?? [];
  // The newest saved report is the week the plain endpoint regenerates.
  const currentId = history.length ? history[0].id : null;

  return (
    <>
      <Screen scroll onRefresh={reports.refreshAll} refreshing={reports.refreshing}>
        <View style={{ gap: theme.spacing.xxxl, paddingBottom: theme.spacing.xl }}>
          {/* ------------------------------------------ daily financial brief */}
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader title="Daily financial brief" icon="spark" />
            <Panel
              loading={reports.brief.isLoading}
              error={reports.brief.error}
              failureMessage="Failed to load daily brief."
            >
              {bullets.length ? (
                <View style={{ gap: theme.spacing.sm }}>
                  {bullets.map((b, i) => (
                    <View
                      key={`${i}-${b.slice(0, 24)}`}
                      style={{
                        flexDirection: 'row',
                        gap: theme.spacing.sm,
                        alignItems: 'flex-start',
                      }}
                    >
                      <View
                        style={{
                          width: 6,
                          height: 6,
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
            </Panel>
          </View>

          <Divider />

          {/* ------------------------------- weekly financial health report */}
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader
              title="Weekly financial health report"
              icon="trend"
              actionLabel="Refresh"
              onAction={reports.refreshWeekly}
            />
            <Panel
              loading={reports.weekly.isLoading}
              error={reports.weekly.error}
              failureMessage="Failed to load weekly report."
            >
              {reports.weekly.data ? (
                <WeeklyHealthReport report={reports.weekly.data} currency={currency} />
              ) : null}
            </Panel>
          </View>

          <Divider />

          {/* ------------------------------------------- weekly spend report */}
          <View style={{ gap: theme.spacing.md }}>
            <SectionHeader
              title="Weekly spend report"
              icon="wallet"
              actionLabel={history.length ? 'History' : undefined}
              onAction={history.length ? () => setHistoryOpen(true) : undefined}
              subtitle={
                reports.spend
                  ? formatDateRange(reports.spend.week_start, reports.spend.week_end)
                  : undefined
              }
            />
            <Panel
              loading={reports.spendLoading}
              error={reports.spendError}
              failureMessage={
                reports.selectedId === null
                  ? 'Failed to load weekly report.'
                  : 'Failed to load that report.'
              }
            >
              {reports.spend ? (
                <WeeklySpendCard report={reports.spend} personaName={personaName} />
              ) : null}
            </Panel>
          </View>
        </View>
      </Screen>

      <HistorySheet
        visible={historyOpen}
        onClose={() => setHistoryOpen(false)}
        history={history}
        loading={reports.history.isLoading}
        selectedId={reports.selectedId}
        currentId={currentId}
        onSelect={reports.selectReport}
      />
    </>
  );
}
