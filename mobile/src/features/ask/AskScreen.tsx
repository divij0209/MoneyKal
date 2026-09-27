import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Button, Divider, Glyph, Text } from '../../components';
import type { SimulationCTA } from '../../api/types';
import type { AppStackParamList, IndividualTabParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { Composer } from './components/Composer';
import { MessageBubble } from './components/MessageBubble';
import { SessionsSheet } from './components/SessionsSheet';
import { WelcomeState } from './components/WelcomeState';
import { useConversation, useSessionMutations, useSessions } from './hooks';

/**
 * Ask Twin / TATHYA.
 *
 * Every answer comes from POST /twin/chat — the same endpoint, the same
 * orchestrator and the same grounding the website uses. The app sends a
 * question and renders what comes back; it computes nothing about the user's
 * money and holds no financial facts of its own.
 *
 * Conversations are the backend's: they are stored against the profile, so the
 * list here and the list on the website are the same list for the same
 * account, and a conversation started on either can be continued on the other.
 *
 * The screen owns its own frame rather than using <Screen> — a conversation
 * needs the composer pinned to the keyboard and the transcript scrolling
 * independently above it, which a single page scroll can't do.
 */
export function AskScreen() {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const route = useRoute<RouteProp<IndividualTabParamList, 'Ask'>>();

  const conversation = useConversation();
  const sessionsQuery = useSessions();
  const sessionMutations = useSessionMutations();

  const [sheetOpen, setSheetOpen] = useState(false);
  const [restoreText, setRestoreText] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Fixed per conversation so the greeting doesn't reshuffle on every render.
  const greetingSeed = useMemo(
    () => Math.floor(Math.random() * 6),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conversation.sessionId === null],
  );

  const isEmpty = conversation.messages.length === 0;

  /* Returning from VARTA. The spoken turns are already rows in chat_messages —
     the backend wrote them before answering — so the conversation is reloaded
     from the server rather than reconstructed here. That is also what makes a
     question asked on the phone show up in the same thread on the website. */
  const voiceSessionId = route.params?.sessionId;
  const openedVoiceSession = useRef<string | null>(null);
  useEffect(() => {
    if (!voiceSessionId) return;
    if (openedVoiceSession.current === voiceSessionId) return;
    openedVoiceSession.current = voiceSessionId;
    void conversation.openSession(voiceSessionId);
    // `conversation` is stable enough for this; keying on the id is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceSessionId]);

  const openVarta = useCallback(() => {
    navigation.navigate('Voice', {
      sessionId: conversation.sessionId ?? undefined,
      returnTo: 'ask',
    });
  }, [navigation, conversation.sessionId]);

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    if (conversation.messages.length) {
      const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
      return () => clearTimeout(t);
    }
  }, [conversation.messages.length, conversation.sending]);

  const handleSimulate = useCallback(
    (cta: SimulationCTA) => {
      /* The chat -> Simulation hand-off.
         Everything the conversation established travels with the scenario, so
         Simulate opens with the decision already filled in rather than asking
         the user to describe it again. The scenario sentence is the backend's
         restatement of what was discovered, not the raw question.
         Params are cleared on read in SimulateScreen — the same one-shot
         behaviour as the web's `pendingScenarioPrefill`. */
      navigation.navigate('Tabs', {
        screen: 'Simulate',
        params: {
          scenario: cta.scenario,
          decisionContext: cta.decision_context,
          ctaLabel: cta.label,
        },
      } as never);
    },
    [navigation],
  );

  const handleRetry = useCallback(() => {
    void conversation.retry();
  }, [conversation]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={{ flex: 1, backgroundColor: theme.colors.bg }}
    >
      <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />

      {/* Conversation controls. Deliberately light: the header above already
          says "Ask Twin", so this row carries only the two things a
          conversation needs — where the saved ones are, and how to start
          another. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.sm,
        }}
      >
        <Pressable
          onPress={() => setSheetOpen(true)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Saved conversations"
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Glyph name="calendar" color={theme.colors.inkMuted} size={15} />
          <Text variant="bodySmall" color="muted">
            Conversations
          </Text>
        </Pressable>

        {!isEmpty ? (
          <Pressable
            onPress={conversation.startNew}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Start a new conversation"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Glyph name="plus" color={theme.colors.accent} size={13} />
            <Text variant="bodySmall" color="accent">
              New
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Divider />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xl,
            gap: theme.spacing.xl,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          {conversation.loadingSession ? (
            <View style={{ flex: 1, justifyContent: 'center', gap: theme.spacing.md }}>
              <Text variant="bodySmall" color="faint" center>
                Opening conversation…
              </Text>
            </View>
          ) : isEmpty ? (
            <WelcomeState seed={greetingSeed} onPickSuggestion={(t) => void conversation.ask(t)} />
          ) : (
            conversation.messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                // The backend decides whether a CTA exists at all; the screen
                // only supplies the handler for acting on one.
                onSimulate={handleSimulate}
                onAnswer={(t) => void conversation.ask(t)}
              />
            ))
          )}

          {conversation.sendError ? (
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
                {conversation.sendError}
              </Text>
              {conversation.canRetry ? (
                <Button
                  label="Try again"
                  variant="outline"
                  size="sm"
                  fullWidth={false}
                  onPress={handleRetry}
                />
              ) : null}
            </View>
          ) : null}
        </ScrollView>

        <Composer
          onSend={(t) => void conversation.ask(t)}
          sending={conversation.sending}
          restoreText={restoreText}
          onRestoreConsumed={() => setRestoreText(null)}
          onVoice={openVarta}
        />
      </KeyboardAvoidingView>

      <SessionsSheet
        visible={sheetOpen}
        sessions={sessionsQuery.data ?? []}
        loading={sessionsQuery.isLoading}
        activeId={conversation.sessionId}
        onClose={() => setSheetOpen(false)}
        onOpen={(id) => void conversation.openSession(id)}
        onNew={conversation.startNew}
        onRename={async (id, title) => {
          await sessionMutations.rename.mutateAsync({ id, title });
        }}
        onDelete={async (id) => {
          await sessionMutations.remove.mutateAsync(id);
          // Deleting the conversation on screen leaves nothing to show.
          if (conversation.sessionId === id) conversation.startNew();
        }}
      />
    </SafeAreaView>
  );
}
