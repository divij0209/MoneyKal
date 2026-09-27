import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';
import { useFocusEffect } from '@react-navigation/native';

import {
  Button,
  Card,
  Chip,
  Divider,
  Screen,
  Text,
  confirmDestructive,
} from '../../components';
import type { DecisionContext } from '../../api/types';
import { useT } from '../../i18n';
import type { IndividualTabParamList } from '../../navigation/types';
import { useProfile } from '../../store';
import { useTheme } from '../../theme';
import { AgentPipeline } from './components/AgentPipeline';
import { SimulationResult } from './components/SimulationResult';
import { SCENARIO_SUGGESTIONS, STARTUP_SCENARIO_SUGGESTIONS, prettyScenarioType } from './constants';
import { useSimulation } from './hooks';
import { StartupSimulationResult } from './startup/StartupSimulationResult';

type Props = BottomTabScreenProps<IndividualTabParamList, 'Simulate'>;

/**
 * When a stored run was made, in the reader's own timezone.
 *
 * The server sends UTC with a trailing Z, so this converts rather than guesses.
 * Today's runs get a time, older ones a date — which is what someone scanning
 * the list is actually looking for at each distance.
 */
function formatRunTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';

  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) {
    return then.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) {
    return `Yesterday, ${then.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
  }

  return then.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: then.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Simulate a decision — the mobile counterpart of `#view-simulate`.
 *
 * Describe a situation in plain language, and the backend's six-agent pipeline
 * projects it against the twin. What matters about this screen is what it does
 * *not* do: no scenario is parsed here, no projection is run here, and no
 * number on it was produced on the device. It sends one sentence to
 * POST /twin/simulate-scenario and renders the reply, so a simulation run on a
 * phone and the same one run on the website are the same simulation.
 *
 * The web splits this into a form column and a results column. On a phone it
 * is one scroll — the same reading order, minus a second column there is no
 * room for.
 */
export function SimulateScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const t = useT();
  const { profile, persona } = useProfile();
  const currency = profile?.currency || '₹';

  /* The screen is shared by both tab sets, and the backend already branches on
     profile.key: a founder's request goes to startup_orchestrator and comes
     back with different `financial_impact` keys plus timeline_series and
     comparison_variants. So the form, the pipeline and the history stay common
     and only the suggestions and the results renderer differ — the same split
     the web makes between renderSimulationResult and
     renderStartupSimulationResult. */
  const isStartup = persona === 'startup';
  const suggestions = isStartup ? STARTUP_SCENARIO_SUGGESTIONS : SCENARIO_SUGGESTIONS;

  const sim = useSimulation();
  const [scenario, setScenario] = useState('');
  /** True while the result on screen came out of history rather than out of a
   *  run started here. Only the banner depends on it — the result itself is
   *  rendered identically either way, because it is the same payload. */
  const [viewingSaved, setViewingSaved] = useState(false);
  const [height, setHeight] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  /** Where the result block sits in the scroll, so opening a stored run from
   *  the list at the bottom lands on the result rather than somewhere near it. */
  const resultY = useRef(0);
  const inputRef = useRef<TextInput>(null);

  /* ------------------------------------------------ TATHYA -> Simulate ---
     Ask Twin's contextual CTA hands the decision over as route params. The web
     does the same thing through `pendingScenarioPrefill`, which it clears on
     read so returning to the tab later doesn't silently refill the box.
     Clearing the params here is that same one-shot behaviour.

     `handedOver` holds what the conversation established. It is kept in a ref
     rather than in state because it must survive the param being cleared, and
     because editing the sentence should not silently discard it — the user can
     drop it explicitly with the "Start fresh" action below. */
  const prefill = route.params?.scenario;
  const handedOver = useRef<DecisionContext | null>(null);
  const [handoffLabel, setHandoffLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill) return;
    setScenario(prefill);
    handedOver.current = route.params?.decisionContext ?? null;
    setHandoffLabel(route.params?.ctaLabel ?? null);
    navigation.setParams({ scenario: undefined, decisionContext: undefined, ctaLabel: undefined });
    const t = setTimeout(() => inputRef.current?.focus(), 140);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, navigation]);

  /* ------------------------------------------------------- past runs ---
     Simulations are stored server-side against the profile, so the tab opens
     with what this account has already explored — including runs made on the
     website. Refreshing on focus rather than only on mount is what keeps the
     list right after a run started from Ask Twin's hand-off, or on the other
     client, while this screen sat in the background. */
  const { refreshHistory } = sim;
  useFocusEffect(
    useCallback(() => {
      void refreshHistory();
    }, [refreshHistory]),
  );

  const canRun = scenario.trim().length > 0 && !sim.running;

  const handleRun = useCallback(() => {
    if (!canRun) return;
    setViewingSaved(false);
    void sim.run(scenario, handedOver.current);
    // Bring the pipeline into view — on a phone the button is often the last
    // thing on screen, and the stages appear below it.
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 120);
  }, [canRun, sim, scenario]);

  /** Drop the conversation's context and treat this as a plain typed scenario.
   *  The user is never locked into what the chatbot concluded. */
  const clearHandoff = useCallback(() => {
    handedOver.current = null;
    setHandoffLabel(null);
  }, []);

  /**
   * Open a stored run.
   *
   * The result area is reused rather than pushed onto a second screen, so a
   * past run reads exactly as it did when it finished — same layout, same
   * components, same pipeline trace. The box is refilled with its scenario too,
   * which makes "open it, edit a number, run it again" the natural next step.
   */
  const openStoredRun = useCallback(
    (runId: string, runScenario: string) => {
      if (sim.running || sim.openingId) return;
      setScenario(runScenario);
      // A stored run is its own thing; the live conversation's context has
      // nothing to do with it.
      clearHandoff();
      void sim.openRun(runId).then((detail) => {
        if (!detail) return;
        setViewingSaved(true);
        // Let the result block lay out and report its position before moving.
        setTimeout(
          () =>
            scrollRef.current?.scrollTo({
              y: Math.max(resultY.current - theme.spacing.md, 0),
              animated: true,
            }),
          120,
        );
      });
    },
    [sim, clearHandoff, theme.spacing.md],
  );

  const confirmDeleteRun = useCallback(
    (runId: string, runScenario: string) => {
      confirmDestructive({
        title: 'Delete this simulation?',
        message: `"${runScenario}" will be removed from your history. This can't be undone.`,
        onConfirm: () => void sim.removeRun(runId),
      });
    },
    [sim],
  );

  // Stage summaries, keyed by agent, for the pipeline rows.
  const summaries: Record<string, string> = {};
  for (const s of sim.result?.stages ?? []) summaries[s.agent] = s.summary;

  /** The list row for the run currently on screen, for the banner's timestamp. */
  const openedSummary = sim.openRunId
    ? sim.history.find((h) => h.id === sim.openRunId)
    : undefined;

  return (
    // The screen owns its scroller rather than using <Screen scroll> so a
    // finished run can bring the pipeline into view; everything else about the
    // frame — safe area, background, status bar — still comes from Screen.
    <Screen padded={false}>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingBottom: theme.spacing.huge,
          gap: theme.spacing.xxl,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        showsVerticalScrollIndicator={false}
      >
        {/* --------------------------------------------------- the framing
            What this screen is for, stated once. Simulate is MoneyKal's
            analytical surface — it runs the backend's agent pipeline over the
            real profile and ledger — and saying so in a line of type is worth
            more than any amount of "AI" ornament. */}
        <View style={{ gap: theme.spacing.xs, paddingTop: theme.spacing.lg }}>
          <Text variant="display">{t('sim.title')}</Text>
          <Text variant="body" color="muted">
            {t('sim.subtitle')}
          </Text>
        </View>

        {/* ----------------------------------------------------- the form */}
        <View style={{ gap: theme.spacing.md }}>
          {/* Says out loud what came across from the conversation, and offers a
              way out of it. A hand-off the user can't see or undo would make
              Simulation feel like it was deciding things on their behalf. */}
          {handoffLabel ? (
            <View
              style={{
                gap: 4,
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: theme.colors.accentBorder,
                backgroundColor: theme.colors.accentTint,
              }}
            >
              <Text variant="label" color="accent">
                {handoffLabel}
              </Text>
              <Text variant="bodySmall" color="muted">
                Carried over from your conversation with the Twin — the amount, purpose, horizon
                and risk preferences you already gave are included, so you don't have to repeat
                them.
              </Text>
              <Pressable
                onPress={clearHandoff}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Start fresh without the conversation's context"
                style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingTop: 2 })}
              >
                <Text variant="bodySmall" color="accent">
                  Start fresh instead
                </Text>
              </Pressable>
            </View>
          ) : null}

          <Text variant="label" color="faint">
            {t('sim.scenario')}
          </Text>

          <TextInput
            ref={inputRef}
            value={scenario}
            onChangeText={setScenario}
            placeholder={t('sim.scenarioPlaceholder')}
            placeholderTextColor={theme.colors.inkFaint}
            selectionColor={theme.colors.accent}
            multiline
            editable={!sim.running}
            onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height)}
            style={{
              color: theme.colors.ink,
              ...theme.type.body,
              backgroundColor: theme.colors.surface2,
              borderWidth: 1,
              borderColor: theme.colors.line,
              borderRadius: theme.radius.lg,
              paddingHorizontal: theme.spacing.lg,
              paddingTop: theme.spacing.md,
              paddingBottom: theme.spacing.md,
              minHeight: 96,
              maxHeight: 180,
              height: Math.min(Math.max(height + theme.spacing.xxl, 96), 180),
              textAlignVertical: 'top',
            }}
          />

          {/* The web's `.sim-chip-row` — tapping fills the box, as there. */}
          <Text variant="label" color="faint" style={{ marginTop: theme.spacing.xs }}>
            {t('sim.examples')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {suggestions.map((s) => (
              <Pressable
                key={s}
                onPress={() => {
                  setScenario(s);
                  // A suggestion is a different decision entirely, so the
                  // conversation's context no longer applies to it.
                  clearHandoff();
                  inputRef.current?.focus();
                }}
                disabled={sim.running}
                accessibilityRole="button"
                accessibilityLabel={`Use scenario: ${s}`}
                style={({ pressed }) => ({
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  borderRadius: theme.radius.pill,
                  borderWidth: 1,
                  borderColor: pressed ? theme.colors.accentBorder : theme.colors.line,
                  backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
                  opacity: sim.running ? 0.4 : 1,
                })}
              >
                <Text variant="bodySmall" color="muted">
                  {s}
                </Text>
              </Pressable>
            ))}
          </View>

          <Button
            label={sim.running ? t('sim.running') : t('sim.run')}
            onPress={handleRun}
            disabled={!canRun}
            loading={sim.running}
          />
        </View>

        {/* --------------------------------------------------- the pipeline */}
        {sim.pipeline ? (
          <>
            <Divider />
            <View style={{ gap: theme.spacing.md }}>
              <Text variant="label" color="faint">
                {t('sim.pipeline')}
              </Text>
              <AgentPipeline pipeline={sim.pipeline} summaries={summaries} />
            </View>
          </>
        ) : null}

        {/* ------------------------------------------------------- failure */}
        {sim.error ? (
          <View
            style={{
              gap: theme.spacing.sm,
              padding: theme.spacing.md,
              borderRadius: theme.radius.md,
              backgroundColor: theme.colors.warnTint,
              borderWidth: 1,
              borderColor: theme.colors.warn,
            }}
          >
            <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
              {sim.error}
            </Text>
            <Button
              label="Try again"
              variant="outline"
              size="sm"
              fullWidth={false}
              onPress={handleRun}
            />
          </View>
        ) : null}

        {/* -------------------------------------------------------- result */}
        {sim.result ? (
          // Wrapped rather than a fragment so opening a stored run can scroll
          // straight to it. The gap matches the scroll container's, so the
          // grouping changes nothing visually.
          <View
            style={{ gap: theme.spacing.xxl }}
            onLayout={(e) => {
              resultY.current = e.nativeEvent.layout.y;
            }}
          >
            <Divider />
            {/* Says plainly that this is a record, not a fresh projection. The
                figures below were computed when the run happened and are shown
                unchanged — re-projecting them against today's data would move
                the numbers a decision was actually made on. */}
            {viewingSaved ? (
              <View
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
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="label" color="muted">
                    Saved simulation
                  </Text>
                  <Text variant="bodySmall" color="faint">
                    {openedSummary?.created_at
                      ? `Run ${formatRunTime(openedSummary.created_at)} — showing the result as it was calculated then.`
                      : 'Showing the result as it was calculated then.'}
                  </Text>
                </View>
                <Button
                  label="Run again"
                  variant="outline"
                  size="sm"
                  fullWidth={false}
                  onPress={handleRun}
                  disabled={!canRun}
                />
              </View>
            ) : null}
            {isStartup ? (
              <StartupSimulationResult result={sim.result} currency={currency} />
            ) : (
              <SimulationResult result={sim.result} currency={currency} />
            )}
          </View>
        ) : !sim.pipeline && !sim.error ? (
          <Card>
            <Text variant="bodySmall" color="faint">
              Describe a scenario in plain language and run the simulation to see a grounded,
              personalized breakdown here.
            </Text>
          </Card>
        ) : null}

        {/* ------------------------------------------------------- history
            Stored against the profile, not the session — so this survives
            closing the app and shows runs made on the website too. Tapping a
            row reopens that run in full. */}
        <Divider />
        <View style={{ gap: theme.spacing.md }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.md,
            }}
          >
            <Text variant="label" color="muted">
              Simulation history
            </Text>
            {sim.historyLoading && sim.history.length ? (
              <ActivityIndicator size="small" color={theme.colors.inkFaint} />
            ) : null}
          </View>

          {sim.historyError ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
                {sim.historyError}
              </Text>
              <Button
                label="Retry"
                variant="outline"
                size="sm"
                fullWidth={false}
                onPress={() => void sim.refreshHistory()}
              />
            </View>
          ) : sim.history.length ? (
            <View style={{ gap: theme.spacing.sm }}>
              {sim.history.map((h) => {
                const isOpen = h.id === sim.openRunId;
                const isOpening = h.id === sim.openingId;
                return (
                  <Pressable
                    key={h.id}
                    onPress={() => openStoredRun(h.id, h.scenario)}
                    onLongPress={() => confirmDeleteRun(h.id, h.scenario)}
                    disabled={sim.running || !!sim.openingId}
                    accessibilityRole="button"
                    accessibilityLabel={`Open simulation: ${h.scenario}`}
                    accessibilityHint="Long press to delete this simulation"
                    accessibilityState={{ selected: isOpen, busy: isOpening }}
                    style={({ pressed }) => ({
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing.md,
                      padding: theme.spacing.md,
                      borderRadius: theme.radius.md,
                      borderWidth: 1,
                      borderColor: isOpen ? theme.colors.accentBorder : theme.colors.line,
                      backgroundColor: isOpen
                        ? theme.colors.accentTint
                        : pressed
                          ? theme.colors.surface2
                          : 'transparent',
                      opacity: sim.running || (sim.openingId && !isOpening) ? 0.5 : 1,
                    })}
                  >
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text variant="bodySmall" numberOfLines={2}>
                        {h.scenario}
                      </Text>
                      {/* The outcome, so the list can be scanned for a decision
                          by what it concluded rather than only by its wording. */}
                      {h.headline ? (
                        <Text variant="label" color="faint" numberOfLines={1}>
                          {h.headline}
                        </Text>
                      ) : null}
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                          gap: theme.spacing.sm,
                          paddingTop: 2,
                        }}
                      >
                        <Text variant="label" color="faint">
                          {formatRunTime(h.created_at)}
                        </Text>
                        <Chip
                          label={
                            h.mode === 'informational'
                              ? 'answer'
                              : prettyScenarioType(h.scenario_type)
                          }
                          tone={h.mode === 'informational' ? 'neutral' : 'accent'}
                        />
                      </View>
                    </View>

                    {isOpening ? (
                      <ActivityIndicator size="small" color={theme.colors.accent} />
                    ) : (
                      <Text variant="bodySmall" color={isOpen ? 'accent' : 'faint'}>
                        {isOpen ? 'Open' : '›'}
                      </Text>
                    )}
                  </Pressable>
                );
              })}

              <Text variant="label" color="faint">
                Long-press a simulation to delete it.
              </Text>
            </View>
          ) : sim.historyLoading ? (
            <Text variant="bodySmall" color="faint">
              Loading your past simulations…
            </Text>
          ) : (
            <Text variant="bodySmall" color="faint">
              No simulations yet. Runs you do here are saved to your account, so you can come
              back and open them any time.
            </Text>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
