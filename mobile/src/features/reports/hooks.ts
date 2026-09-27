import { useCallback, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { reportsApi } from '../../api';
import type { WeeklySpendReportResponse } from '../../api/types';

/**
 * Reports' three data sources.
 *
 * Deliberately three separate queries rather than one combined fetch, because
 * the web loads each panel independently and lets each fail on its own — a
 * daily brief that errors leaves the weekly report on screen. Merging them
 * would make any one failure blank the whole page.
 */

export const dailyBriefKey = ['reports', 'daily-brief'] as const;
export const weeklyReportKey = ['reports', 'weekly'] as const;
export const weeklySpendKey = ['reports', 'weekly-spend'] as const;
export const weeklySpendHistoryKey = ['reports', 'weekly-spend', 'history'] as const;
export const weeklySpendByIdKey = (id: number) =>
  ['reports', 'weekly-spend', id] as const;

export function useDailyBrief() {
  return useQuery({
    queryKey: dailyBriefKey,
    queryFn: reportsApi.fetchDailyBrief,
    staleTime: 60_000,
  });
}

export function useWeeklyReport() {
  return useQuery({
    queryKey: weeklyReportKey,
    queryFn: reportsApi.fetchWeeklyReport,
    staleTime: 60_000,
  });
}

export function useWeeklySpendReport() {
  return useQuery({
    queryKey: weeklySpendKey,
    queryFn: reportsApi.fetchWeeklySpendReport,
    staleTime: 60_000,
  });
}

export function useWeeklySpendHistory(enabled = true) {
  return useQuery({
    queryKey: weeklySpendHistoryKey,
    queryFn: reportsApi.fetchWeeklySpendHistory,
    enabled,
    staleTime: 60_000,
  });
}

/**
 * Which weekly spend report is on screen.
 *
 * Null means the current week — the report the plain endpoint returns. Picking
 * an older one from the history sheet swaps in that saved row instead, exactly
 * as the web's `<select>` does.
 */
export function useReports() {
  const qc = useQueryClient();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const brief = useDailyBrief();
  const weekly = useWeeklyReport();
  const current = useWeeklySpendReport();
  const history = useWeeklySpendHistory();

  const selected = useQuery({
    queryKey: weeklySpendByIdKey(selectedId ?? -1),
    queryFn: () => reportsApi.fetchWeeklySpendReportById(selectedId as number),
    enabled: selectedId !== null,
    staleTime: 60_000,
  });

  /** The report actually being displayed. */
  const spend: WeeklySpendReportResponse | undefined =
    selectedId === null ? current.data : selected.data;

  const spendLoading = selectedId === null ? current.isLoading : selected.isLoading;
  const spendError = selectedId === null ? current.error : selected.error;

  const refreshAll = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['reports'] });
  }, [qc]);

  /** The web's Refresh button sits on the weekly health panel alone. */
  const refreshWeekly = useCallback(() => {
    void weekly.refetch();
  }, [weekly]);

  return {
    brief,
    weekly,
    history,
    spend,
    spendLoading,
    spendError,
    selectedId,
    selectReport: setSelectedId,
    refreshAll,
    refreshWeekly,
    refreshing:
      brief.isRefetching || weekly.isRefetching || current.isRefetching,
  };
}
