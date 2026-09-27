import type { Transaction } from '../../api/types';

/**
 * Hisaab's vocabulary and display rules.
 *
 * SOURCE OF TRUTH: twin-app/js/startup.js.
 *
 * The category lists are a frontend constant on the web too — the API neither
 * sends nor validates them (the backend stores whatever string it is given and
 * falls back to "Uncategorized"). The same list is repeated inside the receipt
 * scan prompt in backend/routers/hisaab.py, which is what constrains the
 * category a scan can return, so these two must stay in agreement.
 */
export const HISAAB_CATEGORIES = {
  in: [
    'Salary',
    'Freelance / Business',
    'Investment Return',
    'Revenue',
    'Funding',
    'Refund',
    'Gift',
    'Interest income',
    'Other income',
  ],
  out: [
    'Rent / Housing',
    'Groceries',
    'Food & Dining',
    'Utilities & Bills',
    'Shopping',
    'Entertainment',
    'Travel & Transport',
    'Health & Medical',
    'Subscriptions',
    'Payroll',
    'Software/Tools',
    'Marketing',
    'Supplies',
    'Professional fees',
    'Taxes',
    'Other expense',
  ],
} as const;

export type TxnType = 'in' | 'out';

/**
 * Strips the Gmail tracking suffix the auto-importer appends.
 *
 * `run_sync_for_connection` writes `"<description> [gmail_id=<id>]"` and uses
 * that suffix to dedupe on re-sync, so it must stay in the stored value and be
 * hidden only at render. Same regex as the web's cleanTxnDescription().
 */
export function cleanTxnDescription(desc?: string | null): string {
  return (desc || '').replace(/\s*\[gmail_id=[^\]]*\]\s*$/, '').trim();
}

/**
 * Formats a Hisaab amount.
 *
 * Unlike /home, this endpoint returns raw numbers — there are no `*_display`
 * fields to render, so formatting has to happen here. This is deliberately the
 * web's `fmt()` exactly: round to whole rupees, then en-IN grouping (which
 * gives the Indian lakh/crore digit grouping, e.g. 2,51,000). Prefixing the
 * currency the API returned rather than a hardcoded symbol.
 */
export function formatAmount(value: number | null | undefined, currency = '₹'): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `${currency}0`;
  return `${currency}${Math.round(n).toLocaleString('en-IN')}`;
}

/** Signed for a ledger row: +in, −out, matching the web's row rendering. */
export function formatSigned(txn: Transaction, currency = '₹'): string {
  return `${txn.type === 'in' ? '+' : '−'}${formatAmount(txn.amount, currency)}`;
}

/**
 * A YYYY-MM-DD key formatted for display without Date parsing of the string
 * itself, which would shift the day across timezones. Same approach and same
 * en-IN options as the web's hisaabPrettyDate().
 */
export function prettyDate(key?: string | null): string {
  const [y, m, d] = (key || '').split('-').map(Number);
  if (!y || !m || !d) return key || '';
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Local YYYY-MM-DD. Never toISOString(), which converts to UTC. */
export function dateKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** Heading for a day group: "Today" / "Yesterday" / the pretty date. */
export function dayHeading(key: string, today = dateKey()): string {
  if (key === today) return 'Today';
  const [y, m, d] = key.split('-').map(Number);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dateKey(yesterday)) return 'Yesterday';
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * Activity per day, for the calendar.
 *
 * Built from the transactions already returned by GET /startup/hisaab — the
 * same thing the web's Overview calendar does (buildActivityIndex), and the
 * reason paging months costs no requests.
 */
export interface DayActivity {
  count: number;
  in: number;
  out: number;
}

export function buildActivityIndex(txns: Transaction[]): Map<string, DayActivity> {
  const index = new Map<string, DayActivity>();
  for (const t of txns) {
    if (!t.txn_date) continue;
    const e = index.get(t.txn_date) ?? { count: 0, in: 0, out: 0 };
    e.count += 1;
    if (t.type === 'in') e.in += t.amount;
    else e.out += t.amount;
    index.set(t.txn_date, e);
  }
  return index;
}

/** 0-3 density bucket, matching the web's activityLevel(). */
export function activityLevel(count: number): 0 | 1 | 2 | 3 {
  if (!count) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  return 3;
}

/**
 * The amount a scanned receipt implies.
 *
 * Reproduces the web's precedence exactly: the explicit total if the model
 * read one, otherwise the items summed plus tax. This is arithmetic over
 * figures the backend extracted, not an interpretation of the receipt — the
 * reading itself happened server-side.
 */
export function receiptAmount(scan: {
  total?: number | null;
  items?: { amount?: number }[];
  tax_amount?: number | null;
}): number | null {
  if (typeof scan.total === 'number' && Number.isFinite(scan.total) && scan.total > 0) {
    return scan.total;
  }
  const items = scan.items ?? [];
  if (!items.length) return null;
  const subtotal = items.reduce((sum, i) => sum + (Number(i.amount) || 0), 0);
  const tax = Number(scan.tax_amount) || 0;
  const total = subtotal + tax;
  return total > 0 ? total : null;
}
