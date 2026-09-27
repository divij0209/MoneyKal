import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, twinApi } from '../../api';
import type {
  ChatMode,
  ChatResponse,
  FollowUpQuestion,
  SimulationCTA,
} from '../../api/types';

export const sessionsQueryKey = ['twin', 'chats'] as const;
export const sessionQueryKey = (id: string) => ['twin', 'chats', id] as const;

/** The saved conversations for this profile. Server-side, so the list is the
 *  same one the website shows for the same account. */
export function useSessions(enabled = true) {
  return useQuery({
    queryKey: sessionsQueryKey,
    queryFn: twinApi.listSessions,
    enabled,
    staleTime: 15_000,
  });
}

/**
 * A message as the screen renders it.
 *
 * `pending` and `failed` exist only while a turn is in flight: the moment the
 * backend answers, both the question and the reply are already rows in
 * chat_messages, and reopening the conversation reads them from there.
 */
export interface UiMessage {
  id: string;
  role: 'user' | 'twin';
  content: string;
  pending?: boolean;
  failed?: boolean;
  /** Present on a reply — the backend's own trace, sources and confidence. */
  meta?: {
    confidence?: string;
    sources?: Record<string, string>[];
    reasoning_trace?: Record<string, string>[];
    disclaimer?: string;
  };
  /**
   * What the backend's Financial Discovery layer decided this turn should be.
   * All three fields come straight from the response and are rendered as-is —
   * the app makes no judgement about when to ask, when to push back, or when a
   * decision is worth simulating.
   *
   * These live only on messages received in this session. Reopening a saved
   * conversation reads it back from /twin/chats/{id}, which stores the text of
   * each turn and not its routing metadata, so an older turn simply renders as
   * plain prose — which is what it is.
   */
  mode?: ChatMode;
  followUp?: FollowUpQuestion | null;
  cta?: SimulationCTA | null;
}

let localId = 0;
const nextId = () => `local-${++localId}`;

/**
 * One TATHYA conversation.
 *
 * The transcript is the backend's: opening a saved session loads it from
 * /twin/chats/{id}, and every turn is persisted by POST /twin/chat before it
 * returns. The local array exists to show a question immediately and a
 * "thinking" placeholder while the pipeline runs — it is never a second store
 * of the conversation.
 */
export function useConversation() {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [loadingSession, setLoadingSession] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  /** The text of a failed turn, so the composer can hand it back. */
  const lastFailedText = useRef<string | null>(null);

  const startNew = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setSendError(null);
    lastFailedText.current = null;
  }, []);

  /** Open a saved conversation — including one started on the website. */
  const openSession = useCallback(async (id: string) => {
    setLoadingSession(true);
    setSendError(null);
    try {
      const detail = await twinApi.getSession(id);
      setSessionId(id);
      setMessages(
        detail.messages.map((m, i) => ({
          id: `${id}-${i}`,
          // The backend stores 'twin'; 'assistant' is accepted defensively
          // because the chat-history payload sent to the LLM uses that word.
          role: m.role === 'user' ? 'user' : 'twin',
          content: m.content,
        })),
      );
    } catch (err) {
      setSendError(
        err instanceof ApiError ? err.detail : 'Could not open that conversation.',
      );
    } finally {
      setLoadingSession(false);
    }
  }, []);

  const send = useMutation({
    mutationFn: async (text: string): Promise<ChatResponse> => twinApi.askTwin(text, sessionId),
  });

  const ask = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      setSendError(null);
      lastFailedText.current = null;

      const userId = nextId();
      const thinkingId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: userId, role: 'user', content: trimmed },
        { id: thinkingId, role: 'twin', content: '', pending: true },
      ]);

      try {
        const res = await send.mutateAsync(trimmed);
        // The backend assigns the session on the first turn and echoes it back.
        if (res.session_id) setSessionId(res.session_id);

        setMessages((prev) =>
          prev.map((m) =>
            m.id === thinkingId
              ? {
                  id: thinkingId,
                  role: 'twin',
                  content: res.answer,
                  meta: {
                    confidence: res.confidence,
                    sources: res.sources,
                    reasoning_trace: res.reasoning_trace,
                    disclaimer: res.disclaimer,
                  },
                  // Rendered exactly as sent. `cta` being absent is the
                  // backend saying not to offer Simulation for this turn.
                  mode: res.mode ?? 'answer',
                  followUp: res.follow_up ?? null,
                  cta: res.simulation_cta ?? null,
                }
              : m,
          ),
        );

        // The session list gains a new conversation, or a fresher timestamp.
        await qc.invalidateQueries({ queryKey: sessionsQueryKey });
      } catch (err) {
        // Drop the placeholder and mark the question as unsent, so the state on
        // screen matches what the server actually stored.
        setMessages((prev) =>
          prev
            .filter((m) => m.id !== thinkingId)
            .map((m) => (m.id === userId ? { ...m, failed: true } : m)),
        );
        lastFailedText.current = trimmed;
        setSendError(
          err instanceof ApiError
            ? err.isNetworkError
              ? err.detail
              : err.isAuthError
                ? 'Your session has expired. Please log in again.'
                : err.detail
            : 'TATHYA could not answer just now. Try again.',
        );
        if (__DEV__ && !(err instanceof ApiError)) {
          console.warn('[MoneyKal] Ask Twin failed for a non-API reason:', err);
        }
      }
    },
    [send, sessionId, qc],
  );

  /** Re-send the question that failed, dropping the failed bubble first. */
  const retry = useCallback(async () => {
    const text = lastFailedText.current;
    if (!text) return;
    setMessages((prev) => prev.filter((m) => !m.failed));
    await ask(text);
  }, [ask]);

  return {
    sessionId,
    messages,
    ask,
    retry,
    startNew,
    openSession,
    loadingSession,
    sending: send.isPending,
    sendError,
    canRetry: !!lastFailedText.current,
    /** Handed back to the composer so a failed question isn't retyped. */
    failedText: lastFailedText.current,
  };
}

export function useSessionMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: sessionsQueryKey });

  const rename = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      twinApi.renameSession(id, title),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => twinApi.deleteSession(id),
    onSuccess: invalidate,
  });

  return { rename, remove };
}
