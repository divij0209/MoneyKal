import { Platform } from 'react-native';

import { api, request, requestBlob } from '../client';
import type {
  ChatResponse,
  ChatSessionDetail,
  ChatSessionSummary,
  DecisionContext,
  GenericResponse,
  ScenarioSimulateResponse,
  SimulationRunDetail,
  SimulationRunSummary,
  TranscriptionResponse,
} from '../types';

/**
 * Ask Twin / TATHYA — backend/routers/twin.py.
 *
 * Conversations are persisted server-side against the profile, so the same
 * account sees the same history from the website and from the phone. Nothing
 * about a conversation is stored only on the device.
 *
 * The orchestrator is chosen by the backend from `profile.key` — an Individual
 * gets agents/orchestrator.py, a founder gets startup_orchestrator.py. The
 * client never selects one, and never answers anything itself.
 */

/**
 * POST /twin/chat.
 *
 * Omit `session_id` to start a conversation; the response carries the id the
 * backend assigned, which subsequent turns pass back. The server appends both
 * the user message and the reply to that session before responding, so the
 * transcript is durable the moment this resolves.
 */
export function askTwin(message: string, sessionId?: string | null): Promise<ChatResponse> {
  return api.post<ChatResponse>(
    '/twin/chat',
    { message, session_id: sessionId ?? null },
    // The pipeline grounds the query, fetches live market data and runs the
    // Explainer agent — comfortably past the default request budget.
    { slow: true },
  );
}

/** GET /twin/chats — every session for this profile, newest first. */
export function listSessions(): Promise<ChatSessionSummary[]> {
  return api.get<ChatSessionSummary[]>('/twin/chats');
}

/** GET /twin/chats/{id} — the full transcript. Roles are 'user' | 'twin'. */
export function getSession(sessionId: string): Promise<ChatSessionDetail> {
  return api.get<ChatSessionDetail>(`/twin/chats/${sessionId}`);
}

export function renameSession(sessionId: string, title: string): Promise<GenericResponse> {
  return api.put<GenericResponse>(`/twin/chats/${sessionId}`, { title });
}

export function deleteSession(sessionId: string): Promise<GenericResponse> {
  return api.delete<GenericResponse>(`/twin/chats/${sessionId}`);
}

/* ------------------------------------------------------------------ VARTA --
   Voice is a transport, not a second brain. These two calls turn speech into
   a string and a string back into speech; everything between them is the
   ordinary askTwin() above, so a spoken question is answered by exactly the
   same orchestrator, grounded on the same data and persisted to the same
   conversation as a typed one. */

/**
 * POST /twin/stt — a recording in, a transcript out.
 *
 * The website does not call this: a browser has the Web Speech API and
 * transcribes locally (twin-app/js/voice.js). React Native has no equivalent,
 * so the phone posts the audio and the backend transcribes it with the Groq
 * client it already uses for Tathya. Same destination, different road.
 *
 * `file.uri` comes straight from the recorder. On native that is a file://
 * path and React Native's FormData understands the {uri,name,type} shape —
 * the same upload the receipt scanner uses. On web it is a blob: URL, which
 * has to be read back into an actual Blob first, because web FormData would
 * otherwise serialise the object as "[object Object]".
 */
export async function transcribeSpeech(file: {
  uri: string;
  name: string;
  mimeType: string;
}): Promise<TranscriptionResponse> {
  const form = new FormData();

  if (Platform.OS === 'web') {
    const blob = await (await fetch(file.uri)).blob();
    form.append('file', blob, file.name);
  } else {
    form.append('file', {
      uri: file.uri,
      name: file.name,
      type: file.mimeType,
    } as unknown as Blob);
  }

  return request<TranscriptionResponse>('/twin/stt', {
    method: 'POST',
    formData: form,
    // Whisper on Groq is fast, but the upload is the slow half on a phone
    // network and this budget covers both.
    slow: true,
  });
}

/**
 * POST /twin/tts — the answer, spoken.
 *
 * Returns raw MP3 bytes rather than a URL, and that is forced by the design
 * rather than chosen: the route requires a bearer token, so the audio cannot
 * be handed to a player as a plain https:// source. The caller writes these
 * bytes somewhere the player can reach. See features/voice/audio.ts.
 *
 * The text sent here is the answer Tathya already produced. Nothing is
 * rewritten for speech beyond stripping markdown punctuation, which is what
 * the web does too (cleanTextForSpeech in voice.js).
 */
export async function fetchAnswerSpeech(text: string): Promise<Uint8Array> {
  const res = await requestBlob('/twin/tts', {
    method: 'POST',
    body: { text },
    slow: true,
  });
  return new Uint8Array(await res.arrayBuffer());
}

/* --------------------------------------------------------------- Simulate --
   POST /twin/simulate-scenario. Lives here rather than in a file of its own
   because this module is organised by backend router, and the route belongs to
   backend/routers/twin.py alongside the two above. */

/**
 * Run a what-if scenario against the twin.
 *
 * The entire pipeline is the backend's: Understand, Watch, Simulate and Check
 * are deterministic Python in services/financial_simulator.py, and only
 * Recommend and Teach reach an LLM — and only to phrase language around
 * numbers that were already computed. The client sends a sentence and renders
 * what comes back. It calculates nothing.
 *
 * Two shapes come out of this one endpoint, distinguished by `mode`:
 *
 *   - `scenario`      — a hypothetical was found and projected. Impact,
 *                       timeline, recommendation, risks, assumptions, teaching.
 *   - `informational` — the question was about the position as it stands, so
 *                       the backend answered it through the ordinary Ask Twin
 *                       orchestrator instead. `recommendation` carries that
 *                       answer as markdown; timeline, risks, assumptions and
 *                       teaching come back empty.
 *
 * No profile header is sent. The web's `simulateScenario()` declares a second
 * parameter and never forwards it (twin-app/js/api.js), so the persona is
 * resolved server-side from the account — matching that exactly.
 */
export function simulateScenario(
  scenario: string,
  /**
   * The chat hand-off. When Ask Twin's contextual CTA is tapped, everything the
   * conversation established (amount, purpose, horizon, stated risk
   * constraints, the computed risk position) travels with it, so Simulation
   * uses those facts instead of re-parsing the sentence — and the user is never
   * asked again for something they already answered.
   *
   * Forwarded verbatim; this client neither builds nor edits it. A scenario
   * typed straight into the Simulate box sends neither argument and takes the
   * original server path unchanged.
   */
  decisionContext?: DecisionContext | null,
  /** Falls back to whatever that conversation last discovered, which is what
   *  keeps a CTA working after an app restart. */
  sessionId?: string | null,
): Promise<ScenarioSimulateResponse> {
  return api.post<ScenarioSimulateResponse>(
    '/twin/simulate-scenario',
    {
      scenario,
      decision_context: decisionContext ?? null,
      session_id: sessionId ?? null,
    },
    // Six stages, two of them LLM calls, on top of the same grounding Ask Twin
    // does. Comfortably past the default budget.
    { slow: true },
  );
}

/* ------------------------------------------------- Simulation history --
   The backend keeps every completed run against the profile, so the Simulate
   tab opens with what this account has already explored — from either client —
   and any of those runs can be reopened in full. */

/** GET /twin/simulations — this profile's runs, newest first. */
export function listSimulations(limit = 50): Promise<SimulationRunSummary[]> {
  return api.get<SimulationRunSummary[]>(`/twin/simulations?limit=${limit}`);
}

/**
 * GET /twin/simulations/{id} — a stored run, reopened.
 *
 * Returns the response the pipeline produced when it ran, not a fresh
 * simulation. That is the point: reopening a decision should show the numbers
 * it was made on, not quietly re-project it against today's data.
 */
export function getSimulation(runId: string): Promise<SimulationRunDetail> {
  return api.get<SimulationRunDetail>(`/twin/simulations/${runId}`);
}

/** DELETE /twin/simulations/{id}. */
export function deleteSimulation(runId: string): Promise<GenericResponse> {
  return api.delete<GenericResponse>(`/twin/simulations/${runId}`);
}
