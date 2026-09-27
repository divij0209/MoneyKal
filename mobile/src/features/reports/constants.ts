/**
 * Reports formatting.
 *
 * Transcribed from the report renderers in twin-app/js/startup.js so the two
 * clients print the same figures the same way. Nothing here computes anything.
 */

/** The web's `fmt()`: round to whole units, then en-IN lakh/crore grouping. */
export function money(value: number | null | undefined, currency = '₹'): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${currency}${Math.round(n).toLocaleString('en-IN')}`;
}

/** "5.2 mo" / "—", as the weekly health rows render runway. */
export function months(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(1)} mo`;
}

/** A health score, printed whole. */
export function score(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(0);
}

/**
 * "31 Aug 2026 – 6 Sep 2026" — the web's `suFormatDateRange()`.
 *
 * The date parts are pulled apart and rebuilt as a local Date rather than
 * handed to `new Date('2026-08-31')`, which the web does. That string parses as
 * UTC midnight, so west of Greenwich it renders as the previous day. The web
 * gets away with it because its users are in IST; doing it properly here
 * produces the same string everywhere, which is what the web intended. The
 * same approach is already used for date keys in features/hisaab/constants.ts.
 */
export function formatDateRange(startIso: string, endIso: string): string {
  return `${formatIsoDay(startIso)} – ${formatIsoDay(endIso)}`;
}

export function formatIsoDay(iso: string): string {
  const [y, m, d] = (iso || '').split('-').map(Number);
  if (!y || !m || !d) return iso || '—';
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * "31 Aug 2026, 06:51 pm" — the report card's "Generated" stamp.
 *
 * `created_at` is a real timestamp rather than a date key, so ordinary Date
 * parsing is correct here.
 */
export function formatGeneratedAt(iso: string | null | undefined): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "+12% vs last week" / "-100% vs last week", or null when unknown. */
export function pctChangeLabel(pct: number | null | undefined, suffix = ' vs last week'): string | null {
  if (pct === null || pct === undefined) return null;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(0)}%${suffix}`;
}

/**
 * The week-over-week line on the health report: "Health +1.2 · Runway +0.4 mo
 * · Cash +₹12,000". Built in the web's order, omitting any delta the backend
 * left null.
 */
export function weekOverWeekBits(r: {
  health_delta?: number | null;
  runway_delta?: number | null;
  cash_delta?: number | null;
}): string[] {
  const bits: string[] = [];
  const sign = (n: number) => (n >= 0 ? '+' : '');
  if (r.health_delta !== null && r.health_delta !== undefined) {
    bits.push(`Health ${sign(r.health_delta)}${r.health_delta.toFixed(1)}`);
  }
  if (r.runway_delta !== null && r.runway_delta !== undefined) {
    bits.push(`Runway ${sign(r.runway_delta)}${r.runway_delta.toFixed(1)} mo`);
  }
  if (r.cash_delta !== null && r.cash_delta !== undefined) {
    bits.push(`Cash ${sign(r.cash_delta)}₹${Math.round(r.cash_delta).toLocaleString('en-IN')}`);
  }
  return bits;
}
