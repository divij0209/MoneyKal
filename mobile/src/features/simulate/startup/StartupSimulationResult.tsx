import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import type {
  ScenarioComparisonVariant,
  ScenarioGoalImpact,
  ScenarioSimulateResponse,
  ScenarioTimelineSeries,
} from '../../../api/types';
import { Card, Chip, Divider, Glyph, Text } from '../../../components';
import { useTheme } from '../../../theme';
import { ChartLegend, TrendChart } from '../../startupOverview/charts';
import { Markdown } from '../../ask/Markdown';
import { deltaTone, mainBenefit, mainRisk, materialRisks } from '../constants';

/**
 * A finished Startup simulation.
 *
 * Transcribed from `renderStartupSimulationResult()` in twin-app/js/startup.js,
 * which is a different renderer from the Individual one — different sections,
 * different `financial_impact` keys, and two extra payload blocks
 * (`timeline_series`, `comparison_variants`) the Individual pipeline never
 * produces.
 *
 * Every figure is the backend's. The only arithmetic here is subtracting two
 * server-computed numbers to show a delta, and averaging the goal-progress
 * column — both lifted from the web line for line.
 */

interface Props {
  result: ScenarioSimulateResponse;
  currency: string;
}

const money = (currency: string, v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v)
    ? '—'
    : `${currency}${Math.round(v).toLocaleString('en-IN')}`;

const num = (impact: Record<string, unknown>, key: string): number | null =>
  typeof impact[key] === 'number' ? (impact[key] as number) : null;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.md }}>
      <Text variant="label" color="muted">
        {title}
      </Text>
      {children}
    </View>
  );
}

/* ------------------------------------------------------ scenario summary -- */

function ScenarioSummary({ result, currency }: Props) {
  const theme = useTheme();
  const impact = result.financial_impact ?? {};

  const col = (label: string, keys: [string, string, string, string]) => (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '46%',
        gap: theme.spacing.sm,
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text variant="label" color="faint">
        {label}
      </Text>
      {(
        [
          ['Cash', money(currency, num(impact, keys[0]))],
          ['Monthly burn', money(currency, num(impact, keys[1]))],
          [
            'Runway',
            num(impact, keys[2]) === null ? '—' : `${num(impact, keys[2])!.toFixed(1)} mo`,
          ],
          ['Revenue', money(currency, num(impact, keys[3]))],
        ] as [string, string][]
      ).map(([k, v]) => (
        <View
          key={k}
          style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm }}
        >
          <Text variant="bodySmall" color="faint">
            {k}
          </Text>
          <Text variant="bodySmall" tabular>
            {v}
          </Text>
        </View>
      ))}
    </View>
  );

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
      {col('Current baseline', [
        'cash_before',
        'net_burn_before',
        'runway_before',
        'revenue_before',
      ])}
      {col('Projected scenario', [
        'cash_after',
        'net_burn_after',
        'runway_after',
        'revenue_after',
      ])}
    </View>
  );
}

/* ---------------------------------------------------------- before/after -- */

function CompareCard({
  label,
  before,
  after,
  format,
  goodDirection,
}: {
  label: string;
  before: number | null;
  after: number | null;
  format: (v: number) => string;
  goodDirection: 'up' | 'down';
}) {
  const theme = useTheme();
  const tone = deltaTone(before, after, goodDirection);
  const hasBoth = before !== null && after !== null;
  const color =
    tone === 'good' ? theme.colors.pos : tone === 'bad' ? theme.colors.neg : theme.colors.inkFaint;

  const deltaTxt = hasBoth
    ? Math.abs(after! - before!) < 1e-9
      ? 'No change'
      : `${after! >= before! ? '+' : ''}${format(after! - before!)}`
    : '';

  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '46%',
        gap: 4,
        padding: theme.spacing.md,
        borderRadius: theme.radius.md,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.surface2,
      }}
    >
      <Text variant="label" color="faint">
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Text variant="bodySmall" color="faint" tabular>
          {before === null ? '—' : format(before)}
        </Text>
        <Glyph name="arrowRight" color={theme.colors.inkFaint} size={12} />
        <Text variant="heading" tabular>
          {after === null ? '—' : format(after)}
        </Text>
      </View>
      {deltaTxt ? (
        <Text variant="label" style={{ color }}>
          {deltaTxt}
        </Text>
      ) : null}
    </View>
  );
}

function BeforeAfter({ result, currency }: Props) {
  const theme = useTheme();
  const impact = result.financial_impact ?? {};
  const goalImpact = (Array.isArray(impact.goal_impact)
    ? (impact.goal_impact as ScenarioGoalImpact[])
    : []) as ScenarioGoalImpact[];

  // Goal progress folds into this grid as one averaged card — the Startup
  // layout's own treatment, rather than a section of its own.
  const avg = (k: 'progress_before_pct' | 'progress_after_pct') =>
    goalImpact.length
      ? goalImpact.reduce((s, g) => s + (g[k] ?? 0), 0) / goalImpact.length
      : null;

  const riskCount = materialRisks(result.risks).length;

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
      <CompareCard
        label="Cash"
        before={num(impact, 'cash_before')}
        after={num(impact, 'cash_after')}
        format={(v) => money(currency, v)}
        goodDirection="up"
      />
      <CompareCard
        label="Monthly Burn"
        before={num(impact, 'net_burn_before')}
        after={num(impact, 'net_burn_after')}
        format={(v) => money(currency, v)}
        goodDirection="down"
      />
      <CompareCard
        label="Runway"
        before={num(impact, 'runway_before')}
        after={num(impact, 'runway_after')}
        format={(v) => `${v.toFixed(1)} mo`}
        goodDirection="up"
      />
      <CompareCard
        label="Revenue"
        before={num(impact, 'revenue_before')}
        after={num(impact, 'revenue_after')}
        format={(v) => money(currency, v)}
        goodDirection="up"
      />
      <CompareCard
        label="Financial Health"
        before={num(impact, 'financial_health_before')}
        after={num(impact, 'financial_health_after')}
        format={(v) => `${v.toFixed(0)}/100`}
        goodDirection="up"
      />
      {goalImpact.length ? (
        <CompareCard
          label="Goal Progress (avg)"
          before={avg('progress_before_pct')}
          after={avg('progress_after_pct')}
          format={(v) => `${v.toFixed(0)}%`}
          goodDirection="up"
        />
      ) : null}
      <CompareCard
        label="Risk flags"
        before={0}
        after={riskCount}
        format={(v) => `${Math.round(v)} flag${Math.round(v) === 1 ? '' : 's'}`}
        goodDirection="down"
      />
    </View>
  );
}

/* ------------------------------------------------------------ impact flow -- */

function ImpactFlow({ result, currency }: Props) {
  const theme = useTheme();
  const impact = result.financial_impact ?? {};

  // The web omits the whole block when burn isn't computable.
  const nbBefore = num(impact, 'net_burn_before');
  const nbAfter = num(impact, 'net_burn_after');
  if (nbBefore === null || nbAfter === null) return null;

  const nodes: { label: string; value: string; tone: 'good' | 'bad' | 'flat' }[] = [
    {
      label: 'Decision',
      value: (result.scenario_type || '').replace(/_/g, ' ') || 'Scenario',
      tone: 'flat',
    },
  ];

  const burnDelta = nbAfter - nbBefore;
  nodes.push({
    label: 'Burn Impact',
    value: `${burnDelta >= 0 ? '+' : ''}${money(currency, burnDelta)}/mo`,
    tone: burnDelta > 0 ? 'bad' : burnDelta < 0 ? 'good' : 'flat',
  });

  const cb = num(impact, 'cash_before');
  const ca = num(impact, 'cash_after');
  if (cb !== null && ca !== null) {
    const d = ca - cb;
    nodes.push({
      label: 'Cash Impact',
      value: `${d >= 0 ? '+' : ''}${money(currency, d)}`,
      tone: d >= 0 ? 'good' : 'bad',
    });
  }

  const rb = num(impact, 'runway_before');
  const ra = num(impact, 'runway_after');
  if (rb !== null && ra !== null) {
    const d = ra - rb;
    nodes.push({
      label: 'Runway Impact',
      value: `${d >= 0 ? '+' : ''}${d.toFixed(1)} mo`,
      tone: d >= 0 ? 'good' : 'bad',
    });
  }

  const riskCount = materialRisks(result.risks).length;
  nodes.push({
    label: 'Goal / Risk Impact',
    value: `${riskCount} risk flag${riskCount === 1 ? '' : 's'}`,
    tone: riskCount > 0 ? 'bad' : 'good',
  });

  const color = (t: 'good' | 'bad' | 'flat') =>
    t === 'good' ? theme.colors.pos : t === 'bad' ? theme.colors.neg : theme.colors.ink;

  // The web lays these left-to-right with arrows. A phone gets the same chain
  // scrolling sideways rather than wrapped, so the sequence stays readable.
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ alignItems: 'center', gap: theme.spacing.sm }}
    >
      {nodes.map((n, i) => (
        <React.Fragment key={n.label}>
          {i > 0 ? <Glyph name="arrowRight" color={theme.colors.inkFaint} size={14} /> : null}
          <View
            style={{
              gap: 4,
              minWidth: 116,
              padding: theme.spacing.md,
              borderRadius: theme.radius.md,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text variant="label" color="faint">
              {n.label}
            </Text>
            <Text variant="bodySmall" style={{ color: color(n.tone) }} tabular>
              {n.value}
            </Text>
          </View>
        </React.Fragment>
      ))}
    </ScrollView>
  );
}

/* ------------------------------------------------------------- projection -- */

function Projection({ series, currency }: { series: ScenarioTimelineSeries; currency: string }) {
  const theme = useTheme();

  const maxLen = Math.max(series.baseline?.length ?? 0, series.scenario?.length ?? 0);
  const periods = [3, 6, 12].filter((p) => p <= maxLen);
  if (!periods.length) periods.push(maxLen);

  const [months, setMonths] = useState(periods[periods.length - 1]);

  const baseline = (series.baseline ?? []).slice(0, months);
  const scenario = (series.scenario ?? []).slice(0, months);
  const len = Math.max(baseline.length, scenario.length);

  const xLabels = Array.from({ length: len }, (_, i) => `+${i + 1}mo`);

  return (
    <View style={{ gap: theme.spacing.md }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        {periods.map((p) => {
          const active = p === months;
          return (
            <Pressable
              key={p}
              onPress={() => setMonths(p)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Show ${p} months`}
              style={({ pressed }) => ({
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.pill,
                borderWidth: 1,
                borderColor: active ? theme.colors.accent : theme.colors.line,
                backgroundColor: active ? theme.colors.accentTint : 'transparent',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text variant="label" color={active ? 'accent' : 'muted'}>
                {p} months
              </Text>
            </Pressable>
          );
        })}
      </View>

      {len >= 2 ? (
        <>
          <TrendChart
            currency={currency}
            xLabels={xLabels}
            series={[
              {
                label: 'Baseline',
                color: theme.colors.chartBlue,
                points: Array.from({ length: len }, (_, i) => baseline[i]?.projected_cash ?? null),
              },
              {
                label: 'Scenario',
                color: theme.colors.chartOrange,
                dashed: true,
                points: Array.from({ length: len }, (_, i) => scenario[i]?.projected_cash ?? null),
              },
            ]}
          />
          <ChartLegend
            items={[
              { label: 'Baseline (no change)', color: theme.colors.chartBlue },
              { label: 'Scenario', color: theme.colors.chartOrange, dashed: true },
            ]}
          />
        </>
      ) : (
        <Text variant="bodySmall" color="faint">
          Not enough projection data.
        </Text>
      )}
    </View>
  );
}

/* ------------------------------------------------------------- comparison -- */

function Comparison({
  variants,
  currency,
}: {
  variants: ScenarioComparisonVariant[];
  currency: string;
}) {
  const theme = useTheme();

  const COLS: { head: string; get: (v: ScenarioComparisonVariant) => string; w: number }[] = [
    { head: 'Cash', get: (v) => money(currency, v.cash_after), w: 104 },
    { head: 'Burn', get: (v) => money(currency, v.net_burn_after), w: 104 },
    {
      head: 'Runway',
      get: (v) => (v.runway_after === null || v.runway_after === undefined ? '—' : `${v.runway_after.toFixed(1)} mo`),
      w: 80,
    },
    { head: 'Revenue', get: (v) => money(currency, v.revenue_after), w: 104 },
    {
      head: 'Goals',
      get: (v) =>
        v.goal_progress_avg_after === null || v.goal_progress_avg_after === undefined
          ? '—'
          : `${v.goal_progress_avg_after.toFixed(0)}%`,
      w: 66,
    },
    { head: 'Risks', get: (v) => String(v.risk_count), w: 56 },
  ];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {/* header */}
        <View
          style={{
            flexDirection: 'row',
            paddingBottom: theme.spacing.sm,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.line,
          }}
        >
          <Text variant="label" color="faint" style={{ width: 150 }}>
            Option
          </Text>
          {COLS.map((c) => (
            <Text key={c.head} variant="label" color="faint" style={{ width: c.w, textAlign: 'right' }}>
              {c.head}
            </Text>
          ))}
        </View>

        {variants.map((v, i) => (
          <View
            key={`${v.label}-${i}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: theme.spacing.md,
              borderBottomWidth: 1,
              borderBottomColor: theme.colors.line,
              backgroundColor: v.is_recommended ? theme.colors.accentTint : 'transparent',
            }}
          >
            <View style={{ width: 150, gap: 4, paddingRight: theme.spacing.sm }}>
              <Text variant="bodySmall">{v.label}</Text>
              {v.is_recommended ? (
                <View style={{ flexDirection: 'row' }}>
                  <Chip label="Recommended" tone="accent" />
                </View>
              ) : null}
            </View>
            {COLS.map((c) => (
              <Text
                key={c.head}
                variant="bodySmall"
                tabular
                style={{ width: c.w, textAlign: 'right' }}
              >
                {c.get(v)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/* ------------------------------------------------------------------ main -- */

export function StartupSimulationResult({ result, currency }: Props) {
  const theme = useTheme();
  const [traceOpen, setTraceOpen] = useState(false);

  /* Informational mode: the web renders the scenario, Tathya's markdown answer
     and the disclaimer — no projection, no comparison, no before/after. */
  if (result.mode === 'informational') {
    return (
      <View style={{ gap: theme.spacing.xxl }}>
        <Section title="Scenario">
          <Text variant="body" color="muted" style={{ fontStyle: 'italic' }}>
            “{result.scenario}”
          </Text>
        </Section>
        <Card label="Twin's answer">
          <Markdown content={result.recommendation} />
        </Card>
        <Text variant="bodySmall" color="faint">
          {result.disclaimer}
        </Text>
      </View>
    );
  }

  const risks = materialRisks(result.risks);
  const assumptions = result.assumptions ?? [];
  const series = result.timeline_series;
  const variants = result.comparison_variants ?? [];
  const hasProjection =
    !!series && ((series.baseline?.length ?? 0) > 0 || (series.scenario?.length ?? 0) > 0);

  return (
    <View style={{ gap: theme.spacing.xxl }}>
      <Section title="Scenario">
        <Text variant="body" color="muted" style={{ fontStyle: 'italic' }}>
          “{result.scenario}”
        </Text>
      </Section>

      <Divider />
      <Section title="Scenario summary">
        <ScenarioSummary result={result} currency={currency} />
      </Section>

      <Divider />
      <Section title="Before vs After">
        <BeforeAfter result={result} currency={currency} />
      </Section>

      <Divider />
      <Section title="Scenario Impact Flow">
        <ImpactFlow result={result} currency={currency} />
      </Section>

      {/* ------------------------------------------------- the assumptions --
          Placed immediately above the projection and comparison, and given a
          warn-toned panel rather than a footnote, because those two blocks are
          only as true as these lines are. The ₹0/month hire cost that the
          onboarding wizard stores is stated here in the backend's own words —
          without it, three identical comparison rows look like a finding
          rather than a missing input. */}
      {assumptions.length ? (
        <View
          style={{
            gap: theme.spacing.sm,
            padding: theme.spacing.lg,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.warn,
            backgroundColor: theme.colors.warnTint,
          }}
        >
          <Text variant="label" style={{ color: theme.colors.warn }}>
            What this assumes
          </Text>
          {assumptions.map((a, i) => (
            <Text key={i} variant="bodySmall" color="muted">
              · {a}
            </Text>
          ))}
          <Text variant="label" color="faint">
            The projection and comparison below rest on these.
          </Text>
        </View>
      ) : null}

      {hasProjection ? (
        <Section title="Scenario Projection">
          <Projection series={series!} currency={currency} />
        </Section>
      ) : null}

      {variants.length ? (
        <Section title="Scenario Comparison">
          <Comparison variants={variants} currency={currency} />
        </Section>
      ) : null}

      <Divider />
      <Card label="TATHYA's recommendation">
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="body">✅ {result.recommendation}</Text>
          {result.why ? (
            <Text variant="bodySmall" color="muted">
              {result.why}
            </Text>
          ) : null}
          <View style={{ gap: 4 }}>
            <Text variant="label" color="faint">
              Main benefit
            </Text>
            <Text variant="bodySmall" color="muted">
              {mainBenefit(result.financial_impact ?? {}, currency)}
            </Text>
          </View>
          <View style={{ gap: 4 }}>
            <Text variant="label" color="faint">
              Main risk
            </Text>
            <Text variant="bodySmall" color="muted">
              {mainRisk(result.risks)}
            </Text>
          </View>
        </View>
      </Card>

      {risks.length ? (
        <Section title="Risks / what to watch">
          <View style={{ gap: theme.spacing.sm }}>
            {risks.map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                <View
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 3,
                    marginTop: 7,
                    backgroundColor: theme.colors.warn,
                  }}
                />
                <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
                  {r}
                </Text>
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {result.teaching ? (
        <Card label="Teach agent explains">
          <Text variant="bodySmall" color="muted">
            {result.teaching}
          </Text>
        </Card>
      ) : null}

      <Divider />
      <View style={{ gap: theme.spacing.md }}>
        <Pressable
          onPress={() => setTraceOpen((v) => !v)}
          accessibilityRole="button"
          accessibilityState={{ expanded: traceOpen }}
          hitSlop={8}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Glyph
            name={traceOpen ? 'chevronLeft' : 'chevronRight'}
            color={theme.colors.inkMuted}
            size={14}
          />
          <Text variant="bodySmall" color="muted">
            How this was computed
          </Text>
        </Pressable>

        {traceOpen ? (
          <View style={{ gap: theme.spacing.sm, paddingLeft: theme.spacing.xl }}>
            {(result.stages ?? []).map((s, i) => (
              <View key={`${s.agent}-${i}`} style={{ gap: 2 }}>
                <Text variant="label" color="accent">
                  {s.agent}
                </Text>
                <Text variant="bodySmall" color="faint">
                  {s.summary}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: 'row' }}>
          <Chip label={result.scenario_type.replace(/_/g, ' ')} tone="accent" />
        </View>

        <Text variant="bodySmall" color="faint">
          {result.disclaimer}
        </Text>
      </View>
    </View>
  );
}
