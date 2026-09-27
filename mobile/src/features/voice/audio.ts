import { Platform } from 'react-native';
import { AudioQuality, RecordingPresets, setAudioModeAsync } from 'expo-audio';
import type { RecordingOptions } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

/**
 * VARTA's audio plumbing: how the phone records, and how it plays an answer
 * back. Nothing here knows what a question means — that is Tathya's job, over
 * on POST /twin/chat.
 *
 * The reason this is a separate module from the state machine in useVarta.ts
 * is that almost everything below is a platform quirk rather than product
 * behaviour, and quirks are easier to justify when they are gathered in one
 * place with the reason attached.
 */

/* ------------------------------------------------------------- recording -- */

/**
 * Recording settings tuned for one spoken sentence.
 *
 * `RecordingPresets.HIGH_QUALITY` is 44.1kHz stereo at 128kbps, which is the
 * right default for music and the wrong one here. Whisper resamples everything
 * to 16kHz mono before it looks at it, so the extra data is discarded on the
 * server after the phone has already paid to upload it. Recording at the rate
 * the model actually uses makes the file roughly eight times smaller with no
 * loss of accuracy, and upload is the slowest part of the turn on a mobile
 * connection.
 *
 * `voice_recognition` on Android asks the platform for the capture path used
 * by speech recognisers: noise suppression and AGC on, no music tuning.
 */
export const SPEECH_RECORDING: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
    audioSource: 'voice_recognition',
  },
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    // MAX on a 16kHz mono voice recording buys nothing but CPU.
    audioQuality: AudioQuality.HIGH,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 32000,
  },
};

/**
 * What the recorder produces, per platform.
 *
 * Groq picks its decoder from the filename extension, so this has to match the
 * bytes. Native writes AAC in an MP4 container (.m4a); the web MediaRecorder
 * writes WebM. Both are formats the transcription endpoint accepts.
 */
export function recordedFileDescriptor(uri: string): {
  uri: string;
  name: string;
  mimeType: string;
} {
  return Platform.OS === 'web'
    ? { uri, name: 'speech.webm', mimeType: 'audio/webm' }
    : { uri, name: 'speech.m4a', mimeType: 'audio/m4a' };
}

/* -------------------------------------------------------- audio sessions -- */

/**
 * Put the session into recording mode.
 *
 * `doNotMix` takes exclusive audio focus, which is what a voice assistant
 * wants: whatever was playing pauses instead of bleeding into the microphone,
 * and on Android it is what causes focus to be handed back cleanly afterwards.
 */
export async function enterRecordingMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
    interruptionMode: 'doNotMix',
  });
}

/**
 * Put the session back into playback mode. **This must run before the answer
 * plays, on every turn.**
 *
 * iOS keeps the session in `PlayAndRecord` while `allowsRecording` is true,
 * and that category routes output to the *earpiece* — the tiny speaker you
 * hold to your ear on a call — rather than the loudspeaker. The symptom is not
 * silence, which would be noticed immediately; it is an answer that plays
 * correctly but almost inaudibly unless the phone is against your head. So the
 * flag is cleared here even though nothing is recording any more.
 *
 * `playsInSilentMode` stays true so an answer is still spoken with the ring/
 * silent switch flipped, which is where a lot of phones live.
 */
export async function enterPlaybackMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: 'doNotMix',
  });
}

/**
 * Release exclusive audio focus when VARTA closes, so whatever the user was
 * listening to before can resume.
 */
export async function releaseAudioSession(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
    interruptionMode: 'mixWithOthers',
  });
}

/* -------------------------------------------------------------- playback -- */

/**
 * Strip markdown so it is not read aloud.
 *
 * Character-for-character the same transformation as `cleanTextForSpeech` in
 * twin-app/js/voice.js, deliberately: the two clients should send identical
 * text to identical TTS and get identical audio. Tathya writes answers with
 * the occasional bolded figure, and without this the voice says "star star" —
 * or, worse, spells out a whole markdown link.
 */
export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/[*#_`]/g, '')
    .replace(/\[.*?\]\(.*?\)/g, '')
    .trim();
}

/**
 * Where the answer audio lands so a player can reach it.
 *
 * POST /twin/tts requires a bearer token, so the MP3 cannot simply be handed
 * to the player as an https:// source — the player does not send headers. The
 * bytes are fetched by the API client, which does, and then parked somewhere
 * addressable: a cache file on native, an object URL on web.
 *
 * The same path is reused every turn and overwritten, so a long conversation
 * leaves one file behind rather than one per answer.
 */
const ANSWER_FILENAME = 'varta-answer.mp3';

export function writeAnswerAudio(bytes: Uint8Array): string {
  if (Platform.OS === 'web') {
    // Uint8Array -> ArrayBuffer keeps TypeScript's BlobPart happy across the
    // ArrayBufferLike widening in TS 6.
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'audio/mpeg' });
    return URL.createObjectURL(blob);
  }

  const file = new File(Paths.cache, ANSWER_FILENAME);
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return file.uri;
}

/**
 * Undo whatever `writeAnswerAudio` allocated.
 *
 * Only meaningful on web, where an object URL pins its blob in memory until
 * it is revoked. The native cache file is intentionally left in place: it is
 * overwritten next turn, and deleting it while the player still holds it open
 * is how you get a crash on Android.
 */
export function releaseAnswerAudio(uri: string | null): void {
  if (!uri) return;
  if (Platform.OS === 'web' && uri.startsWith('blob:')) URL.revokeObjectURL(uri);
}
