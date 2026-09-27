import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, onboardingApi } from '../../../api';
import type { ExtractedFinancials } from '../../../api/endpoints/onboarding';
import { useAuth } from '../../../store';
import {
  EMPTY_INDIVIDUAL,
  clearDraft,
  loadDraft,
  saveDraft,
  type IndividualDraft,
} from '../draft';

export const STEP_COUNT = 3;

export const STEP_LABELS = ['About you', 'Your money', 'Your goal'] as const;

/** Required fields per step, mirroring the web form's `required` attributes:
 *  income, savings, expenses and loans are required; everything else optional. */
const REQUIRED_BY_STEP: Record<number, (keyof IndividualDraft)[]> = {
  0: [],
  1: ['monthlyIncome', 'totalSavings', 'monthlyExpenses', 'outstandingLoans'],
  2: [],
};

export type FieldErrors = Partial<Record<keyof IndividualDraft, string>>;

/** A number the backend will accept: finite, not negative. Empty is treated as
 *  0 for the optional fields, matching the web's `Number(value || 0)`. */
function toNumber(raw: string): number {
  const n = Number((raw ?? '').toString().trim());
  return Number.isFinite(n) ? n : NaN;
}

const FIELD_LABELS: Partial<Record<keyof IndividualDraft, string>> = {
  monthlyIncome: 'Monthly income',
  totalSavings: 'Total savings',
  monthlyExpenses: 'Monthly expenses',
  outstandingLoans: 'Outstanding loans',
  existingInvestments: 'Existing investments',
  insuranceCoverage: 'Insurance coverage',
  dependents: 'Dependents',
  goalTargetAmount: 'Goal target amount',
};

const NUMERIC_FIELDS: (keyof IndividualDraft)[] = [
  'monthlyIncome',
  'totalSavings',
  'monthlyExpenses',
  'outstandingLoans',
  'existingInvestments',
  'insuranceCoverage',
  'dependents',
  'goalTargetAmount',
];

/**
 * The Individual onboarding wizard's state.
 *
 * Holds every answer in one object so moving between steps never loses input,
 * and mirrors it into the SecureStore draft so closing the app doesn't either.
 * No financial computation happens here — the fields are collected, coerced to
 * numbers once, and posted to /onboard/confirm, which owns everything after.
 */
export function useIndividualOnboarding() {
  const { session, setProfileKey } = useAuth();

  const [values, setValues] = useState<IndividualDraft>({ ...EMPTY_INDIVIDUAL });
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const fullName = useRef<string | null>(null);

  // Restore a draft, so a killed app resumes where it left off — the same
  // behaviour the web gets from twin_onboarding_state.
  useEffect(() => {
    let cancelled = false;
    loadDraft().then((draft) => {
      if (cancelled) return;
      setValues({ ...EMPTY_INDIVIDUAL, ...draft.individual });
      setStep(Math.min(draft.individualStep ?? 0, STEP_COUNT - 1));
      fullName.current = draft.fullName;
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Persist quietly. Failures are already swallowed inside saveDraft — on web
   *  SecureStore has no implementation, and losing a draft must never block
   *  someone from finishing onboarding. */
  const persist = useCallback((next: IndividualDraft, nextStep: number) => {
    void saveDraft({ individual: next, individualStep: nextStep });
  }, []);

  const setField = useCallback(
    (field: keyof IndividualDraft, value: string | null) => {
      setValues((prev) => {
        const next = { ...prev, [field]: value } as IndividualDraft;
        persist(next, step);
        return next;
      });
      // Clear the field's error as soon as the user edits it, rather than
      // making them re-submit to find out it is fixed.
      setErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
      setSubmitError(null);
    },
    [persist, step],
  );

  /** Bulk-apply an AI extraction. Only fields the extractor actually returned
   *  are touched, so a partial result never blanks something already typed. */
  const applyExtracted = useCallback(
    (data: ExtractedFinancials) => {
      setValues((prev) => {
        const next = { ...prev };
        if (typeof data.salary === 'number') next.monthlyIncome = String(data.salary);
        if (typeof data.savings === 'number') next.totalSavings = String(data.savings);
        if (typeof data.loans === 'number') next.outstandingLoans = String(data.loans);
        if (data.expenses && typeof data.expenses === 'object') {
          // Both /onboard/chat and /onboard/parse-statement return expenses
          // split into food/rent/emi/shopping/others, while /onboard/confirm
          // takes a single monthly_expenses. Summing the categories is the
          // bridge between the two schemas — the totals are the backend's own
          // figures, not a model of anything.
          const total = Object.values(data.expenses).reduce<number>(
            (sum, v) => sum + (typeof v === 'number' && Number.isFinite(v) ? v : 0),
            0,
          );
          if (total > 0) next.monthlyExpenses = String(total);
        }
        persist(next, step);
        return next;
      });
      setErrors({});
      setSubmitError(null);
    },
    [persist, step],
  );

  /** Validates one step. Returns true when it may be left. */
  const validateStep = useCallback(
    (index: number): boolean => {
      const found: FieldErrors = {};

      for (const field of REQUIRED_BY_STEP[index] ?? []) {
        const raw = (values[field] ?? '').toString().trim();
        if (!raw) {
          found[field] = `${FIELD_LABELS[field] ?? 'This field'} is required.`;
          continue;
        }
        const n = toNumber(raw);
        if (Number.isNaN(n)) found[field] = 'Enter a number.';
        else if (n < 0) found[field] = "This can't be negative.";
      }

      // Any numeric field on this step that was filled in must still be valid,
      // required or not.
      for (const field of NUMERIC_FIELDS) {
        if (found[field]) continue;
        const raw = (values[field] ?? '').toString().trim();
        if (!raw) continue;
        const n = toNumber(raw);
        if (Number.isNaN(n)) found[field] = 'Enter a number.';
        else if (n < 0) found[field] = "This can't be negative.";
      }

      setErrors(found);
      return Object.keys(found).length === 0;
    },
    [values],
  );

  const goNext = useCallback(() => {
    if (!validateStep(step)) return false;
    const next = Math.min(step + 1, STEP_COUNT - 1);
    setStep(next);
    persist(values, next);
    return true;
  }, [step, validateStep, persist, values]);

  const goBack = useCallback(() => {
    // Never validates: going back must not be blocked by an incomplete field,
    // and nothing is lost because every answer lives in `values`.
    const prev = Math.max(step - 1, 0);
    setStep(prev);
    setErrors({});
    setSubmitError(null);
    persist(values, prev);
    return prev;
  }, [step, persist, values]);

  /** Builds the /onboard/confirm payload. Optional numerics fall back to 0,
   *  matching the web's `Number(el.value || 0)`. */
  const buildPayload = useCallback((): onboardingApi.IndividualOnboardingPayload => {
    const num = (raw: string) => {
      const n = toNumber(raw);
      return Number.isNaN(n) ? 0 : n;
    };

    return {
      full_name: fullName.current || session?.username || '',
      email: session?.username || '',
      mobile: values.mobile.trim(),
      occupation: values.occupation.trim(),
      monthly_income: num(values.monthlyIncome),
      total_savings: num(values.totalSavings),
      monthly_expenses: num(values.monthlyExpenses),
      outstanding_loans: num(values.outstandingLoans),
      existing_investments: num(values.existingInvestments),
      insurance_coverage: num(values.insuranceCoverage),
      dependents: Math.round(num(values.dependents)),
      // The backend defaults this itself, but sending the same fallback the web
      // sends keeps one behaviour across clients.
      goal_title: values.goalTitle.trim() || 'Financial Independence',
      goal_target_amount: num(values.goalTargetAmount),
      goal_target_date: values.goalTargetDate || null,
    };
  }, [values, session]);

  /**
   * Posts to /onboard/confirm and, on success, flips the session's profile key.
   *
   * That flip is what moves RootNavigator from the Onboarding stack to the
   * persona app — the same branch the web takes when it sets
   * sess.profileKey = 'individual' and redirects to the dashboard.
   */
  const submit = useCallback(async (): Promise<boolean> => {
    // Validate every step, not just the last: a user can reach step 3 with an
    // earlier field cleared afterwards.
    for (let i = 0; i < STEP_COUNT; i++) {
      if (!validateStep(i)) {
        setStep(i);
        setSubmitError('Some details still need fixing.');
        return false;
      }
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await onboardingApi.confirmIndividual(buildPayload());
      await clearDraft();
      await setProfileKey(res.profile_key || 'individual');
      return true;
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.detail
          : 'Could not save your details. Please try again.',
      );
      if (__DEV__ && !(err instanceof ApiError)) {
        console.warn('[MoneyKal] Onboarding submit failed for a non-API reason:', err);
      }
      setSubmitting(false);
      return false;
    }
  }, [validateStep, buildPayload, setProfileKey]);

  return {
    values,
    setField,
    applyExtracted,
    step,
    setStep,
    errors,
    submitError,
    setSubmitError,
    submitting,
    hydrated,
    goNext,
    goBack,
    submit,
    stepLabel: STEP_LABELS[step],
  };
}
