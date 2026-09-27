import { api } from '../client';
import type { MarketPulseResponse } from '../types';

/**
 * GET /market-pulse — backend/routers/market_pulse.py.
 *
 * The router swallows upstream failures and returns an empty `signals` array
 * with a `message`, so this never rejects for a news outage. The UI renders
 * that message, exactly as the web's renderMarketPulse() does.
 */
export function fetchMarketPulse(): Promise<MarketPulseResponse> {
  return api.get<MarketPulseResponse>('/market-pulse');
}
