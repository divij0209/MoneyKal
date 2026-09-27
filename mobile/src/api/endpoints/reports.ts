import { api } from '../client';
import type {
  OverviewBriefResponse,
  WeeklyReportResponse,
  WeeklySpendReportListItem,
  WeeklySpendReportResponse,
} from '../types';

/**
 * Reports — backend/routers/startup.py.
 *
 * Every figure on the Reports screen is computed server-side from the same
 * profile and the same Hisaab transactions the website reads. The client asks
 * four questions and renders four answers; it derives nothing.
 *
 * The `/startup` prefix is historical, not a persona gate. These routes resolve
 * the caller's profile with `_get_user_profile()` and then
 * `_get_flexible_context()`, which serves Individual and Startup alike — which
 * is why the web shows this view to both.
 */

/**
 * The daily brief.
 *
 * Read from the overview payload rather than a route of its own, because the
 * backend has no dedicated brief endpoint and the web does exactly this
 * (`renderReportsView()` calls `fetchStartupOverview()` for it).
 */
export function fetchDailyBrief(): Promise<OverviewBriefResponse> {
  return api.get<OverviewBriefResponse>('/startup/overview', { slow: true });
}

/** The weekly financial health report — the tracking-window timeline. */
export function fetchWeeklyReport(): Promise<WeeklyReportResponse> {
  return api.get<WeeklyReportResponse>('/startup/reports/weekly', { slow: true });
}

/**
 * The current Mon–Sun weekly spend report.
 *
 * Idempotent on the server: calling it again inside the same week recomputes
 * the figures over any newly logged transactions and overwrites the same row
 * rather than creating a second one. So a pull-to-refresh here is a refresh,
 * not a duplicate.
 */
export function fetchWeeklySpendReport(): Promise<WeeklySpendReportResponse> {
  return api.get<WeeklySpendReportResponse>('/startup/reports/weekly-suggestions', {
    slow: true,
  });
}

/** Past weekly spend reports, newest first — the web's history dropdown. */
export function fetchWeeklySpendHistory(): Promise<WeeklySpendReportListItem[]> {
  return api.get<WeeklySpendReportListItem[]>('/startup/reports/weekly-suggestions/history');
}

/** One saved weekly spend report. */
export function fetchWeeklySpendReportById(id: number): Promise<WeeklySpendReportResponse> {
  return api.get<WeeklySpendReportResponse>(`/startup/reports/weekly-suggestions/${id}`);
}
