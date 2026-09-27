import React from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { startupApi } from '../../api';
import type { StartupAlert } from '../../api/types';
import { Card, Chip, Screen, Text } from '../../components';
import { startupOverviewQueryKey } from '../home/StartupOverviewScreen';
import { useTheme } from '../../theme';

/**
 * Risk alerts — the mobile counterpart of `#view-alerts`.
 *
 * Startup-only, matching the web's persona gating: the navitem carries
 * `data-persona="startup"`, and `startup.js` hides any navitem whose persona
 * does not match the active one.
 *
 * There is no alerts endpoint. `renderAlertsView()` on the web calls
 * `fetchStartupOverview()` and reads `overview.alerts`, so this screen does the
 * same — and shares the dashboard's query key, so opening the tab reuses the
 * cached payload instead of issuing a second identical request. Every alert is
 * generated server-side by `generate_alerts()`; nothing here evaluates a
 * threshold or decides what counts as a risk.
 *
 * One deliberate detail: this view keys its tag off `level` (warn vs anything
 * else), not off `severity`. The Overview's alert cards use the richer
 * critical/high/medium/low `severity`, and the two views genuinely differ on
 * the web. That inconsistency is reproduced rather than tidied up — the two
 * clients should disagree in the same places, and unifying them here would be
 * a product change made in the wrong place.
 */
export function AlertsScreen() {
  const theme = useTheme();

  const query = useQuery({
    queryKey: startupOverviewQueryKey,
    queryFn: startupApi.fetchStartupOverview,
    staleTime: 60_000,
  });

  const alerts: StartupAlert[] = query.data?.alerts ?? [];

  return (
    <Screen scroll onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
      <Card>
        <View style={{ gap: theme.spacing.lg }}>
          {/* `.panel__head` — the heading and the live dot beside it. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
            <Text variant="heading" style={{ flex: 1 }}>
              Risk alerts
            </Text>
            <View
              accessibilityLabel="Live"
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: theme.colors.accent,
              }}
            />
          </View>

          {query.isLoading && !query.data ? (
            <Text variant="bodySmall" color="faint">
              Loading…
            </Text>
          ) : query.isError && !query.data ? (
            <Text variant="bodySmall" color="faint">
              Failed to load alerts.
            </Text>
          ) : alerts.length ? (
            <View style={{ gap: theme.spacing.lg }}>
              {alerts.map((a, i) => (
                <View
                  key={`${a.category}-${i}`}
                  style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'flex-start' }}
                >
                  {/* `.alert__dot`, tinted by level exactly as `.alert--{level}`
                      does on the web. */}
                  <View
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: 4,
                      marginTop: 7,
                      backgroundColor:
                        a.level === 'warn' ? theme.colors.warn : theme.colors.pos,
                    }}
                  />
                  <View style={{ flex: 1, gap: theme.spacing.sm }}>
                    <View style={{ flexDirection: 'row' }}>
                      <Chip
                        label={a.category}
                        tone={a.level === 'warn' ? 'warn' : 'positive'}
                      />
                    </View>
                    <Text variant="bodySmall" color="muted">
                      {a.text}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          ) : (
            <Text variant="bodySmall" color="faint">
              No active alerts — everything looks healthy.
            </Text>
          )}
        </View>
      </Card>
    </Screen>
  );
}
