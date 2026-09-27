import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, homeApi, liveLifeApi } from '../../api';
import type {
  AffordabilityVerdict,
  LiveLifeMoment,
  LiveLifeResponse,
} from '../../api/types';
import { ACCENT_INTERVAL_MS, BACKDROP_ACCENTS, localDateKey } from './constants';

/**
 * live.life.fully's data.
 *
 * One read drives the whole screen — the sections share a ledger read and the
 * moment rules take the Freedom Balance and the stash as input, so splitting
 * them would let the three answers disagree mid-render. That is the backend's
 * stated reason for consolidating, and the client honours it by not
 * decomposing the call.
 *
 * Creating and funding a stash go through the Home goals endpoints, because a
 * stash *is* a goal. After either, the whole payload is refetched rather than
 * patched locally: the Freedom Balance, the moment and the countdown all move
 * when a goal changes, and only the backend knows how.
 */

export const liveLifeQueryKey = (localDate: string) =>
  ['live-life', localDate] as const;

export function useLiveLife() {
  const qc = useQueryClient();
  const [localDate] = useState(() => localDateKey());

  const query = useQuery({
    queryKey: liveLifeQueryKey(localDate),
    queryFn: () => liveLifeApi.fetchLiveLife(localDate),
    staleTime: 60_000,
  });

  /** After a stash write, everything this screen and Home show can move. */
  const refreshEverything = useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['live-life'] }),
      qc.invalidateQueries({ queryKey: ['home'] }),
    ]);
  }, [qc]);

  const createStash = useMutation({
    mutationFn: (payload: {
      name: string;
      target_amount: number;
      current_amount: number;
      target_date: string | null;
      category: string;
    }) => homeApi.createGoal({ ...payload, icon: null }),
    onSuccess: refreshEverything,
  });

  const fundStash = useMutation({
    mutationFn: ({ id, nextAmount }: { id: number; nextAmount: number }) =>
      homeApi.updateGoal(id, { current_amount: nextAmount }),
    onSuccess: refreshEverything,
  });

  return { localDate, query, createStash, fundStash, refreshEverything };
}

/**
 * "Can I afford this?"
 *
 * Kept out of the main query because it is a question the user asks, not part
 * of the page's state — and because the verdict must stay on screen while they
 * think about it, rather than being cleared by a background refetch.
 */
export function useAffordability(localDate: string) {
  const [verdict, setVerdict] = useState<AffordabilityVerdict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const ask = useCallback(
    async (amount: number, goalId?: number | null) => {
      if (!amount || amount <= 0) return;
      setPending(true);
      setError(null);
      try {
        setVerdict(await liveLifeApi.checkAffordability(amount, localDate, goalId));
      } catch (err) {
        setVerdict(null);
        setError(
          err instanceof ApiError
            ? err.detail
            : "That check didn't go through. Try again.",
        );
      } finally {
        setPending(false);
      }
    },
    [localDate],
  );

  const clear = useCallback(() => {
    setVerdict(null);
    setError(null);
  }, []);

  return { verdict, error, pending, ask, clear };
}

/**
 * Which accent the backdrop is on.
 *
 * The web advances this on an eleven-second beat because its single looping
 * clip never changes and the colour is what keeps the page breathing. Same
 * beat, same six values, same reason.
 */
export function useAccentCycle() {
  /* There is one accent now — MoneyKal cyan — so there is nothing to cycle.
     The rotating six-colour beat and its 11-second interval are gone with the
     rest of the aurora; see the note on BACKDROP_ACCENTS in constants.ts.

     The hook is kept, and still returns `{ index, accent }`, because several
     components take an `accent` prop and this is the one place that decides
     it — if the experience ever earns a second accent, it changes here. */
  return { index: 0, accent: BACKDROP_ACCENTS[0] };
}

/**
 * Which moments have already been celebrated in this session.
 *
 * The backend has no per-user notification state by design, so the client
 * remembers: a moment already seen today gives way to a fresh alternative, and
 * if none is fresh it is shown calmly ("Still true today") rather than
 * announced as news a second time. The web keeps this in the same place — on
 * the client, for the session.
 */
export function useSeenMoments() {
  const seen = useRef<string[]>([]);

  /**
   * Picks the moment to show. Returns the chosen one and whether it is a
   * repeat, and records it as seen.
   */
  const pick = useCallback(
    (data: LiveLifeResponse | undefined): { moment: LiveLifeMoment | null; repeat: boolean } => {
      const primary = data?.moment ?? null;
      if (!primary) return { moment: null, repeat: false };

      let chosen = primary;
      if (seen.current.includes(primary.cooldown_key)) {
        const fresh = (data?.moment_alternatives ?? []).find(
          (a) => !seen.current.includes(a.cooldown_key),
        );
        if (fresh) chosen = fresh;
      }

      const repeat = seen.current.includes(chosen.cooldown_key);
      if (!repeat) seen.current.push(chosen.cooldown_key);
      return { moment: chosen, repeat };
    },
    [],
  );

  return { pick };
}
