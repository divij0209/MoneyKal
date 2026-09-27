import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import {
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  useAudioPlayer,
  useAudioRecorder,
} from 'expo-audio';

import { ApiError, twinApi } from '../../api';
import { sessionQueryKey, sessionsQueryKey } from '../ask/hooks';
import {
  SPEECH_RECORDING,
  cleanTextForSpeech,
  enterPlaybackMode,
  enterRecordingMode,
  recordedFileDescriptor,
  releaseAnswerAudio,
  releaseAudioSession,
  writeAnswerAudio,
} from './audio';

/**
 * VARTA — the voice interface, and only the voice interface.
 *
 * The whole hook is one loop, and it is worth stating plainly because the
 * value of the feature depends on it staying this way:
 *
 *     speech -> text -> POST /twin/chat -> text -> speech
 *
 * The middle step is the ordinary Ask Twin call. Not a variant of it, not a
 * voice-flavoured prompt, not a shortcut that skips the agent pipeline — the
 * same `askTwin()` the text composer uses, hitting the same orchestrator with
 * the same grounding and writing to the same conversation. Everything else in
 * this file is microphones, speakers and error copy.
 *
 * This mirrors twin-app/js/voice.js, which reaches the same place from the
 * other side: the browser transcribes locally with the Web Speech API, then
 * calls the identical endpoint. A question asked out loud on a phone and one
 * asked out loud in a browser are the same question by the time anything
 * financial happens to it.
 */

export type VartaState = 'idle' | 'listening' | 'processing' | 'speaking';

/**
 * How long the web watchdog waits before calling playback a no-start.
 *
 * The answer is a blob URL already in memory, so there is no network fetch and
 * no meaningful buffering delay — 1.5s is far longer than a healthy start takes
 * and short enough that a blocked answer is not a long silent stare.
 */
const PLAYBACK_START_GRACE_MS = 1500;

/** The status line, verbatim from `setVoiceState` in twin-app/js/voice.js. */
export const STATUS_LABEL: Record<VartaState, string> = {
  idle: 'Tap to speak',
  listening: 'Listening...',
  processing: 'Thinking...',
  speaking: 'Speaking...',
};

export interface VartaController {
  state: VartaState;
  statusLabel: string;
  /** What the user said, once transcribed. Cleared when a new turn starts. */
  transcript: string | null;
  /** Tathya's reply, shown while it is spoken and after it finishes. */
  answer: string | null;
  error: string | null;
  /** The conversation these turns belong to — the backend's id, not a local one. */
  sessionId: string | null;
  /** The single action button. Starts a turn, or cancels whatever is running. */
  toggle: () => void;
  /** Leaving the screen: stop everything and hand audio focus back. */
  shutdown: () => void;
}

export function useVarta(initialSessionId?: string | null): VartaController {
  const qc = useQueryClient();

  const recorder = useAudioRecorder(SPEECH_RECORDING);
  const player = useAudioPlayer();

  const [state, setState] = useState<VartaState>('idle');
  const [transcript, setTranscript] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);

  /**
   * Cancellation without aborting the request.
   *
   * Every turn takes a ticket; anything that resolves holding a stale ticket
   * updates nothing. The HTTP call is deliberately left to finish rather than
   * aborted, because POST /twin/chat persists the question and the answer
   * before it responds — cancelling the render is a UI decision, and the
   * conversation on the server should still contain the turn that was asked.
   * The web behaves the same way, for the less deliberate reason that it never
   * had a way to abort its fetch either.
   */
  const runId = useRef(0);
  const audioUri = useRef<string | null>(null);
  /** Read inside callbacks that must not close over a stale `state`. */
  const stateRef = useRef<VartaState>('idle');
  /** Web only — see the watchdog at the end of the turn. */
  const playbackWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enter = useCallback((next: VartaState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /* ----------------------------------------------------------- playback -- */

  const clearPlaybackWatchdog = useCallback(() => {
    if (playbackWatchdog.current) {
      clearTimeout(playbackWatchdog.current);
      playbackWatchdog.current = null;
    }
  }, []);

  /**
   * The turn ends when the audio does — or when it fails.
   *
   * `didJustFinish` arrives once per source, which is why the player is reused
   * via replace() rather than recreated.
   *
   * The `error` branch matters more than it looks. expo-audio reports a failed
   * media element through this same status object, and until it was read here
   * a failure was completely invisible: no sound, no message, and the orb left
   * spinning on "Speaking..." until the user tapped it. Silence that says
   * nothing is worse than an error, because there is no way to tell it apart
   * from success. This applies on every platform — a decode failure on a phone
   * hung in exactly the same way.
   */
  useEffect(() => {
    const sub = player.addListener('playbackStatusUpdate', (status) => {
      if (stateRef.current !== 'speaking') return;

      if (status.error) {
        clearPlaybackWatchdog();
        // The player's own wording ("Playback error (code 4)") is a decoder
        // code, not something to show anyone; it is worth having in dev.
        if (__DEV__) {
          console.warn('[MoneyKal] VARTA playback failed:', status.error, {
            isLoaded: status.isLoaded,
            duration: status.duration,
            currentTime: status.currentTime,
          });
        }
        setError('The answer is above — VARTA could not play it aloud.');
        enter('idle');
        return;
      }

      if (status.didJustFinish) {
        clearPlaybackWatchdog();
        enter('idle');
      }
    });
    return () => sub.remove();
  }, [player, enter, clearPlaybackWatchdog]);

  const stopPlayback = useCallback(() => {
    try {
      player.pause();
    } catch {
      // Nothing loaded, or already released. Either way there is no sound.
    }
  }, [player]);

  /* -------------------------------------------------------------- cancel -- */

  const cancel = useCallback(() => {
    runId.current += 1;
    clearPlaybackWatchdog();
    stopPlayback();
    try {
      if (recorder.isRecording) {
        // stop() is async and we are not waiting for it: the ticket has already
        // been burned, so whatever it produces is ignored.
        void recorder.stop().catch(() => {});
      }
    } catch {
      // Already released. On unmount expo-audio frees the recorder in its own
      // effect cleanup, which React runs before this hook's — useAudioRecorder
      // is called above the unmount effect, and cleanups run in declaration
      // order. Touching a freed shared object then throws rather than
      // returning false, so `isRecording` itself is what raises here. A
      // released recorder is not recording, which is all this branch wanted
      // to know. Same reasoning as stopPlayback above.
    }
    enter('idle');
  }, [recorder, stopPlayback, enter, clearPlaybackWatchdog]);

  const shutdown = useCallback(() => {
    cancel();
    releaseAnswerAudio(audioUri.current);
    audioUri.current = null;
    void releaseAudioSession().catch(() => {});
  }, [cancel]);

  /* ---------------------------------------------------------- the turn --- */

  const runTurn = useCallback(async () => {
    const ticket = runId.current;
    const alive = () => runId.current === ticket;

    /* 1. Stop recording and collect the file. -------------------------- */
    let uri: string | null = null;
    try {
      await recorder.stop();
      uri = recorder.uri;
    } catch {
      if (alive()) {
        setError('Could not finish the recording. Please try again.');
        enter('idle');
      }
      return;
    }
    if (!alive()) return;

    if (!uri) {
      setError("I didn't catch that. Tap the mic and try again.");
      enter('idle');
      return;
    }

    enter('processing');

    /* 2. Speech -> text. ----------------------------------------------- */
    let said: string;
    try {
      const result = await twinApi.transcribeSpeech(recordedFileDescriptor(uri));
      said = result.text.trim();
    } catch (err) {
      if (!alive()) return;
      // The backend's own wording is used as-is: it distinguishes "voice input
      // is not available" (no key configured) from "could not understand that
      // recording", and those need different reactions from the user.
      setError(
        err instanceof ApiError
          ? err.detail
          : 'Could not send that recording. Check your connection and try again.',
      );
      enter('idle');
      return;
    }
    if (!alive()) return;

    // An empty transcript is a 200, not a failure — the mic was tapped and
    // nothing was said, or the room was too loud.
    if (!said) {
      setError("I didn't catch that. Tap the mic and try again.");
      enter('idle');
      return;
    }

    setTranscript(said);

    /* 3. Text -> Tathya. The only step that knows anything about money. -- */
    let spokenAnswer: string;
    try {
      const res = await twinApi.askTwin(said, sessionId);
      if (!alive()) return;
      if (res.session_id) setSessionId(res.session_id);
      spokenAnswer = res.answer;
      setAnswer(res.answer);

      // The turn is now a row in chat_messages. Drop the cached copies so Ask
      // Twin — here or on the website — reads it back from the server rather
      // than showing a conversation that is missing what was just said.
      void qc.invalidateQueries({ queryKey: sessionsQueryKey });
      if (res.session_id) {
        void qc.invalidateQueries({ queryKey: sessionQueryKey(res.session_id) });
      }
    } catch (err) {
      if (!alive()) return;
      setError(
        err instanceof ApiError
          ? err.isNetworkError || err.isAuthError
            ? err.detail
            : err.detail
          : 'TATHYA could not answer just now. Try again.',
      );
      enter('idle');
      return;
    }

    /* 4. Text -> speech. ------------------------------------------------ */
    enter('speaking');
    try {
      const bytes = await twinApi.fetchAnswerSpeech(cleanTextForSpeech(spokenAnswer));
      if (!alive()) return;

      releaseAnswerAudio(audioUri.current);
      const uriToPlay = writeAnswerAudio(bytes);
      audioUri.current = uriToPlay;

      // Clear the recording route before any sound comes out. See
      // enterPlaybackMode() — on iOS this is the difference between an audible
      // answer and one that only plays through the earpiece.
      await enterPlaybackMode();
      if (!alive()) return;

      player.replace(uriToPlay);
      player.play();

      /* Web only: confirm playback actually started.
         -------------------------------------------------------------------
         On web, `play()` calls HTMLMediaElement.play() and throws the returned
         promise away (expo-audio's AudioPlayer.web.js), so a rejection —
         NotAllowedError from an autoplay block being the usual one — reaches
         nobody. It also sets its own `playing` flag to true regardless, so the
         player's own state cannot be trusted to answer "did sound come out".
         The media element can: `paused` and `currentTime` are read straight
         off the DOM node.

         So after a grace period, if the element never left the starting line,
         say so instead of leaving the orb spinning. This runs on web alone —
         native reports failures through the status listener above, and adding
         a timer there would risk calling a slow-but-fine buffer a failure. */
      if (Platform.OS === 'web') {
        clearPlaybackWatchdog();
        playbackWatchdog.current = setTimeout(() => {
          playbackWatchdog.current = null;
          if (!alive() || stateRef.current !== 'speaking') return;
          // Both conditions, deliberately: still buffering shows paused=false,
          // and only a genuine no-start leaves the head at zero as well.
          if (player.paused && player.currentTime === 0) {
            if (__DEV__) {
              console.warn('[MoneyKal] VARTA playback never started.', {
                paused: player.paused,
                currentTime: player.currentTime,
                duration: player.duration,
                isLoaded: player.isLoaded,
                isBuffering: player.isBuffering,
                uri: uriToPlay.slice(0, 48),
              });
            }
            setError('The answer is above — your browser did not play it aloud.');
            enter('idle');
          }
        }, PLAYBACK_START_GRACE_MS);
      }
    } catch (err) {
      if (!alive()) return;
      // The answer itself arrived and is on screen; only the voice failed. Say
      // exactly that, rather than implying the question went unanswered.
      setError(
        err instanceof ApiError && err.isNetworkError
          ? 'The answer is above — it could not be played aloud.'
          : 'The answer is above — VARTA could not speak it just now.',
      );
      enter('idle');
    }
  }, [recorder, player, sessionId, qc, enter, clearPlaybackWatchdog]);

  /* --------------------------------------------------------- the button -- */

  const startListening = useCallback(async () => {
    setError(null);
    setTranscript(null);
    setAnswer(null);

    /* Permission. Checked before requesting so a user who has already said no
       is not silently no-oped: on both platforms a second request after a
       denial returns immediately without showing anything. */
    try {
      let granted = (await getRecordingPermissionsAsync()).granted;
      if (!granted) granted = (await requestRecordingPermissionsAsync()).granted;
      if (!granted) {
        setError(
          'MoneyKal needs microphone access to hear you. You can allow it in your device settings.',
        );
        return;
      }
    } catch {
      setError('Microphone access could not be checked on this device.');
      return;
    }

    try {
      await enterRecordingMode();
      // Required on every turn, not just the first: a recorder is invalid
      // after stop() and has to be prepared again before it can record.
      await recorder.prepareToRecordAsync();
      recorder.record();
      enter('listening');
    } catch {
      setError('The microphone could not be started. Please try again.');
      enter('idle');
    }
  }, [recorder, enter]);

  /**
   * One button, two meanings — the same contract as `toggleMic()` in
   * twin-app/js/voice.js. Idle starts a turn; anything else abandons the turn
   * in progress and returns to idle. There is no separate cancel affordance on
   * either client.
   */
  const toggle = useCallback(() => {
    const current = stateRef.current;
    if (current === 'idle') {
      void startListening();
      return;
    }
    if (current === 'listening') {
      setError(null);
      void runTurn();
      return;
    }
    // processing / speaking
    cancel();
  }, [startListening, runTurn, cancel]);

  /* Leaving the screen by any route — back gesture, close button, unmount —
     must not leave the mic hot or the session held. */
  useEffect(() => {
    return () => {
      shutdown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    state,
    statusLabel: STATUS_LABEL[state],
    transcript,
    answer,
    error,
    sessionId,
    toggle,
    shutdown,
  };
}
