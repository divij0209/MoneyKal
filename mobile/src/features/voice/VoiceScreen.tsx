import React, { useCallback } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Glyph, Text } from '../../components';
import { useT } from '../../i18n';
import type { AppStackParamList } from '../../navigation/types';
import { fontFamily } from '../../theme';
import { VoiceOrb } from './components/VoiceOrb';
import { useVarta, type VartaState } from './useVarta';

/**
 * VARTA — Speak. Ask. Understand.
 *
 * The mobile counterpart of `#voiceOverlay` in twin-app/dashboard.html: a
 * full-screen stage with an orb, a status line and one button that starts or
 * abandons a turn. Presented as a `fullScreenModal` over the tabs for the same
 * reason the web presents it as a fixed overlay over the app rather than as a
 * view — talking to VARTA is a mode, not a destination.
 *
 * WHAT THE REDESIGN DID NOT TOUCH: the orb, its animation, and every line of
 * `useVarta`. Recording, transcription, the turn loop, playback, cancellation
 * and error recovery are exactly as they were. This file changed only in what
 * sits *around* the orb — the wordmark, the type, the palette of the error
 * line and the affordance under the button.
 *
 * The ground stays a fixed near-black in both themes, matching the web
 * overlay's own `rgba(10,10,12,0.95)`, which is not theme-conditional either.
 * That is also what makes the brand cyan usable at full strength here.
 *
 * Two things here are deliberately *not* on the web, because a phone cannot
 * borrow what the browser gets for free. The desktop overlay covers a chat log
 * that is still visible around and behind it, so the web never needs to show
 * you what you said — closing the overlay reveals it. A full-screen modal on a
 * phone hides everything, so the question and the answer are shown here, and
 * failures are stated rather than left to a silent return to idle, which is
 * what voice.js does today.
 */

/* The stage's own palette. Fixed rather than themed, for the reason above.
   Off-white ink on near-black, with cyan as the only accent — the same three
   colours the rest of the app uses, in their dark arrangement. */
const STAGE = {
  ground: '#0a0a0c',
  ink: '#F4F2EE',
  inkMuted: 'rgba(244,242,238,0.55)',
  inkFaint: 'rgba(244,242,238,0.34)',
  line: 'rgba(244,242,238,0.12)',
  accent: '#00e5ff',
  /* The error line. Warm sand rather than red: the palette has three colours
     and red is not one of them, and on this ground sand is more legible than
     the #ef4444 that was here before. */
  warn: '#E8C79A',
} as const;

export function VoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const route = useRoute<RouteProp<AppStackParamList, 'Voice'>>();
  const t = useT();

  // Continue the conversation the Ask screen is showing, when VARTA was opened
  // from it. The id belongs to the backend; this screen only carries it.
  const varta = useVarta(route.params?.sessionId ?? null);

  const close = useCallback(() => {
    varta.shutdown();

    // Opened from Ask Twin: go back to that conversation and name it, so the
    // transcript on screen includes what was just spoken. The turns are read
    // from the backend, which already stored them — nothing is handed over
    // except the id. Opened from anywhere else, VARTA simply closes and the
    // conversation is waiting in Ask Twin's list.
    if (route.params?.returnTo === 'ask' && varta.sessionId) {
      navigation.navigate('Tabs', {
        screen: 'Ask',
        params: { sessionId: varta.sessionId },
      } as never);
      return;
    }
    navigation.goBack();
  }, [varta, navigation, route.params?.returnTo]);

  const busy = varta.state !== 'idle';
  const showsConversation = !!varta.transcript || !!varta.answer;

  /* The status line, translated. `useVarta` owns the state machine and
     exposes an English `statusLabel`; the four states map onto i18n keys here
     so the stage reads in Hindi without the hook knowing about language. */
  const STATUS_KEY: Record<VartaState, Parameters<typeof t>[0]> = {
    idle: 'varta.tapToSpeak',
    listening: 'varta.listening',
    processing: 'varta.thinking',
    speaking: 'varta.speaking',
  };
  const status = t(STATUS_KEY[varta.state]);

  return (
    <View style={{ flex: 1, backgroundColor: STAGE.ground }}>
      <StatusBar style="light" />
      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom', 'left', 'right']}>
        {/* Wordmark and close. The web overlay carries only the close control;
            on a phone the modal has no surrounding chrome to say where you
            are, so the name is stated. */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 20,
            paddingVertical: 14,
          }}
        >
          <View style={{ flex: 1, gap: 1 }}>
            <Text
              style={{
                fontFamily: fontFamily.displayBold,
                fontSize: 15,
                letterSpacing: 1.6,
                color: STAGE.ink,
              }}
            >
              VARTA
            </Text>
            <Text
              style={{
                fontFamily: fontFamily.body,
                fontSize: 11.5,
                letterSpacing: 0.2,
                color: STAGE.inkFaint,
              }}
            >
              {t('home.vartaTagline')}
            </Text>
          </View>

          <Pressable
            onPress={close}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.6 : 1 })}
          >
            <Glyph name="close" color={STAGE.inkMuted} size={22} strokeWidth={2} />
          </Pressable>
        </View>

        {/* Stage — `.voice-overlay__content`. */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 34 }}>
          <VoiceOrb state={varta.state} />

          {/* `.voice-status`: the one line that says what VARTA is doing. */}
          <Text
            accessibilityLiveRegion="polite"
            style={{
              fontFamily: fontFamily.displayRegular,
              fontSize: 21,
              lineHeight: 29,
              color: STAGE.ink,
              letterSpacing: 0.3,
              textAlign: 'center',
            }}
          >
            {status}
          </Text>

          {/* What was said and what came back. Capped in height so a long
              answer scrolls inside the stage instead of pushing the orb and
              the button off a small screen. */}
          {showsConversation || varta.error ? (
            <ScrollView
              style={{ maxHeight: 210, alignSelf: 'stretch' }}
              contentContainerStyle={{ paddingHorizontal: 30, gap: 16 }}
              showsVerticalScrollIndicator={false}
            >
              {varta.transcript ? (
                <View style={{ gap: 8, alignItems: 'center' }}>
                  <View style={{ width: 24, height: 1, backgroundColor: STAGE.line }} />
                  <Text
                    style={{
                      fontFamily: fontFamily.bodyMedium,
                      fontSize: 14.5,
                      lineHeight: 21,
                      color: STAGE.inkMuted,
                      textAlign: 'center',
                    }}
                  >
                    “{varta.transcript}”
                  </Text>
                </View>
              ) : null}

              {varta.answer ? (
                <Text
                  style={{
                    fontFamily: fontFamily.body,
                    fontSize: 16,
                    lineHeight: 25,
                    color: STAGE.ink,
                    textAlign: 'center',
                  }}
                >
                  {varta.answer}
                </Text>
              ) : null}

              {varta.error ? (
                <Text
                  style={{
                    fontFamily: fontFamily.bodyMedium,
                    fontSize: 13.5,
                    lineHeight: 20,
                    color: STAGE.warn,
                    textAlign: 'center',
                  }}
                >
                  {varta.error}
                </Text>
              ) : null}
            </ScrollView>
          ) : null}
        </View>

        {/* Controls — `.voice-overlay__controls`, a single 72px round button. */}
        <View style={{ alignItems: 'center', paddingBottom: 30, paddingTop: 8, gap: 14 }}>
          <Pressable
            onPress={varta.toggle}
            accessibilityRole="button"
            accessibilityLabel={busy ? t('varta.endSession') : t('varta.tapToSpeak')}
            accessibilityState={{ busy }}
            style={({ pressed }) => ({
              width: 72,
              height: 72,
              borderRadius: 36,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: busy ? 'rgba(0,229,255,0.12)' : 'rgba(244,242,238,0.05)',
              borderWidth: 1,
              borderColor: busy ? 'rgba(0,229,255,0.55)' : 'rgba(0,229,255,0.30)',
              transform: [{ scale: pressed ? 0.95 : 1 }],
            })}
          >
            <Glyph name={busy ? 'stop' : 'mic'} color={STAGE.accent} size={28} />
          </Pressable>

          <Text
            style={{
              fontFamily: fontFamily.bodyMedium,
              fontSize: 10.5,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: STAGE.inkFaint,
            }}
          >
            {busy ? t('varta.endSession') : t('varta.tapToSpeak')}
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}
