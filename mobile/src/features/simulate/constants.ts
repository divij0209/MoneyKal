/**
 * Simulate's display vocabulary.
 *
 * Every value here is transcribed from twin-app/js/app.js so the two clients
 * name and format the same figures identically. Nothing in this file computes
 * anything: the backend returns the numbers, and these turn a snake_case key
 * into a label and a bare number into a string. Where a key is unknown the
 * fallbacks degrade to something readable rather than to a blank.
 */

/** Verbatim from `SCENARIO_SUGGESTIONS` in twin-app/js/app.js. */
export const SCENARIO_SUGGESTIONS = [
  'What happens if I invest ₹20,000 every month for 3 years?',
  'Can I afford a ₹50,000 EMI?',
  'What if I increase my monthly savings by ₹10,000?',
  'How quickly can I reach my savings goal?',
  'What happens if I have no income for 6 months?',
] as const;

/**
 * The six agents, from `AGENTS` in twin-app/js/data.js.
 *
 * `agent` matches the `stages[].agent` string the backend sends, which is what
 * the web's STAGE_ID_MAP keys off to light each row up.
 */
export const AGENTS = [
  { agent: 'Understand', name: 'Understand', desc: 'Pulls in and cleans up the user’s financial data.' },
  { agent: 'Watch', name: 'Watch', desc: 'Constantly checks for risk — low cash, bad debt, fraud, FX exposure.' },
  { agent: 'Simulate', name: 'Simulate', desc: 'Runs “what-if” tests on the digital twin.' },
  { agent: 'Recommend', name: 'Recommend', desc: 'Picks the best option based on the simulation results.' },
  { agent: 'Teach', name: 'Teach', desc: 'Explains the recommendation in plain language.' },
  { agent: 'Check', name: 'Check', desc: 'Confirms it’s compliant, and explains why the call was made.' },
] as const;

export type AgentName = (typeof AGENTS)[number]['agent'];

/** Verbatim from `IMPACT_LABELS` in twin-app/js/app.js. */
export const IMPACT_LABELS: Record<string, string> = {
  monthly_surplus_before: 'Monthly surplus — before',
  monthly_surplus_after: 'Monthly surplus — after',
  savings_impact: 'Savings impact',
  emergency_buffer_before_months: 'Emergency buffer — before',
  emergency_buffer_after_months: 'Emergency buffer — after',
  goal_progress_before_pct: 'Goal progress — before',
  goal_progress_after_pct: 'Goal progress — after',
  investment_contribution: 'Monthly investment contribution',
  foir_pct: 'Fixed-obligation ratio (FOIR)',
  affordability_verdict: 'Affordability verdict',
  goal_months_remaining_before: 'Months to goal — before',
  goal_months_remaining_after: 'Months to goal — after',
  coverage_months: 'Emergency coverage',
  requested_months: 'Months without income',
  goal_title: 'Goal',
  goal_target: 'Goal target',
  monthly_contribution_rate: 'Monthly contribution rate',
  months_to_goal: 'Months to reach goal',
  projected_savings: 'Projected savings',
  projected_value: 'Projected value',
  invested_total: 'Total invested',
  estimated_gain: 'Estimated gain',
  savings_before: 'Savings — no change',
  savings_after: 'Savings — with change',
  extra_saved: 'Extra saved',
  remaining_savings: 'Remaining savings',
  shortfall: 'Shortfall',
  amount_saved: 'Amount saved',
  emergency_buffer_months: 'Emergency buffer',
  goal_progress_pct: 'Goal progress',
  lumpsum_invested: 'Lump sum invested',
  liquid_savings_before: 'Liquid savings — before',
  liquid_savings_after: 'Liquid savings — after',
  projected_value_at_horizon: 'Projected value at horizon',
  estimated_gain_at_horizon: 'Estimated gain at horizon',
  assumed_annual_return_pct: 'Assumed annual return',
  note: 'Note',
};

/*
 * Note on what is deliberately absent.
 *
 * The informational snapshot returns monthly_income, monthly_expenses,
 * monthly_surplus and total_savings, and it is tempting to add friendly labels
 * for them. The web has none, so they fall through to humanizeKey's generic
 * title-casing and render as "Monthly Income" and "Total Savings". Adding them
 * here produced "Monthly income" and "Total savings" — the two clients then
 * label the same figure differently, which is exactly the drift this file
 * exists to prevent. If these want nicer labels, they should be added to
 * twin-app/js/app.js first and transcribed back.
 */

/** `humanizeKey()` in twin-app/js/app.js. */
export function humanizeKey(key: string): string {
  return (
    IMPACT_LABELS[key] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/**
 * `formatImpactValue()` in twin-app/js/app.js, branch for branch.
 *
 * The order of the tests matters and is preserved: a key containing "pct" is a
 * percentage even though it is also a number, and the currency fallback is
 * last. `fmt()` on the web is round-then-en-IN-group, which produces Indian
 * lakh/crore digit grouping (2,51,000) rather than thousands.
 */
export function formatImpactValue(key: string, value: unknown, currency: string): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return String(value);

  if (key.includes('pct') || key === 'foir_pct') return `${value}%`;
  if (key.includes('months') || key.startsWith('runway')) return `${value} mo`;
  if (key.startsWith('financial_health')) return `${value}/100`;
  if (key === 'headcount_added' || key === 'headcount') return `${value}`;

  return `${currency}${Math.round(value).toLocaleString('en-IN')}`;
}

/**
 * The impact entries the tile grid shows.
 *
 * The web filters out nulls and objects before rendering — objects because
 * `goal_impact` is an array that gets its own section, and would otherwise
 * stringify into a tile as "[object Object]".
 */
export function impactEntries(
  impact: Record<string, unknown> | null | undefined,
): [string, unknown][] {
  if (!impact) return [];
  return Object.entries(impact).filter(
    ([, v]) => v !== null && v !== undefined && typeof v !== 'object',
  );
}

/** One row of `financial_impact.goal_impact`, when the scenario touches goals. */
export interface GoalImpact {
  label: string;
  progress_before_pct?: number | null;
  progress_after_pct?: number | null;
}

export function goalImpacts(impact: Record<string, unknown> | null | undefined): GoalImpact[] {
  const raw = impact?.goal_impact;
  return Array.isArray(raw) ? (raw as GoalImpact[]) : [];
}

/** "72%" / "—", as the web renders each side of the before → after pair. */
export function goalPct(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${value.toFixed(0)}%`;
}

/**
 * A timeline entry's detail rows: everything except the two fields the header
 * already shows. Mirrors `timelineDetail()` on the web.
 */
export function timelineDetail(entry: Record<string, unknown>): [string, unknown][] {
  return Object.entries(entry).filter(([k]) => k !== 'label' && k !== 'months');
}

/** `income_loss` -> `income loss`, the web's tag text in the history list. */
export function prettyScenarioType(type: string): string {
  return (type || '').replace(/_/g, ' ');
}

/* ------------------------------------------------------------- startup --- */

/** Verbatim from `STARTUP_SCENARIO_SUGGESTIONS` in twin-app/js/startup.js. */
export const STARTUP_SCENARIO_SUGGESTIONS = [
  'What happens if I hire 5 engineers?',
  'What if I raise ₹2 Cr?',
  'What happens if I increase marketing spend by 20%?',
  'What if my revenue drops by 15%?',
  'What if I cut costs by ₹1,00,000/month?',
] as const;

/**
 * The sentinel the backend returns when nothing was flagged.
 *
 * The Startup renderer filters it out of the risks list and counts risks
 * around it, exactly as `renderStartupSimulationResult()` does — otherwise
 * "no risks" would render as one risk.
 */
export const NO_MATERIAL_RISKS = 'No material risks identified from the available data.';

export function materialRisks(risks: string[] | undefined): string[] {
  return (risks ?? []).filter((r) => r !== NO_MATERIAL_RISKS);
}

/**
 * `suDeltaClass()` — whether a change is an improvement.
 *
 * `goodDirection` is per-metric: cash and runway are better up, burn is better
 * down. Presentation only; both numbers come from the backend.
 */
export type DeltaTone = 'good' | 'bad' | 'flat';

export function deltaTone(
  before: number | null | undefined,
  after: number | null | undefined,
  goodDirection: 'up' | 'down',
): DeltaTone {
  if (before === null || before === undefined || after === null || after === undefined) return 'flat';
  const diff = after - before;
  if (Math.abs(diff) < 1e-9) return 'flat';
  return (goodDirection === 'up' ? diff > 0 : diff < 0) ? 'good' : 'bad';
}

/** `suMainBenefit()` — the first true improvement, in the web's order. */
export function mainBenefit(
  impact: Record<string, unknown>,
  currency: string,
): string {
  const n = (k: string) => (typeof impact[k] === 'number' ? (impact[k] as number) : null);
  const rb = n('runway_before'), ra = n('runway_after');
  if (rb !== null && ra !== null && ra > rb) {
    return `Runway extends by ${(ra - rb).toFixed(1)} months.`;
  }
  const hb = n('financial_health_before'), ha = n('financial_health_after');
  if (hb !== null && ha !== null && ha > hb) {
    return `Financial Health improves by ${(ha - hb).toFixed(0)} points.`;
  }
  const cb = n('cash_before'), ca = n('cash_after');
  if (cb !== null && ca !== null && ca > cb) {
    return `Cash position increases by ${currency}${Math.round(ca - cb).toLocaleString('en-IN')}.`;
  }
  return 'See the recommendation above.';
}

/** `suRecommendationCardHtml()`'s "Main risk" line. */
export function mainRisk(risks: string[] | undefined): string {
  const first = risks?.[0];
  return first && first !== NO_MATERIAL_RISKS
    ? first
    : 'No material risk identified from the available data.';
}
