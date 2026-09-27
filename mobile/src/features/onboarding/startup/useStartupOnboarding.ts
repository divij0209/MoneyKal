import { useCallback, useEffect, useState } from 'react';

import { ApiError, onboardingApi } from '../../../api';
import type { StartupOnboardingPayload } from '../../../api/endpoints/onboarding';
import { useAuth } from '../../../store';
import { EMPTY_STARTUP, clearDraft, loadDraft, saveDraft, type StartupDraft } from '../draft';

/**
 * The Startup wizard's state.
 *
 * Two forms and one choice, submitted as a single POST /onboard/startup at the
 * end — the same shape as the web, which holds steps 3 and 4 in
 * `localStorage.twin_onboarding_state` and only calls the API from step 5.
 * Nothing is computed here: every figure is passed through as typed, and every
 * metric a founder sees afterwards is the backend's.
 */

export type StartupField = keyof StartupDraft;
export type StartupErrors = Partial<Record<StartupField, string>>;

/** Mirrors the `required` attributes on the web's two startup forms. */
const REQUIRED_PROFILE: StartupField[] = [
  'companyName',
  'industry',
  'businessModel',
  'stage',
  'headcount',
];
const REQUIRED_FINANCIAL: StartupField[] = [
  'currentCash',
  'monthlyRevenue',
  'monthlyBurn',
  'totalFunding',
  'debt',
];

const LABELS: Record<StartupField, string> = {
  companyName: 'Startup name',
  industry: 'Industry',
  businessModel: 'Business model',
  stage: 'Startup stage',
  headcount: 'Team size',
  gstNumber: 'GST number',
  currentCash: 'Current cash in bank',
  monthlyRevenue: 'Monthly revenue',
  monthlyBurn: 'Monthly expenses / burn',
  totalFunding: 'Total funding raised',
  debt: 'Debt / liabilities',
};

const NUMERIC: StartupField[] = [
  'headcount',
  'currentCash',
  'monthlyRevenue',
  'monthlyBurn',
  'totalFunding',
  'debt',
];

function num(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function useStartupOnboarding() {
  const { setProfileKey } = useAuth();

  const [values, setValues] = useState<StartupDraft>({ ...EMPTY_STARTUP });
  const [errors, setErrors] = useState<StartupErrors>({});
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  /* Restore whatever the founder had already typed. The draft survives an app
     kill, so closing the app on step 5 does not mean retyping step 3. */
  useEffect(() => {
    let alive = true;
    loadDraft().then((d) => {
      if (!alive) return;
      setValues({ ...EMPTY_STARTUP, ...d.startup });
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const setField = useCallback((field: StartupField, value: string) => {
    setValues((prev) => {
      const next = { ...prev, [field]: value };
      // Persisted as typed, so a restored draft shows the same characters.
      void saveDraft({ startup: next });
      return next;
    });
    setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }, []);

  /** Validates one of the two forms. Returns true when it may be left. */
  const validate = useCallback(
    (which: 'profile' | 'financial') => {
      const required = which === 'profile' ? REQUIRED_PROFILE : REQUIRED_FINANCIAL;
      const next: StartupErrors = {};

      for (const field of required) {
        const raw = (values[field] ?? '').trim();
        if (!raw) {
          next[field] = `${LABELS[field]} is required.`;
          continue;
        }
        if (NUMERIC.includes(field)) {
          const n = Number(raw);
          if (!Number.isFinite(n)) next[field] = `${LABELS[field]} must be a number.`;
          // The web's inputs carry min="0" (min="1" on headcount).
          else if (field === 'headcount' && n < 1) next[field] = 'Team size must be at least 1.';
          else if (n < 0) next[field] = `${LABELS[field]} cannot be negative.`;
        }
      }

      setErrors(next);
      return Object.keys(next).length === 0;
    },
    [values],
  );

  /**
   * The payload, assembled exactly as twin-app/js/auth.js assembles it.
   *
   * The constants below are the web's, not inventions, and they are reproduced
   * rather than improved so a startup onboarded from a phone is stored
   * identically to one onboarded from a browser:
   *
   *   - `founder` is hardcoded. The wizard never asks for it on either client.
   *   - `is_pre_revenue` is derived from monthly revenue being zero.
   *   - `fixed_costs` takes the whole burn and `variable_costs` is 0; the web
   *     comments this as "Assumed as total for simplification".
   *   - `founded_year` is the current year, and location/website are blank.
   *   - revenue streams, goals and the current decision are left empty.
   */
  const buildPayload = useCallback(
    (): StartupOnboardingPayload => ({
      founder: { name: 'Founder', email: '', mobile: '', preferred_language: 'English' },
      company: {
        name: values.companyName.trim() || 'My Startup',
        industry: values.industry || '',
        business_model: values.businessModel || '',
        founded_year: new Date().getFullYear(),
        stage: values.stage || '',
        location: '',
        website: '',
        headcount: num(values.headcount) || 1,
        gst_number: values.gstNumber.trim() ? values.gstNumber.trim() : null,
      },
      revenue: {
        is_pre_revenue: num(values.monthlyRevenue) === 0,
        monthly_revenue: num(values.monthlyRevenue),
        revenue_streams: [],
        revenue_growth_pct: null,
        paying_customers: 0,
      },
      expenses: { fixed_costs: num(values.monthlyBurn), variable_costs: 0 },
      cash: { current_cash: num(values.currentCash), monthly_burn: num(values.monthlyBurn) },
      debt: { business_loans_debt: num(values.debt) },
      funding: {
        total_funding: num(values.totalFunding),
        last_round: '',
        currently_fundraising: false,
        fundraising_target: null,
      },
      team: { planned_hires: 0, cost_per_hire: 0 },
      goals: [],
      current_decision: '',
    }),
    [values],
  );

  /**
   * Creates the Startup Financial Twin.
   *
   * On success the profile key is set to 'startup', which is what moves the
   * root navigator out of onboarding and into the Startup tabs — the same
   * thing the web does when it writes `sess.profileKey = 'startup'`.
   */
  const submit = useCallback(async (): Promise<boolean> => {
    if (!validate('financial')) return false;

    setSubmitting(true);
    setSubmitError(null);
    try {
      await onboardingApi.onboardStartup(buildPayload());
      await clearDraft();
      await setProfileKey('startup');
      return true;
    } catch (err) {
      // A bad GSTIN comes back as a 400 naming the expected format; showing the
      // backend's wording keeps one source of truth for what is valid.
      setSubmitError(
        err instanceof ApiError
          ? err.detail
          : 'Could not create your Financial Twin. Please try again.',
      );
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Startup onboarding failed for a non-API reason:', err);
      }
      setSubmitting(false);
      return false;
    }
  }, [validate, buildPayload, setProfileKey]);

  return {
    values,
    errors,
    loaded,
    submitting,
    submitError,
    setField,
    validate,
    submit,
  };
}
