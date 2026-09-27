import type { Palette } from '../../theme/tokens';

/**
 * The Startup dashboard's display vocabulary.
 *
 * Transcribed from twin-app/js/startup.js. Nothing here computes a financial
 * figure — the backend sends every number with a `display` string already
 * attached. What lives here is naming, formatting and the handful of
 * presentation thresholds the web also applies on the client.
 */

/** `suStatusLabel()` — the chip beside every metric. */
export const STATUS_LABEL: Record<string, string> = {
  actual: 'Actual',
  forecast: 'Forecast',
  estimated: 'Estimated',
  assumption: 'Assumption',
  insufficient_data: 'Insufficient data',
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** `SEVERITY_LABEL` — risk alert badges. */
export const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** The decision-outcome wording from `suDecisionCardHtml()`. */
export const DECISION_STATUS_LABEL: Record<string, string> = {
  on_track: 'Actual ≥ predicted',
  diverged: 'Actual worse than predicted',
  pending: 'Pending',
  unknown: 'Not comparable',
};

/** The four headline cards, in the web's order (`renderStartupStatGrid`). */
export const STAT_GRID_ORDER = ['cash_position', 'net_burn', 'runway', 'revenue'] as const;

/**
 * `suAbbrevINR()` — Indian abbreviations for chart axis labels.
 *
 * Cr / L / k rather than M / B, because a founder reading this reads crores.
 * Transcribed exactly, including the "drop the decimal when it divides evenly"
 * behaviour.
 */
export function abbrevINR(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(abs % 1e7 === 0 ? 0 : 1)}Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(abs % 1e5 === 0 ? 0 : 1)}L`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(0)}k`;
  return `${sign}${Math.round(abs)}`;
}

/** The web's `fmt()` — whole units with en-IN lakh/crore grouping. */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.round(n).toLocaleString('en-IN');
}

export function money(currency: string, n: number | null | undefined): string {
  return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${currency}${fmt(n)}`;
}

/* ------------------------------------------ transcribed display thresholds --
   The three judgements below live in the web's client rather than its backend.
   None computes a financial figure: each only decides a colour or whether to
   show a sentence about a value the backend already produced and classified.
   They are reproduced exactly so the two clients read the same, and they are
   gathered here so it is obvious that this is the whole of it. */

/** `suHealthColor()` — 70 / 40 cutoffs on the health score. */
export function healthColor(score: number | null | undefined, p: Palette): string {
  if (score === null || score === undefined) return p.statusNeutral;
  if (score >= 70) return p.statusGood;
  if (score >= 40) return p.statusWarning;
  return p.statusCritical;
}

/** `suIndicatorColor()` — the health indicator dot. */
export function indicatorColor(status: string, p: Palette): string {
  const map: Record<string, string> = {
    good: p.statusGood,
    warning: p.statusWarning,
    serious: p.statusSerious,
    critical: p.statusCritical,
    insufficient_data: p.statusNeutral,
  };
  return map[status] ?? p.statusNeutral;
}

/** `suGoalStatusColor()` — 70 / 35 cutoffs on goal progress. */
export function goalColor(pct: number | null | undefined, p: Palette): string {
  if (pct === null || pct === undefined) return p.statusNeutral;
  if (pct >= 70) return p.statusGood;
  if (pct >= 35) return p.statusWarning;
  return p.statusSerious;
}

/**
 * The expense-growth warning: shown only when growth is `actual` and above
 * 10%/mo. The threshold is the web's, in `renderExpenseSection()`.
 */
export function expenseGrowthWarning(
  metric: { status: string; value: number | null } | undefined,
): string | null {
  if (!metric || metric.status !== 'actual' || metric.value === null) return null;
  if (metric.value <= 10) return null;
  return `Expenses grew ${metric.value.toFixed(1)}%/mo — costs are accelerating.`;
}

/**
 * `suHealthNarrative()` — one sentence assembled from the backend's own score
 * and its own per-indicator statuses. No threshold of its own: it reports the
 * classification the server already made.
 */
export function healthNarrative(
  score: number | null | undefined,
  indicators: { label: string; status: string }[],
): string {
  if (score === null || score === undefined) {
    return 'Not enough data yet to compute a Financial Health Score — add Cash and Expenses to your profile.';
  }
  const weak = indicators
    .filter((i) => i.status === 'critical' || i.status === 'serious')
    .map((i) => i.label);
  const strong = indicators.filter((i) => i.status === 'good').map((i) => i.label);

  const parts = [`Your Financial Health Score is ${Math.round(score)}/100.`];
  if (weak.length) parts.push(`${weak.join(' and ')} ${weak.length > 1 ? 'are' : 'is'} pulling it down.`);
  if (strong.length) {
    parts.push(`${strong.join(', ')} ${strong.length > 1 ? 'are' : 'is'} in good shape.`);
  }
  return parts.join(' ');
}

/* --------------------------------------------------- categorical donut ramp --
   MoneyKal's chart ramp is a deliberate cyan-and-grey monochrome, not a
   rainbow — app-theme.css says to "keep the palette to black, white and cyan",
   and the web flattens its status colours to the accent for the same reason.
   These are the product's own six chart slots, read from the palette; no
   colour is invented here, and there is no seventh.

   The slot ORDER is theme-dependent, and that is a considered deviation from
   the web. On the light theme the ramp's two mid-cyans sit close enough in
   lightness that adjacent slices are hard to separate at donut-segment size,
   so light re-steps the same six colours into an order that puts the biggest
   lightness jumps next to each other. Dark keeps the web's order, where the
   steps are already far enough apart.

   Same palette, same data, better-separated slices — only the assignment
   order differs, and only in the theme that needs it.

   (The specific hexes are NOT restated here on purpose: they live in
   src/theme/tokens.ts as chartBlue…chartViolet and have changed once already.
   A comment quoting them goes stale silently; this one cannot.) */
export function donutPalette(p: Palette, theme: 'light' | 'dark'): string[] {
  return theme === 'dark'
    ? [p.chartBlue, p.chartOrange, p.chartAqua, p.chartYellow, p.chartMagenta, p.chartViolet]
    : [p.chartBlue, p.chartMagenta, p.chartOrange, p.chartViolet, p.chartAqua, p.chartYellow];
}

/** `svgDonutChart`'s cap: five real slices, then an "Other" bucket. */
export const DONUT_MAX_SLICES = 5;
