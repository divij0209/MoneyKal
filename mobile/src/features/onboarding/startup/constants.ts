import type { SelectOption } from '../../../components';

/**
 * The Startup wizard's option sets.
 *
 * Transcribed from the `<select>` elements in twin-app/register.html so a
 * founder is offered the same industries, models and stages on both clients —
 * and, more importantly, so the strings stored in `startup_profiles` are the
 * same strings whichever client wrote them.
 */

export const INDUSTRY_OPTIONS: readonly SelectOption[] = [
  { value: 'SaaS', label: 'SaaS / Software' },
  { value: 'Fintech', label: 'Fintech' },
  { value: 'Healthtech', label: 'Healthtech' },
  { value: 'E-commerce', label: 'E-commerce' },
  { value: 'Deeptech', label: 'Deeptech' },
  { value: 'Other', label: 'Other' },
];

export const BUSINESS_MODEL_OPTIONS: readonly SelectOption[] = [
  { value: 'B2B', label: 'B2B' },
  { value: 'B2C', label: 'B2C' },
  { value: 'B2B2C', label: 'B2B2C' },
  { value: 'Marketplace', label: 'Marketplace' },
];

export const STAGE_OPTIONS: readonly SelectOption[] = [
  { value: 'Pre-Seed', label: 'Pre-Seed' },
  { value: 'Seed', label: 'Seed' },
  { value: 'Series A', label: 'Series A' },
  { value: 'Series B+', label: 'Series B+' },
  { value: 'Bootstrapped', label: 'Bootstrapped' },
];
