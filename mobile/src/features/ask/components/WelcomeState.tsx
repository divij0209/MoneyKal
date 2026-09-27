import React, { useMemo } from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Text } from '../../../components';
import { useTheme } from '../../../theme';

/**
 * TATHYA's identity, from twin-app/dashboard.html's AI Assistants card
 * (#ovTathya): the name, the tagline and the description, verbatim.
 */
export const TATHYA_TAGLINE = 'Ask. Analyze. Act.';
export const TATHYA_DESCRIPTION =
  'Ask any financial question in text and receive AI-powered analysis, insights, and actionable recommendations.';

/**
 * The greeting rotation from `seedChat()` in twin-app/js/app.js. One is picked
 * at random per fresh conversation, exactly as the web does.
 */
const GREETINGS = [
  'Ready to explore some scenarios?',
  'What financial future shall we map out today?',
  'How can I help optimize your strategy?',
  "Let's simulate your next big decision.",
  'Ask me anything about your digital twin.',
  'Ready to run some financial simulations?',
];

/**
 * The three suggested prompts from `SUGGESTIONS` in twin-app/js/app.js.
 *
 * Reproduced exactly, and not padded out: the web offers three, and inventing
 * a longer list to fill the screen would be putting words in TATHYA's mouth
 * about what it can answer.
 */
export const SUGGESTIONS = [
  'What’s my emergency buffer?',
  'How are my savings trending?',
  'Am I on track for my goal?',
];

interface Props {
  /** Stable per conversation so the greeting doesn't reshuffle on every render. */
  seed: number;
  onPickSuggestion: (text: string) => void;
}

export function WelcomeState({ seed, onPickSuggestion }: Props) {
  const theme = useTheme();
  const greeting = useMemo(() => GREETINGS[seed % GREETINGS.length], [seed]);

  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.xxl, paddingVertical: theme.spacing.xxxl }}>
      <View style={{ gap: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Glyph name="spark" color={theme.colors.accent} size={18} />
          <Text variant="label" color="accent">
            TATHYA · {TATHYA_TAGLINE}
          </Text>
        </View>

        <Text variant="display" style={{ fontSize: 28, lineHeight: 34 }}>
          {greeting}
        </Text>

        <Text variant="body" color="muted">
          {TATHYA_DESCRIPTION}
        </Text>
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="label" color="faint">
          Try asking
        </Text>
        {SUGGESTIONS.map((s) => (
          <Pressable
            key={s}
            onPress={() => onPickSuggestion(s)}
            accessibilityRole="button"
            accessibilityLabel={`Ask: ${s}`}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.md,
              paddingHorizontal: theme.spacing.lg,
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: pressed ? theme.colors.accentTint : 'transparent',
            })}
          >
            <Text variant="body" color="muted" style={{ flex: 1 }}>
              {s}
            </Text>
            <Glyph name="arrowRight" color={theme.colors.accent} size={14} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
