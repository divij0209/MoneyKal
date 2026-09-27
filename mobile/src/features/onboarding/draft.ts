import * as SecureStore from 'expo-secure-store';

import type { PersonaKey } from '../../api/types';

/**
 * Onboarding draft.
 *
 * The web keeps the half-finished wizard in `localStorage.twin_onboarding_state`
 * (twin-app/js/auth.js) so a reload resumes where the user left off. This is
 * the same idea: the account type is chosen before the account exists, and the
 * full name is collected at the credentials step but not sent until the
 * profile step, so both have to survive between screens — and between app
 * launches, since `profile_key` stays null until onboarding completes.
 */

const DRAFT_KEY = 'moneykal_onboarding_draft';

/**
 * The Individual form, held as strings.
 *
 * Strings rather than numbers on purpose: these are exactly what the user has
 * typed, including a half-finished "12" or an empty field. Coercion to numbers
 * happens once, at submit, so a restored draft shows the same characters the
 * user left behind rather than a normalised version of them.
 */
export interface IndividualDraft {
  occupation: string;
  mobile: string;
  monthlyIncome: string;
  totalSavings: string;
  monthlyExpenses: string;
  outstandingLoans: string;
  existingInvestments: string;
  insuranceCoverage: string;
  dependents: string;
  goalTitle: string;
  goalTargetAmount: string;
  goalTargetDate: string | null;
}

export const EMPTY_INDIVIDUAL: IndividualDraft = {
  occupation: '',
  mobile: '',
  monthlyIncome: '',
  totalSavings: '',
  monthlyExpenses: '',
  // The web pre-fills these four with 0 (value="0" on the inputs), so a user
  // with no loans, investments, insurance or dependents can submit untouched.
  outstandingLoans: '0',
  existingInvestments: '0',
  insuranceCoverage: '0',
  dependents: '0',
  goalTitle: '',
  goalTargetAmount: '',
  goalTargetDate: null,
};

/**
 * The Startup form, held as strings for the same reason the Individual one is.
 *
 * Ten fields, which is exactly what the web's wizard collects across steps 3
 * and 5 — not the whole of `StartupOnboardingRequest`. The rest of that schema
 * (founder details, revenue streams, goals, planned hires) is filled with the
 * same constants twin-app/js/auth.js uses at submit time.
 */
export interface StartupDraft {
  /* Step 3 — Startup Profile */
  companyName: string;
  industry: string;
  businessModel: string;
  stage: string;
  headcount: string;
  gstNumber: string;
  /* Step 5 — Financial details */
  currentCash: string;
  monthlyRevenue: string;
  monthlyBurn: string;
  totalFunding: string;
  debt: string;
}

export const EMPTY_STARTUP: StartupDraft = {
  companyName: '',
  industry: '',
  businessModel: '',
  stage: '',
  headcount: '',
  gstNumber: '',
  currentCash: '',
  monthlyRevenue: '',
  monthlyBurn: '',
  totalFunding: '',
  // The web pre-fills debt with 0 (value="0"), so a startup with none can
  // submit without touching it.
  debt: '0',
};

export interface OnboardingDraft {
  accountType: PersonaKey | null;
  fullName: string | null;
  /** Startup only: 'zoho' | 'manual', from step 4 of the web wizard. */
  financialSetup: 'zoho' | 'manual' | null;
  /** The Individual wizard's in-progress answers. */
  individual: IndividualDraft;
  /** Which wizard step the user had reached, so a restart resumes there. */
  individualStep: number;
  /** The Startup wizard's in-progress answers. */
  startup: StartupDraft;
}

const EMPTY: OnboardingDraft = {
  accountType: null,
  fullName: null,
  financialSetup: null,
  individual: { ...EMPTY_INDIVIDUAL },
  individualStep: 0,
  startup: { ...EMPTY_STARTUP },
};

/**
 * In-memory mirror of the draft.
 *
 * SecureStore has no web implementation, so on Expo Web every write is a no-op
 * and every read comes back empty. Without this, the full name collected at
 * registration would be gone by the time the profile step needs it for
 * `full_name`, and the dashboard would greet the user by their email address.
 *
 * It also covers a native keychain failure for the length of one app session.
 * It is a cache, not a replacement: SecureStore is still the thing that makes
 * a draft survive a relaunch, and it still wins on read when it has a value.
 */
let memoryDraft: OnboardingDraft = {
  ...EMPTY,
  individual: { ...EMPTY_INDIVIDUAL },
  startup: { ...EMPTY_STARTUP },
};

export async function loadDraft(): Promise<OnboardingDraft> {
  try {
    const raw = await SecureStore.getItemAsync(DRAFT_KEY);
    if (!raw) return memoryDraft;
    const parsed = JSON.parse(raw) as Partial<OnboardingDraft>;
    return {
      accountType:
        parsed.accountType === 'startup' || parsed.accountType === 'individual'
          ? parsed.accountType
          : null,
      fullName: parsed.fullName ?? null,
      financialSetup:
        parsed.financialSetup === 'zoho' || parsed.financialSetup === 'manual'
          ? parsed.financialSetup
          : null,
      // Merged over the defaults so a draft written before a field existed
      // still restores, rather than leaving that field undefined.
      individual: { ...EMPTY_INDIVIDUAL, ...(parsed.individual ?? {}) },
      individualStep:
        typeof parsed.individualStep === 'number' && parsed.individualStep >= 0
          ? parsed.individualStep
          : 0,
      startup: { ...EMPTY_STARTUP, ...(parsed.startup ?? {}) },
    };
  } catch {
    // Unreadable or unavailable storage — whatever this session has collected
    // so far is still better than nothing.
    return memoryDraft;
  }
}

export async function saveDraft(patch: Partial<OnboardingDraft>): Promise<OnboardingDraft> {
  const next = { ...(await loadDraft()), ...patch };
  // Mirrored first, so the value is available to this session even when the
  // write below cannot happen.
  memoryDraft = next;
  try {
    await SecureStore.setItemAsync(DRAFT_KEY, JSON.stringify(next));
  } catch {
    /* Non-fatal: the wizard still works, it just won't resume after a kill. */
  }
  return next;
}

export async function clearDraft(): Promise<void> {
  memoryDraft = {
    ...EMPTY,
    individual: { ...EMPTY_INDIVIDUAL },
    startup: { ...EMPTY_STARTUP },
  };
  try {
    await SecureStore.deleteItemAsync(DRAFT_KEY);
  } catch {
    /* Already gone. */
  }
}
