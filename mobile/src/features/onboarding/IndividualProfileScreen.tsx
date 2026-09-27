import React, { useCallback, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import type { ExtractedFinancials } from '../../api/endpoints/onboarding';
import { Button, LoadingState, StepProgress, Text } from '../../components';
import { useTheme } from '../../theme';
import { AiChatSheet } from './individual/AiChatSheet';
import { AssistSheet } from './individual/AssistSheet';
import { StepAboutYou, StepYourGoal, StepYourMoney } from './individual/Steps';
import { STEP_COUNT, useIndividualOnboarding } from './individual/useIndividualOnboarding';

/**
 * Individual onboarding.
 *
 * The web puts all twelve fields on one page (#step3-individual). On a phone
 * that is a very long scroll with no sense of progress, so the same fields are
 * split into three steps that group by what they are about: who you are, where
 * you stand, and what you are working towards. Nothing is added or removed —
 * the payload posted to /onboard/confirm carries exactly the fields the web
 * sends, with the same defaults.
 *
 * Every answer lives in one object in `useIndividualOnboarding`, so stepping
 * back never loses input, and it is mirrored into the SecureStore draft so
 * closing the app doesn't either.
 */
export function IndividualProfileScreen() {
  const theme = useTheme();
  const form = useIndividualOnboarding();

  const [assistOpen, setAssistOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const isFirst = form.step === 0;
  const isLast = form.step === STEP_COUNT - 1;

  // Android's hardware back should step back through the wizard rather than
  // leaving onboarding, which the user cannot exit to anywhere useful anyway.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (form.step > 0) {
          form.goBack();
          return true;
        }
        return false;
      });
      return () => sub.remove();
    }, [form]),
  );

  const handleExtracted = useCallback(
    (data: ExtractedFinancials) => {
      form.applyExtracted(data);
      // Land the user on the money step so they can see what was filled in
      // before it is saved — the figures are a suggestion until they submit.
      form.setStep(1);
    },
    [form],
  );

  if (!form.hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
        <LoadingState label="Loading your details…" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xxxl,
            gap: theme.spacing.xxl,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <StepProgress current={form.step} total={STEP_COUNT} label={form.stepLabel} />

          {form.step === 0 ? (
            <StepAboutYou
              values={form.values}
              errors={form.errors}
              setField={form.setField}
              disabled={form.submitting}
              onOpenAssist={() => setAssistOpen(true)}
            />
          ) : form.step === 1 ? (
            <StepYourMoney
              values={form.values}
              errors={form.errors}
              setField={form.setField}
              disabled={form.submitting}
            />
          ) : (
            <StepYourGoal
              values={form.values}
              errors={form.errors}
              setField={form.setField}
              disabled={form.submitting}
            />
          )}

          {form.submitError ? (
            <View
              style={{
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.warnTint,
                borderWidth: 1,
                borderColor: theme.colors.warn,
              }}
            >
              <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
                {form.submitError}
              </Text>
            </View>
          ) : null}
        </ScrollView>

        {/* Actions pinned below the scroll so the primary one stays reachable
            with the keyboard up. */}
        <View
          style={{
            flexDirection: 'row',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.xl,
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.xl,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            backgroundColor: theme.colors.bg,
          }}
        >
          {!isFirst ? (
            <Button
              label="Back"
              variant="outline"
              onPress={form.goBack}
              disabled={form.submitting}
              fullWidth={false}
              style={{ flex: 1 }}
            />
          ) : null}

          <Button
            label={isLast ? 'Initialize Twin' : 'Continue'}
            onPress={isLast ? () => void form.submit() : form.goNext}
            loading={form.submitting}
            disabled={form.submitting}
            fullWidth={false}
            style={{ flex: isFirst ? 1 : 1.4 }}
          />
        </View>
      </KeyboardAvoidingView>

      <AssistSheet
        visible={assistOpen}
        onClose={() => setAssistOpen(false)}
        onOpenChat={() => {
          setAssistOpen(false);
          setChatOpen(true);
        }}
        onExtracted={handleExtracted}
      />

      <AiChatSheet
        visible={chatOpen}
        onClose={() => setChatOpen(false)}
        onExtracted={handleExtracted}
      />
    </View>
  );
}
