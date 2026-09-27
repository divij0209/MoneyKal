import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { hisaabApi } from '../../api';
import type { TransactionPayload } from '../../api/endpoints/hisaab';
import type { Transaction } from '../../api/types';
import { homeQueryKey } from '../home/hooks';
import { buildActivityIndex, cleanTxnDescription, type TxnType } from './constants';

export const hisaabQueryKey = ['hisaab'] as const;

export function useHisaab() {
  return useQuery({
    queryKey: hisaabQueryKey,
    queryFn: hisaabApi.fetchHisaab,
    staleTime: 30_000,
  });
}

/**
 * Writes to the ledger.
 *
 * Every mutation invalidates the Home payload as well: GET /home derives
 * monthly spending, the spending overview, the insight and the calendar from
 * these same rows, so leaving it cached would let two screens disagree about
 * the same transaction.
 */
export function useHisaabMutations() {
  const qc = useQueryClient();

  const invalidate = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: hisaabQueryKey });
    await qc.invalidateQueries({ queryKey: homeQueryKey });
    await qc.invalidateQueries({ queryKey: ['home', 'calendar'] });
  }, [qc]);

  const create = useMutation({
    mutationFn: (payload: TransactionPayload) =>
      hisaabApi.addTransaction({ ...payload, source: payload.source ?? 'manual' }),
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Partial<TransactionPayload> }) =>
      hisaabApi.updateTransaction(id, payload),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: number) => hisaabApi.deleteTransaction(id),
    onSuccess: invalidate,
  });

  return { create, update, remove };
}

export interface HisaabFilters {
  /** A single day, from the calendar or a Home hand-off. */
  date: string | null;
  /** The month the calendar is showing: {year, month} with month 1-12. */
  month: { year: number; month: number };
  type: TxnType | 'all';
  category: string | null;
  search: string;
}

/**
 * Client-side views over the ledger the API already returned.
 *
 * Filtering, grouping and the day totals all run over `transactions` from
 * GET /startup/hisaab — no further requests, which is also how the web behaves
 * (`allTxns.filter(t => t.txn_date === dateFilter)`, and its filter bar sums
 * that day's in/out the same way). The headline money_in / money_out / net
 * always come from the API and are never recomputed here.
 */
export function useHisaabView(transactions: Transaction[], filters: HisaabFilters) {
  const activity = useMemo(() => buildActivityIndex(transactions), [transactions]);

  const filtered = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    return transactions.filter((t) => {
      if (filters.date && t.txn_date !== filters.date) return false;
      if (filters.type !== 'all' && t.type !== filters.type) return false;
      if (filters.category && t.category !== filters.category) return false;
      if (term) {
        const haystack = `${t.category} ${cleanTxnDescription(t.description)}`.toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [transactions, filters]);

  /** Grouped by day, newest first — the shape the list renders. */
  const groups = useMemo(() => {
    const byDay = new Map<string, Transaction[]>();
    for (const t of filtered) {
      const list = byDay.get(t.txn_date) ?? [];
      list.push(t);
      byDay.set(t.txn_date, list);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([date, items]) => ({ date, items }));
  }, [filtered]);

  /**
   * Totals for the current filter. Shown only alongside a filter, never in
   * place of the API's headline figures — this is a sum of rows on screen,
   * the same one the web's filter bar performs.
   */
  const filteredTotals = useMemo(() => {
    let moneyIn = 0;
    let moneyOut = 0;
    for (const t of filtered) {
      if (t.type === 'in') moneyIn += t.amount;
      else moneyOut += t.amount;
    }
    return { moneyIn, moneyOut, count: filtered.length };
  }, [filtered]);

  /** Categories actually present, for the filter picker. */
  const presentCategories = useMemo(
    () => [...new Set(transactions.map((t) => t.category))].sort(),
    [transactions],
  );

  return { activity, filtered, groups, filteredTotals, presentCategories };
}

/**
 * Month-by-month in/out over the whole ledger.
 *
 * Derived on the client from the same `transactions` array every other view
 * on this screen reads, for the same reason: GET /startup/hisaab returns the
 * entire ledger in one response, so a per-month rollup is a grouping rather
 * than a fetch. The API's headline money_in / money_out / net are still never
 * recomputed — those come from the response and are shown as-is.
 *
 * Returns the most recent `months` periods, oldest first, so the chart reads
 * left-to-right in time order.
 */
export function useHisaabTrend(transactions: Transaction[], months = 6) {
  return useMemo(() => {
    const byMonth = new Map<string, { income: number; expense: number }>();

    for (const t of transactions) {
      // txn_date is an ISO date; the first seven characters are YYYY-MM.
      const key = (t.txn_date || '').slice(0, 7);
      if (key.length !== 7) continue;
      const bucket = byMonth.get(key) ?? { income: 0, expense: 0 };
      if (t.type === 'in') bucket.income += t.amount;
      else bucket.expense += t.amount;
      byMonth.set(key, bucket);
    }

    const ordered = [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const recent = ordered.slice(-months);

    return recent.map(([key, totals]) => {
      const [, month] = key.split('-').map(Number);
      return {
        key,
        // Three-letter month, which is what fits under a column at phone
        // width. Not localised: MONTH_ABBR is a fixed Latin abbreviation and
        // a Devanagari month name would not fit the column either way.
        label: MONTH_ABBR[month - 1] ?? key,
        income: totals.income,
        expense: totals.expense,
        net: totals.income - totals.expense,
      };
    });
  }, [transactions, months]);
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Filter state, with the calendar month kept in step with a chosen day. */
export function useHisaabFilters(initialDate?: string | null) {
  const now = new Date();
  const seed = initialDate ? initialDate.split('-').map(Number) : null;

  const [filters, setFilters] = useState<HisaabFilters>({
    date: initialDate ?? null,
    month: seed
      ? { year: seed[0], month: seed[1] }
      : { year: now.getFullYear(), month: now.getMonth() + 1 },
    type: 'all',
    category: null,
    search: '',
  });

  const setDate = useCallback((date: string | null) => {
    setFilters((f) => {
      if (!date) return { ...f, date: null };
      const [y, m] = date.split('-').map(Number);
      // Selecting a day also moves the calendar to its month, so the selection
      // is always visible rather than being on a page the user cannot see.
      return { ...f, date, month: { year: y, month: m } };
    });
  }, []);

  const shiftMonth = useCallback((delta: number) => {
    setFilters((f) => {
      const d = new Date(f.month.year, f.month.month - 1 + delta, 1);
      return { ...f, month: { year: d.getFullYear(), month: d.getMonth() + 1 } };
    });
  }, []);

  const goToday = useCallback(() => {
    const t = new Date();
    setFilters((f) => ({ ...f, month: { year: t.getFullYear(), month: t.getMonth() + 1 } }));
  }, []);

  const setType = useCallback(
    (type: TxnType | 'all') => setFilters((f) => ({ ...f, type })),
    [],
  );
  const setCategory = useCallback(
    (category: string | null) => setFilters((f) => ({ ...f, category })),
    [],
  );
  const setSearch = useCallback((search: string) => setFilters((f) => ({ ...f, search })), []);

  const clearAll = useCallback(
    () =>
      setFilters((f) => ({ ...f, date: null, type: 'all', category: null, search: '' })),
    [],
  );

  const hasFilters =
    !!filters.date || filters.type !== 'all' || !!filters.category || !!filters.search.trim();

  return {
    filters,
    setDate,
    shiftMonth,
    goToday,
    setType,
    setCategory,
    setSearch,
    clearAll,
    hasFilters,
  };
}
