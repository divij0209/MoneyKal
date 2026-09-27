import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import type {
  StartupAlert,
  StartupBreakdown,
  StartupCashProjection,
  StartupDecisionLogItem,
  StartupGoalProgress,
  StartupHealthIndicator,
  StartupHiringCapacity,
  StartupHistoryPoint,
  StartupMetric,
} from '../../api/types';
import { Card, Chip, Divider, Text } from '../../components';
import { useTheme } from '../../theme';
import { ChartLegend, DonutChart, ProgressRing, TrendChart } from './charts';
import {
  DECISION_STATUS_LABEL,
  SEVERITY_LABEL,
  expenseGrowthWarning,
  goalColor,
  healthColor,
  healthNarrative,
  indicatorColor,
  money,
  statusLabel,
} from './constants';

/**
 * The Startup Overview's sections, transcribed from twin-app/js/startup.js.
 *
 * Each renders values the backend computed. Where the web shows a status chip,
 * a colour or a sentence, the rule behind it comes from `constants.ts` so the
 * whole of the client-side presentation logic sits in one readable place.
 */

/* ------------------------------------------------------------ metric bits */

/** `suCalcInfoHtml()` — the "How is this calculated?" disclosure. */
export function CalcInfo({ metric }: { metric: StartupMetric }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const calc = metric.calculation ?? {};
  const inputs = Object.entries(calc.inputs ?? {})
    .map(([k, v]) => `${k}: ${v === null || v === undefined ? '—' : String(v)}`)
    .join(', ');

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text variant="label" color="accent">
          {open ? 'Hide calculation' : 'How is this calculated?'}
        </Text>
      </Pressable>

      {open ? (
        <View style={{ gap: 4 }}>
          {calc.formula ? (
            <Text variant="label" color="faint">
              Formula: {calc.formula}
            </Text>
          ) : null}
          <Text variant="label" color="faint">
            Inputs: {inputs || 'none'}
          </Text>
          {calc.data_source ? (
            <Text variant="label" color="faint">
              Data source: {calc.data_source}
            </Text>
          ) : null}
          {calc.last_updated ? (
            <Text variant="label" color="faint">
              Last updated: {new Date(calc.last_updated).toLocaleString('en-IN')}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** `suMetricCardHtml()` — a headline stat tile. */
export function MetricCard({ metric }: { metric: StartupMetric }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '46%',
        gap: 6,
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text variant="label" color="faint" numberOfLines={1}>
        {metric.label}
      </Text>
      <Text variant="metric" tabular>
        {metric.display}
      </Text>
      <View style={{ flexDirection: 'row' }}>
        <Chip label={statusLabel(metric.status)} />
      </View>
      <CalcInfo metric={metric} />
    </View>
  );
}

/** `suMetricRowHtml()` — a metric inside a section rather than the grid. */
export function MetricRow({ metric }: { metric?: StartupMetric }) {
  const theme = useTheme();
  if (!metric) return null;
  return (
    <View style={{ gap: 4, paddingVertical: theme.spacing.sm }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
        }}
      >
        <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
          {metric.label}
        </Text>
        <Chip label={statusLabel(metric.status)} />
      </View>
      <Text variant="heading" tabular>
        {metric.display}
      </Text>
      <CalcInfo metric={metric} />
    </View>
  );
}

/* ----------------------------------------------------------------- health */

export function HealthSection({
  health,
  indicators,
}: {
  health?: StartupMetric;
  indicators: StartupHealthIndicator[];
}) {
  const theme = useTheme();
  const score = health?.value ?? null;

  return (
    <Card label="Financial Health">
      <View style={{ gap: theme.spacing.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg }}>
          <ProgressRing
            pct={score}
            color={healthColor(score, theme.colors)}
            label={score === null ? '—' : `${Math.round(score)}`}
          />
          <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
            {healthNarrative(score, indicators)}
          </Text>
        </View>

        {indicators.length ? (
          <View style={{ gap: theme.spacing.md }}>
            {indicators.map((ind) => (
              <View key={ind.id} style={{ gap: 4 }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: theme.spacing.sm,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flex: 1 }}>
                    <View
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 4,
                        backgroundColor: indicatorColor(ind.status, theme.colors),
                      }}
                    />
                    <Text variant="bodySmall" color="muted">
                      {ind.label}
                    </Text>
                  </View>
                  <Text variant="bodySmall" tabular>
                    {ind.display}
                  </Text>
                </View>
                {ind.detail ? (
                  <Text variant="label" color="faint" style={{ marginLeft: 15 }}>
                    {ind.detail}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {health ? <CalcInfo metric={health} /> : null}
      </View>
    </Card>
  );
}

/* --------------------------------------------------------- cash & runway */

export function CashRunwaySection({
  history,
  projection,
  currency,
}: {
  history: StartupHistoryPoint[];
  projection: StartupCashProjection;
  currency: string;
}) {
  const theme = useTheme();

  const hist = history.filter((h) => typeof h.cash === 'number');
  const forecast = projection.series ?? [];

  // Actual then forecast on one timeline, the forecast dashed — the web joins
  // them the same way so the handover point is visible.
  const actual: (number | null)[] = hist.map((h) => h.cash ?? null);
  const forecastPoints: (number | null)[] = [
    ...hist.slice(0, -1).map(() => null),
    ...(hist.length ? [hist[hist.length - 1].cash ?? null] : []),
    ...forecast.map((f) => f.projected_cash),
  ];
  const xLabels = [
    ...hist.map((h) => h.date.slice(5)),
    ...forecast.map((f) => `+${f.month}m`),
  ];

  const hasChart = actual.length + forecast.length >= 2;

  return (
    <Card label="Cash & Runway">
      <View style={{ gap: theme.spacing.md }}>
        {hasChart ? (
          <>
            <TrendChart
              currency={currency}
              xLabels={xLabels}
              series={[
                {
                  label: 'Cash',
                  color: theme.colors.chartBlue,
                  points: actual,
                  area: true,
                },
                {
                  label: 'Projected cash',
                  color: theme.colors.chartAqua,
                  points: forecastPoints,
                  dashed: true,
                },
              ]}
            />
            <ChartLegend
              items={[
                { label: 'Cash', color: theme.colors.chartBlue },
                { label: 'Projected cash', color: theme.colors.chartAqua, dashed: true },
              ]}
            />
          </>
        ) : (
          <Text variant="bodySmall" color="faint">
            Not enough history yet to chart cash — this builds up as you use MoneyKal.
          </Text>
        )}

        {projection.cash_out_month ? (
          <Text variant="bodySmall" color="muted">
            At this burn, cash runs out around month {projection.cash_out_month}.
          </Text>
        ) : null}

        {(projection.assumptions ?? []).map((a, i) => (
          <Text key={i} variant="label" color="faint">
            · {a}
          </Text>
        ))}
      </View>
    </Card>
  );
}

/* ------------------------------------------------------------- breakdowns */

function BreakdownBlock({
  breakdown,
  currency,
  emptyText,
}: {
  breakdown: StartupBreakdown;
  currency: string;
  emptyText: string;
}) {
  const theme = useTheme();
  const items = breakdown.items ?? [];

  return (
    <View style={{ gap: theme.spacing.md }}>
      {items.length ? (
        <DonutChart items={items} currency={currency} />
      ) : (
        <Text variant="bodySmall" color="faint">
          {breakdown.data_source || emptyText}
        </Text>
      )}
      {items.length && breakdown.data_source ? (
        <Text variant="label" color="faint">
          {breakdown.data_source}
        </Text>
      ) : null}
    </View>
  );
}

export function RevenueSection({
  metrics,
  history,
  breakdown,
  currency,
}: {
  metrics: Record<string, StartupMetric>;
  history: StartupHistoryPoint[];
  breakdown: StartupBreakdown;
  currency: string;
}) {
  const theme = useTheme();
  const revHistory = history.filter((h) => typeof h.revenue === 'number');

  return (
    <Card label="Revenue Intelligence">
      <View style={{ gap: theme.spacing.lg }}>
        {revHistory.length >= 2 ? (
          <TrendChart
            currency={currency}
            xLabels={revHistory.map((h) => h.date.slice(5))}
            series={[
              {
                label: 'Revenue',
                color: theme.colors.chartBlue,
                points: revHistory.map((h) => h.revenue ?? null),
                area: true,
              },
            ]}
          />
        ) : (
          <Text variant="bodySmall" color="faint">
            Not enough revenue history yet to chart a trend.
          </Text>
        )}

        <BreakdownBlock
          breakdown={breakdown}
          currency={currency}
          emptyText='No categorized revenue yet — log Hisaab "money in" transactions to see a breakdown.'
        />

        {(breakdown.streams ?? []).length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {(breakdown.streams ?? []).map((s) => (
              <Chip key={s} label={s} tone="accent" />
            ))}
          </View>
        ) : null}

        <Divider />
        <MetricRow metric={metrics.revenue_growth} />
        <MetricRow metric={metrics.breakeven} />
      </View>
    </Card>
  );
}

export function ExpenseSection({
  metrics,
  breakdown,
  hiring,
  currency,
}: {
  metrics: Record<string, StartupMetric>;
  breakdown: StartupBreakdown;
  hiring: StartupHiringCapacity;
  currency: string;
}) {
  const theme = useTheme();
  const warning = expenseGrowthWarning(metrics.expense_growth);

  return (
    <Card label="Expense Intelligence">
      <View style={{ gap: theme.spacing.lg }}>
        <BreakdownBlock
          breakdown={breakdown}
          currency={currency}
          emptyText="No expense data yet."
        />

        {warning ? (
          <View
            style={{
              flexDirection: 'row',
              gap: theme.spacing.sm,
              padding: theme.spacing.md,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.warnTint,
              borderWidth: 1,
              borderColor: theme.colors.warn,
            }}
          >
            <Text variant="bodySmall" style={{ color: theme.colors.warn, flex: 1 }}>
              {warning}
            </Text>
          </View>
        ) : null}

        <Divider />
        <MetricRow metric={metrics.gross_burn} />
        <MetricRow metric={metrics.expense_growth} />

        {/* `suHiringCapacityRow()` */}
        <View style={{ gap: 4, paddingVertical: theme.spacing.sm }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.sm,
            }}
          >
            <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
              Hiring Capacity
            </Text>
            <Chip label={statusLabel(hiring?.status ?? 'insufficient_data')} />
          </View>

          {!hiring || hiring.status === 'insufficient_data' ? (
            <Text variant="bodySmall" color="faint">
              Set Cost per Hire on your profile to see how many hires you can sustainably make.
            </Text>
          ) : (
            <>
              <Text variant="bodySmall">
                {hiring.max_sustainable_hires} more hire(s) sustainable, keeping a 6-month runway
                floor
              </Text>
              <Text variant="label" color="faint">
                Each additional hire costs about{' '}
                {hiring.runway_lost_per_hire !== null && hiring.runway_lost_per_hire !== undefined
                  ? hiring.runway_lost_per_hire.toFixed(1)
                  : '?'}{' '}
                month(s) of runway.
              </Text>
            </>
          )}
        </View>
      </View>
    </Card>
  );
}

/* ------------------------------------------------------------------ goals */

export function GoalsSection({
  goals,
  currency,
}: {
  goals: StartupGoalProgress[];
  currency: string;
}) {
  const theme = useTheme();

  if (!goals.length) {
    return (
      <Card label="Goals">
        <Text variant="bodySmall" color="faint">
          No goals set yet.
        </Text>
      </Card>
    );
  }

  return (
    <Card label="Goals">
      <View style={{ gap: theme.spacing.xl }}>
        {goals.map((g, i) => {
          const meta: string[] = [];
          if (g.current_value !== null && g.current_value !== undefined && g.target_value) {
            meta.push(`${money(currency, g.current_value)} / ${money(currency, g.target_value)}`);
          } else if (g.target_value) {
            meta.push(`Target: ${money(currency, g.target_value)}`);
          }
          if (g.target_date) meta.push(`Due ${g.target_date}`);
          if (g.expected_completion_date) meta.push(`Est. ${g.expected_completion_date}`);

          return (
            <View
              key={`${g.label}-${i}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg }}
            >
              <ProgressRing
                pct={g.progress_pct}
                color={goalColor(g.progress_pct, theme.colors)}
                size={88}
                strokeW={8}
              />
              <View style={{ flex: 1, gap: 3 }}>
                <Text variant="heading">{g.label}</Text>
                {meta.length ? (
                  <Text variant="label" color="faint">
                    {meta.join(' · ')}
                  </Text>
                ) : null}
                {g.note || g.projection_note ? (
                  <Text variant="bodySmall" color="muted">
                    {g.note || g.projection_note}
                  </Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>
    </Card>
  );
}

/* ------------------------------------------------- alerts & decisions --- */

export function AlertsSection({ alerts }: { alerts: StartupAlert[] }) {
  const theme = useTheme();
  return (
    <Card label="Risk alerts">
      {alerts.length ? (
        <View style={{ gap: theme.spacing.md }}>
          {alerts.map((a, i) => {
            const sev = a.severity || (a.level === 'warn' ? 'medium' : 'low');
            return (
              <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                <Chip
                  label={SEVERITY_LABEL[sev] ?? sev}
                  tone={sev === 'critical' || sev === 'high' ? 'warn' : 'neutral'}
                />
                <View style={{ flex: 1, gap: 2 }}>
                  {a.metric ? (
                    <Text variant="label" color="faint">
                      {a.metric.replace(/_/g, ' ')}
                    </Text>
                  ) : null}
                  <Text variant="bodySmall" color="muted">
                    {a.text}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      ) : (
        <Text variant="bodySmall" color="faint">
          No active alerts.
        </Text>
      )}
    </Card>
  );
}

export function DecisionsSection({ decisions }: { decisions: StartupDecisionLogItem[] }) {
  const theme = useTheme();

  if (!decisions.length) {
    return (
      <Card label="Recent decisions">
        <Text variant="bodySmall" color="faint">
          No decisions logged yet — try Simulate.
        </Text>
      </Card>
    );
  }

  return (
    <Card label="Recent decisions">
      <View style={{ gap: theme.spacing.lg }}>
        {decisions.map((d, i) => {
          const p = d.predicted ?? {};
          const a = d.actual_now ?? {};
          const status = d.decision_status || 'unknown';
          const rows: string[] = [];
          if (p.runway_after !== null && p.runway_after !== undefined) {
            rows.push(`Predicted runway: ${p.runway_after.toFixed(1)} mo`);
          }
          if (a.runway !== null && a.runway !== undefined) {
            rows.push(`Runway now: ${a.runway.toFixed(1)} mo`);
          }
          if (p.financial_health_after !== null && p.financial_health_after !== undefined) {
            rows.push(`Predicted health: ${p.financial_health_after.toFixed(0)}`);
          }
          if (a.financial_health !== null && a.financial_health !== undefined) {
            rows.push(`Health now: ${a.financial_health.toFixed(0)}`);
          }

          return (
            <View key={i} style={{ gap: 6 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: theme.spacing.sm,
                }}
              >
                <Text variant="heading" style={{ flex: 1 }}>
                  {d.title}
                </Text>
                <Chip label={DECISION_STATUS_LABEL[status] ?? status} />
              </View>
              {rows.map((r) => (
                <Text key={r} variant="bodySmall" color="muted">
                  {r}
                </Text>
              ))}
              <Text variant="label" color="faint">
                {new Date(d.created_at).toLocaleDateString('en-IN')}
                {d.outcome ? ` · ${d.outcome}` : ''}
              </Text>
            </View>
          );
        })}
      </View>
    </Card>
  );
}
