import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';

import { ApiError, onboardingApi } from '../../../api';
import type {
  ExtractedFinancials,
  OnboardingChatMessage,
} from '../../../api/endpoints/onboarding';
import { Button, Input, Sheet, Text } from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called once the model has emitted ONBOARDING_COMPLETE with figures. */
  onExtracted: (data: ExtractedFinancials) => void;
}

const OPENER =
  "Hi! I'll ask a few quick questions to set up your financial twin. Ready when you are — tell me roughly what you earn each month.";

/**
 * Conversational onboarding, over POST /onboard/chat.
 *
 * The backend owns the conversation: its system prompt decides what to ask,
 * when it has enough, and emits `ONBOARDING_COMPLETE` followed by a JSON block.
 * This screen sends the transcript and renders replies — it never decides that
 * the conversation is finished on its own.
 *
 * The extracted figures land in the form for review; they are never submitted
 * from here. /onboard/confirm stays the one call that creates a profile.
 */
export function AiChatSheet({ visible, onClose, onExtracted }: Props) {
  const theme = useTheme();

  const [messages, setMessages] = useState<OnboardingChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (!visible) return;
    setMessages([]);
    setDraft('');
    setBusy(false);
    setError(null);
    setDone(false);
  }, [visible]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;

    const next: OnboardingChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setDraft('');
    setBusy(true);
    setError(null);

    try {
      const res = await onboardingApi.onboardingChat(next);
      const { text: replyText, financials } = onboardingApi.parseChatCompletion(res.reply || '');

      setMessages([
        ...next,
        {
          role: 'assistant',
          content: replyText || "Thanks — I've got what I need.",
        },
      ]);

      if (financials) {
        setDone(true);
        onExtracted(financials);
      }
    } catch (err) {
      setError(
        err instanceof ApiError ? err.detail : 'Could not reach the assistant. Try again.',
      );
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Onboarding chat failed for a non-API reason:', err);
      }
      // Drop the unanswered message so retrying doesn't duplicate it.
      setMessages(messages);
      setDraft(text);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, messages, onExtracted]);

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Set up with MoneyKal"
      subtitle="A few short questions. Nothing is saved until you review it."
      error={error}
      footer={
        done ? (
          <Button label="Review my details" onPress={onClose} />
        ) : (
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'flex-end' }}>
            <Input
              placeholder="Type your answer…"
              value={draft}
              onChangeText={setDraft}
              editable={!busy}
              onSubmitEditing={send}
              returnKeyType="send"
              containerStyle={{ flex: 1 }}
            />
            <Button
              label="Send"
              onPress={send}
              loading={busy}
              disabled={busy || !draft.trim()}
              fullWidth={false}
              size="sm"
              style={{ paddingHorizontal: theme.spacing.lg }}
            />
          </View>
        )
      }
    >
      <ScrollView
        ref={scrollRef}
        style={{ maxHeight: 340 }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        showsVerticalScrollIndicator={false}
      >
        <View style={{ gap: theme.spacing.md }}>
          <Bubble role="assistant" content={OPENER} />

          {messages.map((m, i) => (
            <Bubble key={i} role={m.role} content={m.content} />
          ))}

          {busy ? (
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, alignItems: 'center' }}>
              <ActivityIndicator size="small" color={theme.colors.accent} />
              <Text variant="bodySmall" color="faint">
                Thinking…
              </Text>
            </View>
          ) : null}

          {done ? (
            <View
              style={{
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.accentTint,
              }}
            >
              <Text variant="bodySmall" color="accent">
                Your figures are in the form — check them over and adjust anything that
                looks off before saving.
              </Text>
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Sheet>
  );
}

function Bubble({ role, content }: { role: string; content: string }) {
  const theme = useTheme();
  const mine = role === 'user';

  return (
    <View
      style={{
        alignSelf: mine ? 'flex-end' : 'flex-start',
        maxWidth: '88%',
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        borderRadius: theme.radius.lg,
        backgroundColor: mine ? theme.colors.accentTint : theme.colors.surface2,
        borderWidth: mine ? 0 : 1,
        borderColor: theme.colors.line,
      }}
    >
      <Text variant="bodySmall" color={mine ? 'accent' : 'ink'}>
        {content}
      </Text>
    </View>
  );
}
