import { api } from '../client';
import type { StartupOverviewResponse } from '../types';

/**
 * The Startup dashboard — backend/routers/startup.py.
 *
 * One read. Every metric, chart series, goal, alert and decision on the
 * Overview comes from this single payload, already computed and already
 * formatted. There is no second endpoint behind any section, and the client
 * derives no figure of its own.
 */
export function fetchStartupOverview(): Promise<StartupOverviewResponse> {
  // Ten metrics, a twelve-month projection and a health model — past the
  // default request budget on a cold call.
  return api.get<StartupOverviewResponse>('/startup/overview', { slow: true });
}
