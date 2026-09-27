import { api } from '../client';
import type {
  CalendarResponse,
  GenericResponse,
  GoalCreatePayload,
  GoalResponse,
  GoalUpdatePayload,
  HomeResponse,
  UpcomingCreatePayload,
  UpcomingResponse,
} from '../types';

/**
 * Daily Home endpoints — backend/routers/home.py.
 *
 * Paths, query parameters and payload field names match what
 * twin-app/js/api.js sends, so both clients hit the same contract.
 */

/** The device's own calendar date as YYYY-MM-DD.
 *
 *  Built from local parts rather than toISOString(), which converts to UTC and
 *  can land a day early — the same bug the web's `localDateKey()` avoids. For a
 *  user in IST before 05:30, UTC is still yesterday, which would put "today"
 *  on the wrong day of the calendar and mis-label every due date. */
export function localDateKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * One consolidated read for the whole dashboard.
 *
 * The local hour and date are sent so the greeting and "this month" follow the
 * user's own clock rather than the server's timezone — same reason the web
 * sends them.
 */
export function fetchHome(): Promise<HomeResponse> {
  const now = new Date();
  return api.get<HomeResponse>('/home', {
    query: { local_hour: now.getHours(), local_date: localDateKey(now) },
  });
}

/**
 * One month of financial events.
 *
 * Deliberately separate from fetchHome(): paging months must not re-fetch the
 * entire dashboard on every arrow press.
 */
export function fetchCalendar(year: number, month: number): Promise<CalendarResponse> {
  return api.get<CalendarResponse>('/home/calendar', {
    query: { year, month, local_date: localDateKey() },
  });
}

/* ------------------------------------------------------------------ goals */

export function listGoals(): Promise<GoalResponse[]> {
  return api.get<GoalResponse[]>('/home/goals');
}

export function createGoal(payload: GoalCreatePayload): Promise<GoalResponse> {
  return api.post<GoalResponse>('/home/goals', payload);
}

export function updateGoal(goalId: number, payload: GoalUpdatePayload): Promise<GoalResponse> {
  return api.put<GoalResponse>(`/home/goals/${goalId}`, payload);
}

export function deleteGoal(goalId: number): Promise<GenericResponse> {
  return api.delete<GenericResponse>(`/home/goals/${goalId}`);
}

/* --------------------------------------------------------------- upcoming */

export function createUpcoming(payload: UpcomingCreatePayload): Promise<UpcomingResponse> {
  return api.post<UpcomingResponse>('/home/upcoming', payload);
}

export function markUpcomingPaid(itemId: number): Promise<UpcomingResponse> {
  return api.post<UpcomingResponse>(`/home/upcoming/${itemId}/mark-paid`);
}

export function deleteUpcoming(itemId: number): Promise<GenericResponse> {
  return api.delete<GenericResponse>(`/home/upcoming/${itemId}`);
}

/* Detected obligations awaiting the user's yes/no. MoneyKal never promotes one
   of these on its own — these two calls are the only way a suggestion becomes
   a real upcoming payment. */

export function confirmUpcoming(
  itemId: number,
  corrections?: Partial<UpcomingCreatePayload>,
): Promise<UpcomingResponse> {
  return api.post<UpcomingResponse>(`/home/upcoming/${itemId}/confirm`, corrections ?? {});
}

export function dismissUpcoming(itemId: number): Promise<GenericResponse> {
  return api.post<GenericResponse>(`/home/upcoming/${itemId}/dismiss`);
}
