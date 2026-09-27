import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Card, Chip, Divider, Glyph, Text } from '../../../components';
import { useTheme } from '../../../theme';
import type { ScenarioSimulateResponse } from '../../../api/types';
import { Markdown } from '../../ask/Markdown';
import {
  formatImpactValue,
  goalImpacts,
  goalPct,
  humanizeKey,
  impactEntries,
  timelineDetail,
} from '../constants';

/**
 * A finished simulation.
 *
 * Reproduces `renderSimulationResult()` from twin-app/js/app.js section for
 * section, including the branch that matters most: `mode`. A scenario run has
 * a projection to show, so it gets impact, timeline, recommendation, risks,
 * assumptions and teaching. An *informational* answer has none of those — the
 * question was about the position as it already stands, so the backend routed
 * it through Ask Twin and the reply is a markdown answer under a snapshot.
 * Rendering the second as though it were the first would invent a projection
 * that was never computed.
 *
 * The web lays this out as a right-hand results column beside the form. Here it
 * is the continuation of one scroll, which is the same reading order on a
 * screen that cannot hold two columns.
 */

interface Props {
  result: ScenarioSimulateResponse;
  currency: string;
}

/** The web's `.impact-grid` — two columns of label-over-value tiles. */
function ImpactGrid({
  entries,
  currency,
}: {
  entries: [string, unknown][];
  currency: string;
}) {
  const theme = useTheme();

  if (!entries.length) {
    return (
      <Text variant="bodySmall" color="faint">
        No quantitative impact could be computed from this scenario.
      </Text>
    );
  }

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
      {entries.map(([key, value]) => (
        <View
          key={key}
          style={{
            // Two per row, accounting for the gap between them.
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
            {humanizeKey(key)}
          </Text>
          <Text variant="heading" tabular>
            {formatImpactValue(key, value, currency)}
          </Text>
        </View>
      ))}
    </View>
  );
}

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

/** The web's `.alert--warn` / `.alert--info` bullet lists. */
function AlertList({ items, tone }: { items: string[]; tone: 'warn' | 'info' }) {
  const theme = useTheme();
  const color = tone === 'warn' ? theme.colors.warn : theme.colors.accent;

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {items.map((item, i) => (
        <View
          key={`${tone}-${i}`}
          style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-start' }}
        >
          <View
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: color,
              marginTop: 7,
            }}
          />
          <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
            {item}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function SimulationResult({ result, currency }: Props) {
  const theme = useTheme();
  const [traceOpen, setTraceOpen] = useState(false);

  const isInformational = result.mode === 'informational';
  const entries = impactEntries(result.financial_impact);
  const goals = isInformational ? [] : goalImpacts(result.financial_impact);
  const timeline = isInformational ? [] : result.timeline ?? [];

  return (
    <View style={{ gap: theme.spacing.xxl }}>
      {/* ------------------------------------------------------- scenario */}
      <Section title="Scenario">
        <Text variant="body" color="muted" style={{ fontStyle: 'italic' }}>
          “{result.scenario}”
        </Text>
      </Section>

      <Divider />

      {/* --------------------------------------------------------- impact */}
      <Section title={isInformational ? 'Your current snapshot' : 'Financial impact'}>
        <ImpactGrid entries={entries} currency={currency} />
      </Section>

      {/* ---------------------------------------------------- goal impact */}
      {goals.length ? (
        <>
          <Divider />
          <Section title="Goal impact">
            <View style={{ gap: theme.spacing.sm }}>
              {goals.map((g, i) => (
                <View
                  key={`${g.label}-${i}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: theme.spacing.md,
                    padding: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: theme.colors.line,
                    backgroundColor: theme.colors.surface2,
                  }}
                >
                  <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
                    {g.label}
                  </Text>
                  <Text variant="heading" tabular>
                    {goalPct(g.progress_before_pct)} → {goalPct(g.progress_after_pct)}
                  </Text>
                </View>
              ))}
            </View>
          </Section>
        </>
      ) : null}

      {/* ------------------------------------------------------- timeline */}
      {!isInformational ? (
        <>
          <Divider />
          <Section title="Timeline">
            {timeline.length ? (
              <View style={{ gap: theme.spacing.lg }}>
                {timeline.map((entry, i) => {
                  const label = String(entry.label ?? '');
                  const rows = timelineDetail(entry);
                  const last = i === timeline.length - 1;

                  return (
                    <View key={`${label}-${i}`} style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                      {/* The web's `.timeline-step__dot` plus its connecting rail. */}
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
                        <Text variant="bodySmall">{label}</Text>
                        {rows.map(([k, v]) => (
                          <View
                            key={k}
                            style={{
                              flexDirection: 'row',
                              justifyContent: 'space-between',
                              gap: theme.spacing.md,
                            }}
                          >
                            <Text variant="bodySmall" color="faint" style={{ flex: 1 }}>
                              {humanizeKey(k)}
                            </Text>
                            <Text variant="bodySmall" tabular>
                              {formatImpactValue(k, v, currency)}
                            </Text>
                          </View>
                        ))}
                      </View>
                    </View>
                  );
                })}
              </View>
            ) : (
              <Text variant="bodySmall" color="faint">
                No timeline applies to this scenario.
              </Text>
            )}
          </Section>
        </>
      ) : null}

      <Divider />

      {/* -------------------------------------------------- alternatives */}
      {/* Shown before the recommendation on purpose. Simulation's job is to
          show what could happen, not to confirm what the chatbot suggested, so
          the user meets the range of realistic approaches first and reads the
          recommendation as one option among them. */}
      {!isInformational && result.alternative_paths?.length ? (
        <>
          <Section title="Approaches to compare">
            <View style={{ gap: theme.spacing.md }}>
              <Text variant="bodySmall" color="faint">
                Same amount, same horizon, three different risk postures. None of these is chosen
                for you.
              </Text>
              {result.alternative_paths.map((p) => (
                <View
                  key={p.key}
                  style={{
                    gap: 6,
                    padding: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: p.is_aligned ? theme.colors.accentBorder : theme.colors.line,
                    backgroundColor: p.is_aligned
                      ? theme.colors.accentTint
                      : theme.colors.surface2,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: theme.spacing.sm,
                    }}
                  >
                    <Text variant="bodySmall" color={p.is_aligned ? 'accent' : 'ink'}>
                      {p.label}
                    </Text>
                    {p.is_aligned ? <Chip label="Matches what you said" tone="accent" /> : null}
                  </View>

                  <Text variant="bodySmall" color="muted">
                    {p.description}
                  </Text>

                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      gap: theme.spacing.md,
                      paddingTop: 2,
                    }}
                  >
                    <View style={{ gap: 2 }}>
                      <Text variant="label" color="faint">
                        Projected
                      </Text>
                      <Text variant="heading" tabular>
                        {formatImpactValue('projected_value', p.projected_value, currency)}
                      </Text>
                    </View>
                    <View style={{ gap: 2 }}>
                      <Text variant="label" color="faint">
                        In a bad stretch
                      </Text>
                      <Text variant="heading" tabular>
                        {formatImpactValue('projected_value', p.plausible_trough_value, currency)}
                      </Text>
                    </View>
                    <View style={{ gap: 2 }}>
                      <Text variant="label" color="faint">
                        Assumed return
                      </Text>
                      <Text variant="heading" tabular>
                        {p.assumed_annual_return_pct}%
                      </Text>
                    </View>
                  </View>

                  {p.caveats.map((c, i) => (
                    <Text key={i} variant="bodySmall" style={{ color: theme.colors.warn }}>
                      {c}
                    </Text>
                  ))}
                </View>
              ))}
              <Text variant="label" color="faint">
                The downside figure is a plausible trough, not a floor or a worst case.
              </Text>
            </View>
          </Section>

          <Divider />
        </>
      ) : null}

      {/* ------------------------------------------- answer / recommendation */}
      {isInformational ? (
        <Card label="Twin's answer">
          <Markdown content={result.recommendation} />
        </Card>
      ) : (
        <>
          <Card label="Recommend agent">
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="body">{result.recommendation}</Text>
              {result.why ? (
                <Text variant="bodySmall" color="muted">
                  {result.why}
                </Text>
              ) : null}
            </View>
          </Card>

          {result.risks?.length ? (
            <Section title="Risks / what to watch">
              <AlertList items={result.risks} tone="warn" />
            </Section>
          ) : null}

          {result.assumptions?.length ? (
            <Section title="Assumptions">
              <AlertList items={result.assumptions} tone="info" />
            </Section>
          ) : null}

          {result.teaching ? (
            <Card label="Teach agent explains">
              <Text variant="bodySmall" color="muted">
                {result.teaching}
              </Text>
            </Card>
          ) : null}
        </>
      )}

      <Divider />

      {/* ---------------------------------------------------------- trace */}
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
