import { getApiBaseUrl, api, request } from '../client';

/**
 * Onboarding endpoints — backend/routers/onboarding.py.
 *
 * Field names match `IndividualOnboardingRequest` exactly, which is also what
 * twin-app/js/auth.js sends, so both clients hit one contract.
 */

/** POST /onboard/confirm — the payload shape of IndividualOnboardingRequest. */
export interface IndividualOnboardingPayload {
  full_name?: string;
  email?: string;
  mobile?: string;
  occupation?: string;
  monthly_income: number;
  total_savings: number;
  monthly_expenses: number;
  outstanding_loans: number;
  existing_investments?: number;
  insurance_coverage?: number;
  dependents?: number;
  goal_title?: string;
  goal_target_amount?: number;
  goal_target_date?: string | null;
}

export interface ConfirmResponse {
  status: string;
  profile_key: string;
}

/** Creates (or replaces) the Individual profile. This is what turns a
 *  registered account into an onboarded one — it is the call that makes
 *  `profile_key` non-null. */
export function confirmIndividual(payload: IndividualOnboardingPayload) {
  return api.post<ConfirmResponse>('/onboard/confirm', payload);
}

/** PUT /onboard/individual/update — every field optional. For editing a
 *  profile that already exists, not for first-time onboarding. */
export function updateIndividual(payload: Partial<IndividualOnboardingPayload>) {
  return api.put<{ status: string }>('/onboard/individual/update', payload);
}

/* ------------------------------------------------------- assisted capture */

/**
 * The extraction shape both AI paths return.
 *
 * Defined by the backend's own prompts — /onboard/chat's system prompt and
 * /onboard/parse-statement's extraction prompt specify this exact JSON, so one
 * mapper serves both.
 */
export interface ExtractedFinancials {
  salary?: number;
  savings?: number;
  expenses?: {
    food?: number;
    rent?: number;
    emi?: number;
    shopping?: number;
    others?: number;
  };
  loans?: number;
}

export interface OnboardingChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * POST /onboard/chat — conversational onboarding.
 *
 * The backend asks 3-4 short questions, then replies with the literal word
 * ONBOARDING_COMPLETE followed by a JSON block. Detecting and parsing that is
 * the client's job; see parseChatCompletion below.
 */
export function onboardingChat(messages: OnboardingChatMessage[]) {
  return api.post<{ reply: string }>('/onboard/chat', { messages }, { slow: true });
}

/** The sentinel the backend's system prompt tells the model to emit. */
export const ONBOARDING_COMPLETE = 'ONBOARDING_COMPLETE';

/**
 * Splits an assistant reply into the text to show and the extracted figures.
 *
 * Returns `financials: null` while the conversation is still going. The JSON
 * block is matched loosely because a model can wrap it in a fence even when
 * told not to.
 */
export function parseChatCompletion(reply: string): {
  text: string;
  financials: ExtractedFinancials | null;
} {
  if (!reply.includes(ONBOARDING_COMPLETE)) return { text: reply.trim(), financials: null };

  const [before, after = ''] = reply.split(ONBOARDING_COMPLETE);
  const match = after.match(/\{[\s\S]*\}/);
  if (!match) return { text: before.trim(), financials: null };

  try {
    return { text: before.trim(), financials: JSON.parse(match[0]) as ExtractedFinancials };
  } catch {
    return { text: before.trim(), financials: null };
  }
}

/**
 * POST /onboard/parse-statement — extract figures from a bank statement.
 *
 * Multipart, so Content-Type is left unset for the runtime to add the boundary.
 */
export function parseStatement(file: {
  uri: string;
  name: string;
  mimeType?: string | null;
}): Promise<ExtractedFinancials> {
  const form = new FormData();
  // React Native's FormData takes this {uri, name, type} shape for files; the
  // cast is needed because the DOM lib types the field as Blob | string.
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || 'application/octet-stream',
  } as unknown as Blob);

  return request<ExtractedFinancials>('/onboard/parse-statement', {
    method: 'POST',
    formData: form,
    slow: true,
  });
}

/* ------------------------------------------------------------------ excel */

/** GET /onboard/excel/template — a spreadsheet of the fields for this persona.
 *  Unauthenticated and available before onboarding, so it can be handed to the
 *  user as a way to gather their figures. */
export function excelTemplateUrl(persona: 'individual' | 'startup' = 'individual'): string {
  return `${getApiBaseUrl()}/onboard/excel/template?persona=${persona}`;
}

export interface ExcelUploadResponse {
  status: string;
  message: string;
  updated_count: number;
  updated_fields: string[];
  errors: { field: string; error: string }[];
}

/**
 * POST /onboard/excel/upload — bulk-fill fields from a spreadsheet.
 *
 * NOTE: this requires a profile to already exist. The router looks the profile
 * up first and returns 404 "Profile not found for current user." when there
 * isn't one, so it is an *update* path, not a first-time onboarding path.
 * (The web offers it on its onboarding step anyway, where it 404s for every
 * new account — see the note in the onboarding screen.)
 */
export function uploadExcel(
  file: { uri: string; name: string; mimeType?: string | null },
  persona: 'individual' | 'startup' = 'individual',
) {
  const form = new FormData();
  form.append('file', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType || 'application/octet-stream',
  } as unknown as Blob);

  return request<ExcelUploadResponse>('/onboard/excel/upload', {
    method: 'POST',
    formData: form,
    query: { persona_override: persona },
    slow: true,
  });
}

/* ---------------------------------------------------------------- startup */

/**
 * POST /onboard/startup — the payload shape of `StartupOnboardingRequest`.
 *
 * The schema is wider than the wizard: it accepts founder contact details,
 * itemised fixed/variable costs, revenue streams, growth, paying customers,
 * funding rounds, hiring plans and goals. The web's wizard collects ten fields
 * and fills the rest with constants (twin-app/js/auth.js), and the mobile
 * wizard sends exactly the same thing — every optional field is typed here so
 * the contract is visible, not so the client invents values for it.
 */
export interface StartupOnboardingPayload {
  founder: {
    name: string;
    email: string;
    mobile?: string | null;
    preferred_language?: string | null;
  };
  company: {
    name: string;
    industry?: string | null;
    business_model?: string | null;
    founded_year?: number | null;
    stage?: string | null;
    location?: string | null;
    website?: string | null;
    headcount?: number | null;
    gst_number?: string | null;
  };
  revenue: {
    is_pre_revenue: boolean;
    monthly_revenue?: number | null;
    revenue_streams: string[];
    revenue_growth_pct?: number | null;
    paying_customers?: number | null;
  };
  expenses: { fixed_costs?: number | null; variable_costs?: number | null };
  cash: { current_cash?: number | null; monthly_burn?: number | null };
  debt: { business_loans_debt?: number | null };
  funding: {
    total_funding?: number | null;
    last_round?: string | null;
    currently_fundraising: boolean;
    fundraising_target?: number | null;
  };
  team: { planned_hires?: number | null; cost_per_hire?: number | null };
  goals: unknown[];
  current_decision?: string | null;
}

/**
 * Creates the Startup Financial Twin.
 *
 * This is the call that turns a registered account into an onboarded founder:
 * it sets `profile.key = 'startup'` and creates the StartupProfile row. It
 * answers with the full StartupOverviewResponse, which this client does not
 * consume — the dashboard fetches its own — so the response is left untyped
 * here rather than half-modelled.
 *
 * A malformed GSTIN comes back as a 400 with the backend's own message; the
 * screen shows it verbatim rather than second-guessing the format.
 */
export function onboardStartup(payload: StartupOnboardingPayload) {
  return api.post<Record<string, unknown>>('/onboard/startup', payload, { slow: true });
}

/* ------------------------------------------------------- startup update -- */

/**
 * PUT /onboard/startup/update — every field optional.
 *
 * The backend applies this with `exclude_unset`, so an omitted key is left
 * alone rather than nulled. That is why the Edit Profile screen sends only the
 * fields the user actually changed: sending the whole form back would be
 * harmless today but would silently overwrite anything a future field added
 * server-side.
 *
 * `planned_hires` and `cost_per_hire` are part of this contract already; the
 * website's edit form simply never sends them. Exposing them is what lets a
 * founder's hire simulation compute a real burn impact instead of assuming
 * ₹0/month per hire.
 */
export interface StartupUpdatePayload {
  founder_name?: string;
  founder_email?: string;
  founder_mobile?: string;
  preferred_language?: string;
  company_name?: string;
  industry?: string;
  business_model?: string;
  founded_year?: number;
  stage?: string;
  location?: string;
  website?: string;
  headcount?: number;
  gst_number?: string;
  is_pre_revenue?: boolean;
  monthly_revenue?: number;
  revenue_growth_pct_input?: number;
  paying_customers?: number;
  fixed_costs?: number;
  variable_costs?: number;
  current_cash?: number;
  monthly_burn_input?: number;
  business_loans_debt?: number;
  total_funding?: number;
  last_round?: string;
  currently_fundraising?: boolean;
  fundraising_target?: number;
  planned_hires?: number;
  cost_per_hire?: number;
}

/** Edits an existing Startup profile. A malformed GSTIN comes back as a 400
 *  with the backend's own wording, which the screen shows verbatim. */
export function updateStartup(payload: StartupUpdatePayload) {
  return api.put<{ status: string }>('/onboard/startup/update', payload);
}
