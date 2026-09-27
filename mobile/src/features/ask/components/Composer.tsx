import React, { useState } from 'react';
import { ActivityIndicator, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Line, Polygon } from 'react-native-svg';

import { Glyph, Text } from '../../../components';
import { MIN_TOUCH_SIZE, useTheme } from '../../../theme';

interface Props {
  onSend: (text: string) => void;
  sending: boolean;
  /** Text from a turn that failed, handed back so it isn't retyped. */
  restoreText?: string | null;
  onRestoreConsumed?: () => void;
  /** Opens VARTA. Mirrors `#btnVoiceMode`, the mic beside the web's send
   *  button, which is the primary way into voice mode there. */
  onVoice?: () => void;
}

/**
 * The message composer.
 *
 * Multiline and growing, rather than the web's single-line pill: a question
 * about money is often a sentence, and a phone line fits about six words. It
 * caps at roughly five lines so the conversation above stays visible, and sits
 * above the keyboard with the safe-area inset applied.
 *
 * Send is disabled while empty or in flight — the backend serialises a
 * conversation's turns and a second question mid-answer would arrive without
 * the first one's reply in its history.
 */
export function Composer({
  onSend,
  sending,
  restoreText,
  onRestoreConsumed,
  onVoice,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [height, setHeight] = useState(0);

  // Put a failed question back in the box so it can be edited and resent.
  React.useEffect(() => {
    if (restoreText) {
      setText(restoreText);
      onRestoreConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreText]);

  const canSend = text.trim().length > 0 && !sending;

  function submit() {
    if (!canSend) return;
    const value = text.trim();
    setText('');
    setHeight(0);
    onSend(value);
  }

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
        backgroundColor: theme.colors.bg,
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.md,
        paddingBottom: Math.max(insets.bottom, theme.spacing.md),
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: theme.spacing.sm,
          backgroundColor: theme.colors.surface2,
          borderRadius: theme.radius.xl,
          borderWidth: 1,
          borderColor: theme.colors.line,
          paddingLeft: theme.spacing.lg,
          paddingRight: theme.spacing.xs,
          paddingVertical: theme.spacing.xs,
        }}
      >
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Ask MoneyKal..."
          placeholderTextColor={theme.colors.inkFaint}
          selectionColor={theme.colors.accent}
          multiline
          editable={!sending}
          onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height)}
          style={{
            flex: 1,
            color: theme.colors.ink,
            ...theme.type.body,
            paddingTop: theme.spacing.sm,
            paddingBottom: theme.spacing.sm,
            // Grows with the text, then scrolls — about five lines.
            maxHeight: 120,
            minHeight: 24,
            height: Math.min(Math.max(height, 24), 120),
          }}
        />

        {/* VARTA. Sits to the left of send, the same order as the web's
            .gemini-input-actions row. Hidden while a typed question is in
            flight: the backend serialises a conversation's turns, so starting
            a spoken one mid-answer would send it without the previous reply in
            its history. */}
        {onVoice ? (
          <Pressable
            onPress={onVoice}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Ask with your voice"
            style={({ pressed }) => ({
              width: MIN_TOUCH_SIZE - 6,
              height: MIN_TOUCH_SIZE - 6,
              borderRadius: (MIN_TOUCH_SIZE - 6) / 2,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: sending ? 0.35 : pressed ? 0.6 : 1,
            })}
          >
            <Glyph name="mic" color={theme.colors.inkMuted} size={19} />
          </Pressable>
        ) : null}

        <Pressable
          onPress={submit}
          disabled={!canSend}
          accessibilityRole="button"
          accessibilityLabel="Send"
          accessibilityState={{ disabled: !canSend, busy: sending }}
          style={({ pressed }) => ({
            width: MIN_TOUCH_SIZE - 6,
            height: MIN_TOUCH_SIZE - 6,
            borderRadius: (MIN_TOUCH_SIZE - 6) / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: canSend ? theme.colors.btnBgSolid : 'transparent',
            opacity: pressed && canSend ? 0.8 : 1,
          })}
        >
          {sending ? (
            <ActivityIndicator size="small" color={theme.colors.accent} />
          ) : (
            /* The web's send glyph, from #view-ask's .btn-send-gemini. */
            <Svg width={17} height={17} viewBox="0 0 24 24" fill="none">
              <Line
                x1="22"
                y1="2"
                x2="11"
                y2="13"
                stroke={canSend ? theme.colors.onAccent : theme.colors.inkFaint}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <Polygon
                points="22 2 15 22 11 13 2 9 22 2"
                stroke={canSend ? theme.colors.onAccent : theme.colors.inkFaint}
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          )}
        </Pressable>
      </View>

      {/* The web carries this note under the composer verbatim. */}
      <Text variant="bodySmall" color="faint" style={{ marginTop: theme.spacing.sm }} center>
        Answers are generated from your MoneyKal profile data.
      </Text>
    </View>
  );
}
