import { api } from '../client';
import type {
  IncomeCollectionResponse,
  SaveTaxProfileResponse,
  TaxConfigResponse,
  TaxProfileInput,
  TaxProfileResponse,
} from '../types.tax';

/**
 * Individual Tax Calculator.
 *
 * Mirrors backend/routers/tax.py exactly — four routes, same paths, same
 * query parameter. Every endpoint except /config is Individual-only and
 * answers 403 for a Startup or Enterprise profile; the screen renders that
 * as a state rather than treating it as a failure.
 */

/** Metadata the forms render from: labels, limits, slabs, guidance, ITR forms.
 *  Unauthenticated on the backend, but sent with the bearer like everything
 *  else so a signed-in user's request looks the same as any other. */
export function config(taxYear?: string) {
  return api.get<TaxConfigResponse>('/tax/config', {
    query: taxYear ? { tax_year: taxYear } : undefined,
  });
}

/**
 * The whole computation. Despite the name this is not just Step 1: the
 * response carries the heads, Chapter VI-A deductions, TDS, the full old-vs-
 * new regime comparison with slabs and surcharge, the rule-based
 * recommendations and the ITR form selection (see `collect_income` in
 * backend/services/tax_service.py). Stateless — nothing is persisted.
 */
export function collect(payload: TaxProfileInput) {
  return api.post<IncomeCollectionResponse>('/tax/collect', payload);
}

/** Saved inputs for a year. Returns empty defaults when none exist. */
export function getProfile(taxYear?: string) {
  return api.get<TaxProfileResponse>('/tax/profile', {
    query: taxYear ? { tax_year: taxYear } : undefined,
  });
}

/** Upserts inputs for a year and returns the freshly recomputed result. */
export function saveProfile(payload: TaxProfileInput, taxYear?: string) {
  return api.put<SaveTaxProfileResponse>('/tax/profile', payload, {
    query: taxYear ? { tax_year: taxYear } : undefined,
  });
}
