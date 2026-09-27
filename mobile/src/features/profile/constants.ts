import type { SelectOption } from '../../components';
import {
  BUSINESS_MODEL_OPTIONS,
  INDUSTRY_OPTIONS,
  STAGE_OPTIONS,
} from '../onboarding/startup/constants';

/**
 * The Edit Profile forms, described as data.
 *
 * The web builds three `innerHTML` blocks by persona (`#editProfileForm` in
 * twin-app/js/app.js). Declaring the fields instead lets one renderer draw
 * either persona and lets the save path diff generically — which matters,
 * because the update endpoints apply `exclude_unset` and the screen must send
 * only what changed.
 *
 * Enterprise is deliberately absent. The modal has a third branch for it, but
 * no account can reach that persona: register.html offers only Individual and
 * Startup, so `POST /onboard/enterprise` is never called and the branch is
 * dead. Reproducing it would be building a journey the product does not have.
 */

export type FieldKind = 'text' | 'email' | 'phone' | 'number' | 'date' | 'select';

export interface FieldDef {
  /** The payload key — identical on both the read (`details`) and write side. */
  key: string;
  label: string;
  kind: FieldKind;
  section: string;
  options?: readonly SelectOption[];
  hint?: string;
  placeholder?: string;
}

/* --------------------------------------------------------- individual --- */

/**
 * Every field `IndividualUpdateRequest` accepts, in the web form's order.
 *
 * Goal title/target/date are here as well as in Home's goal sheet — the web
 * has the same overlap, and both write the same `profile.goal`.
 */
export const INDIVIDUAL_FIELDS: FieldDef[] = [
  { key: 'full_name', label: 'Full name', kind: 'text', section: 'About you' },
  { key: 'email', label: 'Email', kind: 'email', section: 'About you' },
  { key: 'mobile', label: 'Mobile number', kind: 'phone', section: 'About you' },
  { key: 'occupation', label: 'Occupation / role', kind: 'text', section: 'About you' },

  { key: 'monthly_income', label: 'Monthly salary / income (₹)', kind: 'number', section: 'Your money' },
  { key: 'total_savings', label: 'Total savings (₹)', kind: 'number', section: 'Your money' },
  { key: 'monthly_expenses', label: 'Monthly fixed expenses (₹)', kind: 'number', section: 'Your money' },
  { key: 'outstanding_loans', label: 'Outstanding loans (₹)', kind: 'number', section: 'Your money' },
  { key: 'existing_investments', label: 'Existing investments (₹)', kind: 'number', section: 'Your money' },
  { key: 'insurance_coverage', label: 'Insurance coverage (₹)', kind: 'number', section: 'Your money' },
  { key: 'dependents', label: 'Dependents', kind: 'number', section: 'Your money' },

  { key: 'goal_title', label: 'Goal title', kind: 'text', section: 'Your goal' },
  { key: 'goal_target_amount', label: 'Goal target amount (₹)', kind: 'number', section: 'Your goal' },
  { key: 'goal_target_date', label: 'Goal target date', kind: 'date', section: 'Your goal' },
];

/* ------------------------------------------------------------ startup --- */

/**
 * The web's fourteen fields, plus `planned_hires` and `cost_per_hire`.
 *
 * Those two are a deliberate addition. `StartupUpdateRequest` has always
 * accepted them and `GET /profile/me` has always returned them; the website's
 * edit form just never sends them, so they stay at the 0 the onboarding wizard
 * writes. With `cost_per_hire` at 0 a hire simulation computes an added cost of
 * ₹0/month, leaving burn and runway unchanged and every comparison variant
 * identical — the defect surfaced in Phase 12. Letting a founder set the figure
 * fixes it through the existing contract, with no backend change.
 *
 * Industry, business model and stage use the onboarding option sets rather than
 * the web's free-text inputs: the rest of the system treats these as
 * enumerated, and a typed-in stage is a value nothing else recognises.
 */
export const STARTUP_FIELDS: FieldDef[] = [
  { key: 'founder_name', label: 'Founder name', kind: 'text', section: 'Founder' },
  { key: 'founder_mobile', label: 'Founder mobile', kind: 'phone', section: 'Founder' },

  { key: 'company_name', label: 'Company name', kind: 'text', section: 'Company' },
  { key: 'industry', label: 'Industry', kind: 'select', section: 'Company', options: INDUSTRY_OPTIONS },
  { key: 'business_model', label: 'Business model', kind: 'select', section: 'Company', options: BUSINESS_MODEL_OPTIONS },
  { key: 'stage', label: 'Stage', kind: 'select', section: 'Company', options: STAGE_OPTIONS },
  { key: 'headcount', label: 'Headcount', kind: 'number', section: 'Company' },
  {
    key: 'gst_number',
    label: 'GST number (GSTIN)',
    kind: 'text',
    section: 'Company',
    hint: 'Optional. Checked by the server when you save.',
  },

  { key: 'monthly_revenue', label: 'Monthly revenue (₹)', kind: 'number', section: 'Financials' },
  { key: 'current_cash', label: 'Current cash (₹)', kind: 'number', section: 'Financials' },
  { key: 'fixed_costs', label: 'Fixed costs (₹)', kind: 'number', section: 'Financials' },
  { key: 'variable_costs', label: 'Variable costs (₹)', kind: 'number', section: 'Financials' },
  { key: 'total_funding', label: 'Total funding raised (₹)', kind: 'number', section: 'Financials' },
  { key: 'business_loans_debt', label: 'Debt / liabilities (₹)', kind: 'number', section: 'Financials' },

  { key: 'planned_hires', label: 'Planned hires', kind: 'number', section: 'Hiring' },
  {
    key: 'cost_per_hire',
    label: 'Cost per hire (₹/month)',
    kind: 'number',
    section: 'Hiring',
    hint: 'Fully loaded monthly cost — salary, benefits and overhead. Simulate uses this to price a hiring decision; left at 0 it assumes hires are free.',
  },
];

/** The uppercase field keys the GSTIN input should not lower-case. */
export const UPPERCASE_FIELDS = new Set(['gst_number']);

export function fieldsFor(persona: 'individual' | 'startup'): FieldDef[] {
  return persona === 'startup' ? STARTUP_FIELDS : INDIVIDUAL_FIELDS;
}

/** Section order, so the form reads top-to-bottom the way the web's rows do. */
export function sectionsOf(fields: FieldDef[]): string[] {
  const seen: string[] = [];
  for (const f of fields) if (!seen.includes(f.section)) seen.push(f.section);
  return seen;
}

/**
 * A `details` value as the form holds it — a string, so what is on screen is
 * exactly what the user typed. Coercion happens once, at save.
 */
export function toFormValue(raw: unknown, kind: FieldKind): string {
  if (raw === null || raw === undefined) return '';
  if (kind === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) return '';
    // Whole rupees read better in a form than 800000.0.
    return Number.isInteger(n) ? String(n) : String(n);
  }
  return String(raw);
}

/** Coerces one edited field back to what the update endpoint expects. */
export function toPayloadValue(value: string, kind: FieldKind): string | number | null {
  if (kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  if (kind === 'date') return value ? value : null;
  return value;
}
