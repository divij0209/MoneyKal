import { api } from '../client';
import type { AffordabilityVerdict, LiveLifeResponse } from '../types';

/**
 * live.life.fully — backend/routers/live_life.py.
 *
 * Two reads. The experience has no write endpoints of its own by design: a
 * stash is a FinancialGoal, so creating and funding one goes through
 * POST /home/goals and PUT /home/goals/{id} — the same routes the Home screen
 * already uses. That is why this module has no `createStash`.
 */

/**
 * Everything the experience renders, in one request.
 *
 * `local_date` is the viewer's own date, not the server's, so countdowns, due
 * dates and "this month" follow the calendar the user is actually looking at.
 * Sending it is not optional politeness — omitting it silently re-dates the
 * whole screen to UTC.
 */
export function fetchLiveLife(localDate: string): Promise<LiveLifeResponse> {
  return api.get<LiveLifeResponse>('/live-life', {
    query: { local_date: localDate },
    slow: true,
  });
}

/**
 * "Can I afford this?"
 *
 * Answered against the same Freedom Balance the screen is showing, so the
 * verdict can never contradict the headline number. `goalId` reports the delay
 * against one particular stash rather than whichever has the nearest deadline.
 */
export function checkAffordability(
  amount: number,
  localDate: string,
  goalId?: number | null,
): Promise<AffordabilityVerdict> {
  return api.post<AffordabilityVerdict>(
    '/live-life/check',
    { amount, local_date: localDate, goal_id: goalId ?? null },
    { slow: true },
  );
}
