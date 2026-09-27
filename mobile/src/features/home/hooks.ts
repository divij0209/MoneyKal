import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { homeApi, marketPulseApi } from '../../api';
import type {
  CalendarResponse,
  GoalCreatePayload,
  GoalUpdatePayload,
  UpcomingCreatePayload,
} from '../../api/types';
import { profileQueryKey } from '../../store';

/**
 * Server state for the Daily Home.
 *
 * Every figure comes from GET /home. Nothing here derives a financial number:
 * the same rule the web's home.js follows ("this file never derives a financial
 * number of its own") applies, so what the user reads always matches what the
 * API can defend.
 */

export const homeQueryKey = ['home'] as const;
export const marketPulseQueryKey = ['market-pulse'] as const;
export const calendarQueryKey = (year: number, month: number) =>
  ['home', 'calendar', year, month] as const;

export function useHome() {
  return useQuery({
    queryKey: homeQueryKey,
    queryFn: homeApi.fetchHome,
    staleTime: 30_000,
  });
}

export function useMarketPulse() {
  return useQuery({
    queryKey: marketPulseQueryKey,
    queryFn: marketPulseApi.fetchMarketPulse,
    // News moves slowly and the upstream is rate-limited; a five-minute window
    // matches the server's own cache rather than fighting it.
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

/**
 * The calendar month currently on screen.
 *
 * GET /home already ships the current month, so that one is seeded from the
 * dashboard payload and no second request is made on first paint. Paging
 * fetches only the month asked for — the web makes the same distinction, and
 * for the same reason: an arrow press must not re-fetch the whole dashboard.
 */
export function useCalendarMonth(seed: CalendarResponse | undefined) {
  const [month, setMonth] = useState<{ year: number; month: number } | null>(null);

  const target = month ?? (seed ? { year: seed.year, month: seed.month } : null);
  const isSeedMonth =
    !!seed && !!target && target.year === seed.year && target.month === seed.month;

  const query = useQuery({
    queryKey: calendarQueryKey(target?.year ?? 0, target?.month ?? 0),
    queryFn: () => homeApi.fetchCalendar(target!.year, target!.month),
    enabled: !!target && !isSeedMonth,
    staleTime: 60_000,
    // Keeps the previous month on screen while the next one loads, so paging
    // does not flash an empty grid.
    placeholderData: (prev) => prev,
  });

  const data = isSeedMonth ? seed : query.data;

  const shift = useCallback(
    (delta: number) => {
      if (!target) return;
      const d = new Date(target.year, target.month - 1 + delta, 1);
      setMonth({ year: d.getFullYear(), month: d.getMonth() + 1 });
    },
    [target],
  );

  const goToday = useCallback(() => {
    const now = new Date();
    setMonth({ year: now.getFullYear(), month: now.getMonth() + 1 });
  }, []);

  return {
    calendar: data,
    isLoading: !isSeedMonth && query.isFetching && !data,
    shift,
    goToday,
    isCurrentMonth:
      !!data && !!seed && data.year === seed.year && data.month === seed.month,
  };
}

/**
 * Anything that changes the dashboard invalidates the whole /home payload.
 *
 * Deliberately coarse: the sections share one ledger read and the insight
 * engine takes the other sections' output as input, so patching one section
 * locally would let the parts disagree with each other. The web refetches for
 * the same reason (`load({ force: true })` after every mutation).
 */
export function useHomeMutations() {
  const qc = useQueryClient();

  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: homeQueryKey });
    await qc.invalidateQueries({ queryKey: ['home', 'calendar'] });
  }, [qc]);

  /** Goals are mirrored into the legacy Profile.goal blob server-side, so the
   *  profile is refetched too — same follow-up the web does after a goal write. */
  const invalidateWithProfile = useCallback(async () => {
    await invalidate();
    await qc.invalidateQueries({ queryKey: profileQueryKey });
  }, [invalidate, qc]);

  const createGoal = useMutation({
    mutationFn: (payload: GoalCreatePayload) => homeApi.createGoal(payload),
    onSuccess: invalidateWithProfile,
  });

  const updateGoal = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: GoalUpdatePayload }) =>
      homeApi.updateGoal(id, payload),
    onSuccess: invalidateWithProfile,
  });

  const deleteGoal = useMutation({
    mutationFn: (id: number) => homeApi.deleteGoal(id),
    onSuccess: invalidateWithProfile,
  });

  const createUpcoming = useMutation({
    mutationFn: (payload: UpcomingCreatePayload) => homeApi.createUpcoming(payload),
    onSuccess: invalidate,
  });

  const markPaid = useMutation({
    mutationFn: (id: number) => homeApi.markUpcomingPaid(id),
    onSuccess: invalidate,
  });

  const deleteUpcoming = useMutation({
    mutationFn: (id: number) => homeApi.deleteUpcoming(id),
    onSuccess: invalidate,
  });

  const confirmSuggestion = useMutation({
    mutationFn: (id: number) => homeApi.confirmUpcoming(id),
    onSuccess: invalidate,
  });

  const dismissSuggestion = useMutation({
    mutationFn: (id: number) => homeApi.dismissUpcoming(id),
    onSuccess: invalidate,
  });

  return {
    createGoal,
    updateGoal,
    deleteGoal,
    createUpcoming,
    markPaid,
    deleteUpcoming,
    confirmSuggestion,
    dismissSuggestion,
  };
}
