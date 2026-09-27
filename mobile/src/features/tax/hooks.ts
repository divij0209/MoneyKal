import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, taxApi } from '../../api';
import type {
  DeductionEntry,
  HouseProperty,
  IncomeCollectionResponse,
  TaxProfileInput,
} from '../../api/types.tax';
import { emptyTaxInput, hydrate } from './defaults';

export const taxConfigKey = ['tax', 'config'] as const;
export const taxProfileKey = ['tax', 'profile'] as const;

/** Labels, limits, slabs, guidance. Rarely changes, so it is cached hard. */
export function useTaxConfig(taxYear?: string) {
  return useQuery({
    queryKey: [...taxConfigKey, taxYear ?? 'default'],
    queryFn: () => taxApi.config(taxYear),
    staleTime: 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
  });
}

/** The saved submission for a year, if there is one. */
export function useTaxProfile(taxYear?: string) {
  return useQuery({
    queryKey: [...taxProfileKey, taxYear ?? 'default'],
    queryFn: () => taxApi.getProfile(taxYear),
    staleTime: 5 * 60_000,
  });
}

/* ========================================================================== *
 * The form
 * ========================================================================== */

const DEBOUNCE_MS = 550;

export interface TaxFormState {
  input: TaxProfileInput;
  result: IncomeCollectionResponse | null;
  /** A recompute is in flight. Distinct from "no result yet". */
  computing: boolean;
  computeError: unknown;
  /** True once the saved profile has been merged in. */
  ready: boolean;
  /** 403 from the backend — this profile is not an Individual. */
  forbidden: boolean;
}

/**
 * Drives the whole Tax screen.
 *
 * The shape of this is dictated by the backend: POST /tax/collect is
 * stateless and returns the entire computation — heads, deductions, TDS, both
 * regimes, the comparison, the recommendations and the ITR form — so the
 * screen keeps one input object, posts it on change, and renders whatever
 * comes back. There is no client-side tax arithmetic anywhere in this
 * feature, which is the only way the app and the web can agree.
 *
 * Recompute is debounced and single-flighted: typing into the CTC field
 * fires one request after the pause, and a response that arrives after a
 * newer request went out is dropped rather than overwriting fresher figures.
 */
export function useTaxForm(taxYear?: string) {
  const qc = useQueryClient();
  const profile = useTaxProfile(taxYear);

  const [input, setInput] = useState<TaxProfileInput>(emptyTaxInput);
  const [result, setResult] = useState<IncomeCollectionResponse | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<unknown>(null);
  const [ready, setReady] = useState(false);

  /** Monotonic request id; only the newest response is allowed to land. */
  const requestId = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Seed the form from the saved profile, once. */
  useEffect(() => {
    if (ready || !profile.data) return;
    setInput(hydrate(profile.data.inputs));
    if (profile.data.last_result) setResult(profile.data.last_result);
    setReady(true);
  }, [profile.data, ready]);

  /* A 403 means the backend refused this persona. Surface it as a state, not
     as an error — the Tax Calculator is Individual-only by design. */
  const forbidden =
    profile.error instanceof ApiError && profile.error.status === 403;

  useEffect(() => {
    if (forbidden) setReady(true);
  }, [forbidden]);

  const compute = useCallback(
    async (payload: TaxProfileInput) => {
      const id = ++requestId.current;
      setComputing(true);
      setComputeError(null);
      try {
        const next = await taxApi.collect(payload);
        if (id !== requestId.current) return; // superseded
        setResult(next);
      } catch (err) {
        if (id !== requestId.current) return;
        setComputeError(err);
      } finally {
        if (id === requestId.current) setComputing(false);
      }
    },
    [],
  );

  /** Apply a change and schedule a recompute. */
  const update = useCallback(
    (mutate: (draft: TaxProfileInput) => TaxProfileInput) => {
      setInput((current) => {
        const next = mutate(current);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void compute(next), DEBOUNCE_MS);
        return next;
      });
    },
    [compute],
  );

  /** Force a recompute now — used by the "recalculate" affordance. */
  const recomputeNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void compute(input);
  }, [compute, input]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const save = useMutation({
    mutationFn: () => taxApi.saveProfile(input, taxYear),
    onSuccess: (data) => {
      setResult(data.result);
      void qc.invalidateQueries({ queryKey: taxProfileKey });
    },
  });

  /* ----------------------------------------------------------- field helpers
     Typed setters so a screen never reaches into the payload by hand. */

  const setTaxpayer = useCallback(
    (patch: Partial<TaxProfileInput['taxpayer']>) =>
      update((d) => ({ ...d, taxpayer: { ...d.taxpayer, ...patch } })),
    [update],
  );

  const setSalary = useCallback(
    (patch: Partial<TaxProfileInput['salary']>) =>
      update((d) => ({
        ...d,
        // Any salary edit implies the head is in play; the backend keys
        // `active_heads` off whether a head has values, and `enabled` is what
        // makes the head render at all.
        salary: { ...d.salary, ...patch, enabled: true },
      })),
    [update],
  );

  const setOtherSources = useCallback(
    (patch: Partial<TaxProfileInput['other_sources']>) =>
      update((d) => ({
        ...d,
        other_sources: { ...d.other_sources, ...patch, enabled: true },
      })),
    [update],
  );

  const setCapitalGains = useCallback(
    (patch: Partial<TaxProfileInput['capital_gains']>) =>
      update((d) => ({
        ...d,
        capital_gains: { ...d.capital_gains, ...patch, enabled: true },
      })),
    [update],
  );

  const setPgbp = useCallback(
    (patch: Partial<TaxProfileInput['pgbp']>) =>
      update((d) => ({ ...d, pgbp: { ...d.pgbp, ...patch, enabled: true } })),
    [update],
  );

  const setHouseProperties = useCallback(
    (properties: HouseProperty[]) =>
      update((d) => ({
        ...d,
        house_property: { enabled: properties.length > 0, properties },
      })),
    [update],
  );

  /** Upsert one Chapter VI-A claim. A zero amount removes the entry, so an
   *  emptied field does not send a `0` claim the engine has to reject. */
  const setDeduction = useCallback(
    (key: string, patch: Partial<Omit<DeductionEntry, 'key'>>) =>
      update((d) => {
        const existing = d.deductions.entries.find((e) => e.key === key);
        const merged: DeductionEntry = {
          key,
          amount: existing?.amount ?? 0,
          is_senior_citizen_claim: existing?.is_senior_citizen_claim ?? false,
          is_severe_disability: existing?.is_severe_disability ?? false,
          ...patch,
        };
        const others = d.deductions.entries.filter((e) => e.key !== key);
        return {
          ...d,
          deductions: {
            ...d.deductions,
            entries: merged.amount > 0 ? [...others, merged] : others,
          },
        };
      }),
    [update],
  );

  /** The two convenience mirrors on DeductionsInput that are not `entries`. */
  const setDeductionsMeta = useCallback(
    (patch: Partial<Pick<TaxProfileInput['deductions'], 'employee_pf_contribution' | 'home_loan_principal'>>) =>
      update((d) => ({ ...d, deductions: { ...d.deductions, ...patch } })),
    [update],
  );

  const setTaxesPaid = useCallback(
    (patch: { advance_tax_paid?: number; self_assessment_tax_paid?: number }) =>
      update((d) => ({ ...d, ...patch })),
    [update],
  );

  const deductionAmount = useCallback(
    (key: string) => input.deductions.entries.find((e) => e.key === key)?.amount ?? 0,
    [input.deductions.entries],
  );

  const state: TaxFormState = useMemo(
    () => ({
      input,
      result,
      computing,
      computeError,
      ready: ready || profile.isError,
      forbidden,
    }),
    [input, result, computing, computeError, ready, profile.isError, forbidden],
  );

  return {
    ...state,
    loading: profile.isLoading && !ready,
    save,
    recomputeNow,
    setTaxpayer,
    setSalary,
    setOtherSources,
    setCapitalGains,
    setPgbp,
    setHouseProperties,
    setDeduction,
    setDeductionsMeta,
    setTaxesPaid,
    deductionAmount,
  };
}

/* ========================================================================== *
 * Formatting
 * ========================================================================== */

/**
 * Indian-grouped rupees.
 *
 * The one place in this app that formats currency on the client. Everywhere
 * else the backend sends a `*_display` string; the tax engine returns raw
 * floats (`total_tax_liability: 148200.0`) and no display twin, so the
 * numbers have to be grouped here. `en-IN` gives the 2,2,3 lakh/crore
 * grouping that an Indian taxpayer expects — 1,48,200, not 148,200.
 */
export function formatINR(value: number, options?: { compact?: boolean; sign?: boolean }): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);

  if (options?.compact && abs >= 100000) {
    const crore = abs / 10000000;
    const lakh = abs / 100000;
    const body =
      abs >= 10000000
        ? `${crore.toFixed(crore >= 10 ? 1 : 2)} Cr`
        : `${lakh.toFixed(lakh >= 10 ? 1 : 2)} L`;
    const sign = value < 0 ? '−' : options?.sign ? '+' : '';
    return `${sign}₹${body}`;
  }

  const body = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
  }).format(Math.round(abs));

  const sign = value < 0 ? '−' : options?.sign ? '+' : '';
  return `${sign}₹${body}`;
}

/** A statutory rate: 0.05 -> "5%". The engine returns fractions. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  const percent = rate <= 1 ? rate * 100 : rate;
  const rounded = Math.round(percent * 100) / 100;
  return `${rounded}%`;
}

/** "₹4,00,000 – ₹8,00,000" / "Above ₹24,00,000" for a slab band. */
export function formatBand(from: number, to?: number | null): string {
  if (to === null || to === undefined) return `Above ${formatINR(from, { compact: true })}`;
  if (from === 0) return `Up to ${formatINR(to, { compact: true })}`;
  return `${formatINR(from, { compact: true })} – ${formatINR(to, { compact: true })}`;
}
