import React, { useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { Divider, Glyph, Text } from '../../../components';
import type { SimulationCTA } from '../../../api/types';
import { useTheme } from '../../../theme';
import { Markdown } from '../Markdown';
import type { UiMessage } from '../hooks';

interface Props {
  message: UiMessage;
  /**
   * Open Simulation with everything the conversation established.
   *
   * Offered only when the backend attached a `simulation_cta` to this reply —
   * which it does only once a concrete, simulatable decision exists. This
   * replaces the old "Simulate this →" that sat under every question the user
   * typed: that button appeared before the twin knew what the decision was, so
   * it usually handed Simulation a vague sentence and nothing else.
   */
  onSimulate?: (cta: SimulationCTA) => void;
  /** A tappable answer to the twin's follow-up. Typing instead is always
   *  possible — these are shortcuts, not a fixed set of choices. */
  onAnswer?: (text: string) => void;
}

/**
 * One turn of the conversation.
 *
 * The user's question sits right and tinted; TATHYA's answer sits left on the
 * page ground with no bubble at all. That asymmetry is deliberate — an answer
 * here is often a list of figures, and boxing it would both narrow the numbers
 * and make the screen read as a messaging app. The web makes the same
 * distinction with `.bubble--user` and `.bubble--twin`.
 */
export function MessageBubble({ message, onSimulate, onAnswer }: Props) {
  const theme = useTheme();
  const [showDetail, setShowDetail] = useState(false);

  /* ------------------------------------------------------------- user */
  if (message.role === 'user') {
    return (
      <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
        <View
          style={{
            maxWidth: '85%',
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            borderRadius: theme.radius.lg,
            borderBottomRightRadius: theme.radius.sm,
            backgroundColor: theme.colors.accentTint,
            borderWidth: message.failed ? 1 : 0,
            borderColor: theme.colors.warn,
          }}
        >
          <Text variant="body" color="ink">
            {message.content}
          </Text>
        </View>

        {message.failed ? (
          <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
            Not sent
          </Text>
        ) : null}
      </View>
    );
  }

  /* ------------------------------------------------------------- twin */
  if (message.pending) {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          paddingVertical: theme.spacing.sm,
        }}
      >
        <ActivityIndicator size="small" color={theme.colors.accent} />
        <Text variant="bodySmall" color="faint">
          Thinking…
        </Text>
      </View>
    );
  }

  const meta = message.meta;
  const trace = meta?.reasoning_trace ?? [];
  const sources = meta?.sources ?? [];
  const hasDetail = trace.length > 0 || sources.length > 0;

  const isQuestion = message.mode === 'ask';
  const isChallenge = message.mode === 'challenge';
  const suggestions = message.followUp?.suggestions ?? [];

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Glyph name={isChallenge ? 'target' : 'spark'} color={theme.colors.accent} size={14} />
        <Text variant="label" color="accent">
          TATHYA
        </Text>
        {/* What the twin decided to do with this turn, said plainly. A question
            and a recommendation read very differently, and the user should not
            have to infer which one they just got. */}
        {isQuestion ? (
          <Text variant="label" color="faint">
            understanding your goal
          </Text>
        ) : isChallenge ? (
          <Text variant="label" color="faint">
            worth reconsidering
          </Text>
        ) : meta?.confidence ? (
          <Text variant="label" color="faint">
            {meta.confidence} confidence
          </Text>
        ) : null}
      </View>

      <Markdown content={message.content} />

      {/* Tappable answers to a follow-up. Shortcuts only — the composer stays
          live underneath, so a user can always say something else, correct
          themselves, or push back. */}
      {isQuestion && suggestions.length && onAnswer ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing.sm,
            paddingTop: theme.spacing.xxs,
          }}
        >
          {suggestions.map((s) => (
            <Pressable
              key={s}
              onPress={() => onAnswer(s)}
              accessibilityRole="button"
              accessibilityLabel={`Answer: ${s}`}
              style={({ pressed }) => ({
                paddingHorizontal: theme.spacing.md,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.pill,
                borderWidth: 1,
                borderColor: pressed ? theme.colors.accentBorder : theme.colors.line,
                backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
              })}
            >
              <Text variant="bodySmall" color="muted">
                {s}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* The Simulation hand-off. Present only when the backend attached a CTA,
          which it does only once a concrete decision with modellable future
          consequences exists — never during a follow-up, and never on a
          question about the user's current position. The copy is the backend's
          too, so it names the actual decision rather than saying "simulate". */}
      {message.cta && onSimulate ? (
        <Pressable
          onPress={() => onSimulate(message.cta as SimulationCTA)}
          accessibilityRole="button"
          accessibilityLabel={message.cta.label}
          style={({ pressed }) => ({
            marginTop: theme.spacing.xs,
            padding: theme.spacing.md,
            borderRadius: theme.radius.md,
            borderWidth: 1,
            borderColor: theme.colors.accentBorder,
            backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
            gap: 3,
          })}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text variant="bodySmall" color="accent">
              {message.cta.label}
            </Text>
            <Glyph name="arrowRight" color={theme.colors.accent} size={12} />
          </View>
          {message.cta.sublabel ? (
            <Text variant="bodySmall" color="faint">
              {message.cta.sublabel}
            </Text>
          ) : null}
          {/* Simulation is optional, and saying so keeps the conversation the
              complete experience rather than a funnel into another screen. */}
          <Text variant="label" color="faint">
            Optional — you can keep talking here instead
          </Text>
        </Pressable>
      ) : null}

      {/* The backend returns its reasoning trace and sources on every answer.
          The web discards them; keeping them behind a disclosure preserves the
          audit trail without putting it in front of the answer. */}
      {hasDetail ? (
        <>
          <Pressable
            onPress={() => setShowDetail((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityState={{ expanded: showDetail }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              opacity: pressed ? 0.6 : 1,
              paddingTop: theme.spacing.xxs,
            })}
          >
            <Text variant="bodySmall" color="faint">
              {showDetail ? 'Hide how this was answered' : 'How this was answered'}
            </Text>
            <Glyph
              name={showDetail ? 'chevronLeft' : 'chevronRight'}
              color={theme.colors.inkFaint}
              size={12}
            />
          </Pressable>

          {showDetail ? (
            <View
              style={{
                gap: theme.spacing.sm,
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.surface2,
                borderWidth: 1,
                borderColor: theme.colors.line,
              }}
            >
              {trace.length ? (
                <>
                  <Text variant="label" color="faint">
                    Agents
                  </Text>
                  {trace.map((t, i) => (
                    <View key={i} style={{ gap: 2 }}>
                      <Text variant="bodySmall" color="accent">
                        {t.agent}
                      </Text>
                      <Text variant="bodySmall" color="muted">
                        {t.action}
                      </Text>
                    </View>
                  ))}
                </>
              ) : null}

              {sources.length ? (
                <>
                  <Divider />
                  <Text variant="label" color="faint">
                    Sources
                  </Text>
                  {sources.map((s, i) => (
                    <Text key={i} variant="bodySmall" color="muted">
                      {s.source}
                    </Text>
                  ))}
                </>
              ) : null}

              {meta?.disclaimer ? (
                <>
                  <Divider />
                  <Text variant="bodySmall" color="faint">
                    {meta.disclaimer}
                  </Text>
                </>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
