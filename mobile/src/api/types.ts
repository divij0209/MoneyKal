/**
 * TypeScript mirrors of the backend's Pydantic schemas.
 *
 * SOURCE OF TRUTH: backend/schemas/*.py and the router return shapes.
 * FastAPI publishes the same contract at GET /openapi.json — if these ever
 * drift, that document is the arbiter, not this file.
 *
 * Deliberately faithful, including the parts that look redundant: the API
 * returns both a raw number (`amount`) and a formatted string
 * (`amount_display`). The formatted one is what screens render — currency
 * formatting is the server's job and stays there.
 */

/* ------------------------------------------------------------------ auth */

/** POST /auth/login, /auth/register, /auth/refresh.
 *  `refresh_token` was added for mobile; the web ignores it. */
export interface AuthResponse {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  user_id: number;
  username: string;
  /** null until onboarding has been completed — this is the flag the web's
   *  login branch uses to decide dashboard vs. resume-onboarding. */
  profile_key: string | null;
  /* Terms & Conditions state, as recorded against the account. Optional
     because an older backend does not send it. */
  terms_accepted?: boolean;
  terms_version?: string | null;
  terms_accepted_at?: string | null;
  /** The version the backend currently considers current, for a client that
   *  wants to detect a document the user has not yet re-accepted. */
  current_terms_version?: string;
}

/** What the client sends when the acceptance box was ticked. Matches the
 *  fields backend/routers/auth.py records on the user row. */
export interface TermsAcceptance {
  terms_accepted: true;
  terms_version: string;
  terms_accepted_at: string;
}

/* --------------------------------------------------------------- profile */

export type PersonaKey = 'individual' | 'startup';

export interface Metric {
  id: string;
  label: string;
  value: number;
  unit: string;
  trend: number[];
  isPercent?: boolean;
}

export interface ProfileGoal {
  title?: string;
  progress?: number;
  target?: number;
  target_date?: string | null;
}

export interface ProfileAlert {
  level: 'warn' | 'info' | string;
  text: string;
}

export interface DecisionHistoryItem {
  title: string;
  date_str: string;
  outcome: string;
  tag: 'good' | 'warn' | string;
}

export interface DecisionType {
  id: string;
  label: string;
  primaryLabel?: string;
  primaryUnit?: string;
  primaryStart?: number;
  impactRate?: number;
  goodDirection?: 'up' | 'down';
  secondaryLabel?: string;
  secondaryUnit?: string;
  secondaryStart?: number;
  secondaryImpactRate?: number;
  inactionNote?: string;
}

/** GET /profile/me */
export interface ProfileResponse {
  key: string;
  label: string;
  persona: string;
  currency: string;
  metrics: Metric[];
  goal: ProfileGoal;
  details: Record<string, unknown>;
  raw_inputs: Record<string, unknown>;
  alerts: ProfileAlert[];
  history: DecisionHistoryItem[];
  decisionTypes: DecisionType[];
}

/* ------------------------------------------------------------ daily home */

export interface HomeUser {
  name: string;
  greeting: string;
  profile_key: string;
  currency: string;
  local_date: string;
}

/** Every figure block carries the same envelope: a raw value, the server's
 *  formatted string, and a status that says whether it is real. `display` is
 *  what screens render — the app never formats currency itself. */
export interface StatBlock {
  value: number | null;
  display: string;
  status: 'actual' | 'insufficient_data' | string;
  label: string;
  note: string | null;
  calculation?: Record<string, unknown>;
}

export interface AvailableMoney extends StatBlock {}

export interface MonthlySpending extends StatBlock {
  month: string;
  previous_month: number | null;
  change_pct: number | null;
  stated_baseline: number | null;
  top_categories: { category: string; amount: number; display: string }[];
}

export interface SavingsProgress {
  current: number;
  target: number;
  current_display: string;
  target_display: string;
  percentage: number | null;
  goal_count: number;
  status: 'actual' | 'insufficient_data' | string;
  label: string;
  note: string | null;
}

/** One rules-generated insight. `generated_by` is 'rules' today; a future
 *  LLM layer would flip it, so the audit trail stays honest. */
export interface Insight {
  type: string;
  title: string;
  message: string;
  priority: 'high' | 'medium' | 'low' | string;
  related_data: Record<string, unknown>;
  action: { label: string; view: string } | null;
  generated_by: string;
  alternatives?: Insight[];
}

export interface UpcomingBlock {
  items: UpcomingResponse[];
  total_count: number;
  next_30_days_total: number;
  next_30_days_display: string;
  next_30_days_count: number;
  status: 'actual' | 'empty' | string;
  /** Detected obligations awaiting a yes/no. Excluded from every total above —
   *  a suggestion the user has not accepted must never move a figure. */
  suggestions: UpcomingResponse[];
  suggestion_count: number;
}

export interface SpendingCategory {
  category: string;
  icon: string;
  amount: number;
  display: string;
  share_pct: number;
  previous_amount: number | null;
  change_pct: number | null;
  is_new: boolean;
  transaction_count: number;
}

export interface SpendingOverview {
  status: 'actual' | 'insufficient_data' | string;
  period: string;
  total: number | null;
  total_display: string;
  previous_total?: number | null;
  previous_total_display?: string | null;
  categories: SpendingCategory[];
  leader: SpendingCategory | null;
  insight: string | null;
  transaction_count: number;
  note: string | null;
}

/** One dated money event. `direction: 'none'` means a date, not a payment. */
export interface CalendarEvent {
  date: string;
  type: string;
  title: string;
  amount: number | null;
  direction: 'in' | 'out' | 'none' | string;
  source: 'upcoming' | 'goal' | 'ledger' | string;
  origin: 'manual' | 'gmail' | 'detected' | 'logged' | string;
  tentative: boolean;
  ref_id: number | null;
  detail: string | null;
  meta: Record<string, unknown>;
  days_until: number;
  is_past: boolean;
  is_today: boolean;
  icon: string;
  type_label: string;
  amount_display: string | null;
}

export interface CalendarResponse {
  year: number;
  month: number;
  label: string;
  first_day: string;
  last_day: string;
  /** 0 = Sunday, matching the grid the web already draws. */
  first_weekday: number;
  days_in_month: number;
  today: string;
  days: Record<string, CalendarEvent[]>;
  totals: {
    money_out: number;
    money_out_display: string;
    money_in: number;
    money_in_display: string;
    event_count: number;
    tentative_count: number;
  };
  currency: string;
}

export interface TimelineBlock {
  window_days: number;
  items: CalendarEvent[];
  total_count: number;
  money_out: number;
  money_out_display: string;
  money_in: number;
  money_in_display: string;
  next_7_days_out: number;
  next_7_days_out_display: string;
  next_7_days_count: number;
  tentative_count: number;
}

export interface HomeResponse {
  user: HomeUser;
  financial_snapshot: {
    available_money: AvailableMoney;
    monthly_spending: MonthlySpending;
    savings_progress: SavingsProgress;
  };
  insight: Insight;
  upcoming: UpcomingBlock;
  primary_goal: GoalResponse | null;
  goals: GoalResponse[];
  spending_overview: SpendingOverview;
  calendar: CalendarResponse;
  timeline: TimelineBlock;
  /** False for a brand-new account: show the onboarding call to action, never
   *  a grid of zeroes dressed up as figures. */
  has_financial_data: boolean;
  generated_at: string;
}

export interface GoalCreatePayload {
  name: string;
  target_amount: number;
  current_amount?: number;
  target_date?: string | null;
  category?: string | null;
  icon?: string | null;
  is_primary?: boolean;
}

export type GoalUpdatePayload = Partial<GoalCreatePayload> & { status?: string };

export interface UpcomingCreatePayload {
  name: string;
  amount: number;
  due_date: string;
  category?: string | null;
  recurrence?: Recurrence;
  notes?: string | null;
  direction?: UpcomingDirection;
  event_type?: string | null;
}

export interface GoalResponse {
  id: number;
  name: string;
  icon: string | null;
  category: string | null;
  current_amount: number;
  target_amount: number;
  current_display: string;
  target_display: string;
  percentage: number | null;
  remaining: number | null;
  remaining_display: string | null;
  target_date: string | null;
  days_left: number | null;
  monthly_required: number | null;
  monthly_required_display: string | null;
  is_primary: boolean;
  status: 'active' | 'achieved' | 'archived' | string;
}

export type UpcomingDirection = 'out' | 'in';
export type UpcomingStatus = 'confirmed' | 'review' | 'dismissed';
export type Recurrence = 'none' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface UpcomingResponse {
  id: number;
  name: string;
  amount: number | null;
  amount_display: string | null;
  due_date: string;
  days_until: number;
  urgency: string;
  urgency_level: string;
  category: string | null;
  recurrence: Recurrence;
  is_recurring: boolean;
  source: string;
  direction: UpcomingDirection;
  event_type: string;
  status: UpcomingStatus;
  confidence: number | null;
  source_label: string | null;
  source_subject: string | null;
  notes: string | null;
}

/* ---------------------------------------------------------- hisaab / txn */

export interface Transaction {
  id: number;
  type: 'in' | 'out';
  category: string;
  amount: number;
  description: string | null;
  txn_date: string;
  source: 'manual' | 'auto' | string;
  created_at: string;
  updated_at: string | null;
}

/** POST /hisaab/scan-receipt — what Gemini vision extracts from a receipt.
 *  Every field is optional: the prompt tells the model to omit what it can't
 *  read rather than guess. */
export interface ReceiptScan {
  merchant?: string | null;
  /** ISO YYYY-MM-DD. */
  date?: string | null;
  items?: { name?: string; amount?: number }[];
  tax_amount?: number | null;
  total?: number | null;
  /** One of the Hisaab category strings — the scan prompt constrains it to
   *  exactly the list the app offers. */
  category?: string | null;
}

export interface HisaabSummary {
  currency: string;
  money_in: number;
  money_out: number;
  net: number;
  by_category: { type: 'in' | 'out'; category: string; amount: number }[];
  transactions: Transaction[];
}

/* ------------------------------------------------------------------ twin */

export interface ChatSessionSummary {
  id: string;
  title: string;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'twin';
  content: string;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[];
}

/* ------------------------------------------ Financial Discovery layer ----
   The backend decides what a turn should be — an answer, a single follow-up
   question, or respectful push-back — and whether the conversation has reached
   a decision worth simulating. The client renders that decision; it never makes
   one. In particular, `simulation_cta` being absent is the instruction not to
   show a CTA, and there is no client-side rule that overrides it.
   See backend/agents/discovery.py and backend/schemas/discovery_models.py. */

export type ChatMode = 'answer' | 'ask' | 'challenge';

/** The one question the twin decided was worth a turn. `suggestions` are
 *  tappable shortcuts — typing a different answer is always still allowed. */
export interface FollowUpQuestion {
  question: string;
  slot: string;
  why_it_matters?: string | null;
  suggestions: string[];
}

export interface RiskConstraints {
  growth_preference?: string | null;
  capital_loss_preference?: string | null;
  liquidity_need?: string | null;
  horizon_years?: number | null;
  conflicts: string[];
}

/** Everything the conversation established, handed to Simulation so the user
 *  never re-enters what they already said. Treated as an opaque payload here:
 *  the app forwards it, it does not read or edit the financial fields. */
export interface DecisionContext {
  decision_type: string;
  simulation_type?: string | null;
  amount?: number | null;
  recurring: boolean;
  objective?: string | null;
  time_horizon_years?: number | null;
  risk_profile: Record<string, unknown>;
  risk_constraints: RiskConstraints;
  financial_health_context: Record<string, unknown>;
  existing_investments?: number | null;
  user_constraints: string[];
  blocking_priorities: Record<string, unknown>[];
  conversation_context: string;
  discovered_slots: Record<string, unknown>;
  source: string;
  session_id?: string | null;
}

/** Present only when the backend's gate says all four conditions hold. The
 *  copy is contextual per decision type — never a generic "Simulate this". */
export interface SimulationCTA {
  label: string;
  sublabel?: string | null;
  simulation_type: string;
  /** The sentence Simulation receives, restated from what was discovered. */
  scenario: string;
  decision_context: DecisionContext;
}

export interface ChatResponse {
  session_id: string;
  answer: string;
  confidence: string;
  sources: Record<string, string>[];
  reasoning_trace: Record<string, string>[];
  disclaimer: string;
  visualization?: Record<string, unknown> | null;
  /** Defaults to 'answer' on any backend that predates the discovery layer. */
  mode?: ChatMode;
  user_intent?: string | null;
  decision_type?: string | null;
  follow_up?: FollowUpQuestion | null;
  simulation_cta?: SimulationCTA | null;
  discovery?: Record<string, unknown> | null;
}

/**
 * POST /twin/stt — VARTA's transcription.
 *
 * `text` is empty when the recording contained no speech, which is a normal
 * outcome rather than an error: the mic was tapped and nothing was said. The
 * screen asks the user to try again instead of showing a failure.
 *
 * `language` is what Whisper detected. Nothing renders it today; it is what a
 * multilingual VARTA would key off.
 */
export interface TranscriptionResponse {
  text: string;
  language?: string | null;
}

export interface StageTrace {
  agent: string;
  status: string;
  summary: string;
}

export interface ScenarioSimulateResponse {
  scenario: string;
  scenario_type: string;
  mode: 'scenario' | 'informational' | string;
  parsed_params: Record<string, unknown>;
  stages: StageTrace[];
  financial_impact: Record<string, unknown>;
  timeline: Record<string, unknown>[];
  recommendation: string;
  why: string;
  risks: string[];
  assumptions: string[];
  teaching: string;
  disclaimer: string;
  /** Startup only — see the two models below. Individual leaves both unset. */
  timeline_series?: ScenarioTimelineSeries | null;
  comparison_variants?: ScenarioComparisonVariant[] | null;
  /** Echoed back when the run came from a chat hand-off. */
  decision_context?: DecisionContext | null;
  /** Realistic alternatives to the path the conversation landed on, so
   *  Simulation explores rather than ratifies. Deterministically computed —
   *  see financial_simulator.build_alternative_paths. */
  alternative_paths?: AlternativePath[] | null;
  /** Id of the stored run this response was saved as. Lets the screen add the
   *  finished run to its history list without a refetch, and know which stored
   *  run is currently on screen. Empty when the write failed — the simulation
   *  still ran, it just was not kept. */
  run_id?: string | null;
}

/* -------------------------------------------------- Simulation history ----
   Every run is stored server-side against the profile, so the Simulate tab
   opens with past runs already in it and the same account sees the same
   history from the phone and from the website. Nothing is device-local. */

/** One row in the history list — small on purpose, since the list loads on
 *  every visit to the tab while payloads are fetched only when opened. */
export interface SimulationRunSummary {
  id: string;
  scenario: string;
  scenario_type: string;
  mode: 'scenario' | 'informational' | string;
  /** The recommendation, trimmed to one line. */
  headline: string;
  /** ISO-8601, UTC. */
  created_at: string;
}

/** A stored run, reopened. `result` is what the pipeline produced at the time,
 *  not a re-simulation — so reopening shows the numbers the user actually
 *  decided on rather than today's. */
export interface SimulationRunDetail extends SimulationRunSummary {
  result: ScenarioSimulateResponse;
}

/** One month of a projected cash curve. */
export interface ScenarioProjectionPoint {
  month: number;
  projected_cash: number;
  projected_net_burn?: number | null;
}

/**
 * The Scenario Projection chart's data — Startup only.
 *
 * Two full-resolution curves over the same horizon: `baseline` is what happens
 * if nothing changes, `scenario` is the decision applied. Both are built by
 * startup_engine from already-computed metrics, never by the LLM. Either side
 * can be empty, which is why the chart is gated on both being checked.
 */
export interface ScenarioTimelineSeries {
  unit: string;
  horizon_months: number;
  baseline: ScenarioProjectionPoint[];
  scenario: ScenarioProjectionPoint[];
}

/**
 * One row of the Scenario Comparison table — Startup only.
 *
 * Deterministic alternatives to the scenario as asked ("Don't hire" / "Hire 2"
 * / "Hire 5"), each costed by the same calculator. `is_recommended` is the
 * backend's pick; the client only badges it.
 */
export interface ScenarioComparisonVariant {
  label: string;
  cash_after?: number | null;
  net_burn_after?: number | null;
  runway_after?: number | null;
  revenue_after?: number | null;
  financial_health_after?: number | null;
  goal_progress_avg_after?: number | null;
  risk_count: number;
  is_recommended?: boolean;
}

/** One goal inside a Startup `financial_impact.goal_impact`. */
export interface ScenarioGoalImpact {
  label?: string;
  progress_before_pct?: number | null;
  progress_after_pct?: number | null;
}

/** One risk posture, modelled against the same amount and horizon. */
export interface AlternativePath {
  key: string;
  label: string;
  description: string;
  assumed_annual_return_pct: number;
  invested_total: number;
  projected_value: number;
  estimated_gain: number;
  horizon_months: number;
  plausible_trough_value: number;
  plausible_trough_note: string;
  /** Matches what the user said they wanted. Not a recommendation — the other
   *  options are returned and shown at equal weight. */
  is_aligned: boolean;
  caveats: string[];
}

export interface SimulateOutcome {
  label: string;
  pct: number;
  score: number;
  primary_outcome: number;
  secondary_outcome: number;
  is_best: boolean;
}

export interface SimulateResponse {
  outcomes: SimulateOutcome[];
  explanation: string;
}

/* --------------------------------------------------------------- startup */

/* The fully typed StartupOverviewResponse lives at the end of this file, under
   "startup overview". The placeholder shape that used to stand here was
   scaffolding from before the dashboard existed; it was replaced rather than
   kept alongside, because two declarations of one response is how a client
   starts disagreeing with itself. */

/* -------------------------------------------------------------- live life --
   The fully typed models live at the end of this file, under
   "live.life.fully". This placeholder shape was scaffolding from before the
   screen existed; it was replaced rather than kept alongside, because two
   declarations of one response is how a client starts disagreeing with itself. */

/* ------------------------------------------------------------ misc / ops */

export interface GenericResponse {
  success: boolean;
  message?: string | null;
}

export interface GmailStatus {
  connected: boolean;
  last_synced_at?: string | null;
}

export interface GmailOAuthTicket {
  ticket: string;
  expires_in: number;
  auth_url: string;
}

export interface HealthResponse {
  status: string;
  service: string;
}

export interface MarketSignal {
  category: string;
  headline: string;
  summary?: string | null;
  relevance?: string | null;
  /** The personalised line — why this story touches *this* user's money. */
  why_it_matters?: string | null;
  source?: string | null;
  url?: string | null;
}

export interface MarketPulseResponse {
  signals: MarketSignal[];
  personalized: boolean;
  message?: string;
}

/* ---------------------------------------------------------------- Reports --
   backend/routers/startup.py. The `/startup` prefix is a misnomer for these
   four: `_get_flexible_context()` maps an Individual's own raw_inputs into the
   same context shape (income -> revenue, expenses -> costs, savings -> cash),
   so an Individual gets a real report built from their real figures. The web
   shows this view to both personas for exactly that reason. */

/** The `daily_brief` block of GET /startup/overview. */
export interface DailyBrief {
  bullets?: string[];
}

/**
 * A narrow view of GET /startup/overview.
 *
 * The endpoint returns far more than this — metrics, projections, alerts,
 * health indicators. Reports reads only the brief, so only the brief is typed;
 * declaring the rest would imply this client consumes it.
 */
export interface OverviewBriefResponse {
  currency: string;
  daily_brief: DailyBrief;
}

/** One day in the weekly health report's tracking window. */
export interface WeeklyHealthPoint {
  date: string;
  cash?: number | null;
  net_burn?: number | null;
  runway_months?: number | null;
  financial_health_score?: number | null;
}

/** GET /startup/reports/weekly. */
export interface WeeklyReportResponse {
  status: string;
  window_days: number;
  days_present: number;
  points: WeeklyHealthPoint[];
  note?: string | null;
  health_delta?: number | null;
  cash_delta?: number | null;
  runway_delta?: number | null;
}

export interface SpendCategory {
  category: string;
  this_week: number;
  last_week?: number | null;
  pct_change?: number | null;
  is_new?: boolean;
}

/**
 * `category_spend` inside the weekly spend report.
 *
 * `status` is the field that decides what renders: only `'actual'` means the
 * week has enough logged spending to chart. Anything else carries `note`
 * instead — and can still carry `categories` whose `this_week` are all zero,
 * which is why the status is checked rather than the array's length.
 */
export interface CategorySpend {
  status?: string;
  this_week_total?: number | null;
  last_week_total?: number | null;
  pct_change?: number | null;
  categories?: SpendCategory[];
  note?: string | null;
  week_range?: string | null;
}

export interface WeeklySuggestion {
  title: string;
  detail: string;
}

/** GET /startup/reports/weekly-suggestions (and .../{id}). */
export interface WeeklySpendReportResponse {
  id: number;
  week_start: string;
  week_end: string;
  currency: string;
  category_spend: CategorySpend;
  /** Shape is open-ended server-side; the UI only counts them, as the web does. */
  flags: Record<string, unknown>[];
  suggestions: WeeklySuggestion[];
  created_at: string;
}

/** GET /startup/reports/weekly-suggestions/history. */
export interface WeeklySpendReportListItem {
  id: number;
  week_start: string;
  week_end: string;
  this_week_total?: number | null;
  created_at: string;
}

/* -------------------------------------------------------- live.life.fully --
   backend/routers/live_life.py. Two reads and no writes: a stash *is* a
   FinancialGoal, so it is created with POST /home/goals and funded with
   PUT /home/goals/{id}. There is deliberately no /live-life/stash mirror, and
   this client must not invent one.

   Like /home, every figure arrives display-ready (`*_display`), so nothing on
   this screen is computed on the device. The calculation blocks stay loosely
   typed on purpose — the backend types them the same way, so a new moment rule
   does not force a schema edit on either side. */

export interface LiveLifeUser {
  name: string;
  currency: string;
  local_date: string;
}

export interface LiveLifeIdentity {
  tagline: string;
  lines: string[];
}

/** One line of "What it is made of". `kind` is 'source' or a deduction. */
export interface FreedomBreakdownRow {
  key: string;
  label: string;
  kind: string;
  amount: number;
  display: string;
  note?: string | null;
}

export interface FreedomSide {
  value?: number;
  display: string;
}

export interface FreedomBalance {
  value: number;
  display: string;
  /** 'estimated' | 'insufficient_data' | … — 'insufficient_data' hides figures. */
  status: string;
  label: string;
  copy: string;
  note?: string | null;
  period?: string | null;
  missing?: string[];
  breakdown?: FreedomBreakdownRow[];
  /** What this month's income can carry. */
  flow?: FreedomSide | null;
  /** What savings can spare above the buffer. The lower of the two wins. */
  stock?: FreedomSide | null;
  limited_by?: string | null;
  buffer_months?: number | string | null;
  buffer_status?: string | null;
  components?: Record<string, unknown>;
  assumptions?: string[];
  calculation?: LiveLifeCalculation | null;
}

export interface LiveLifeCalculation {
  formula?: string;
  inputs?: Record<string, unknown>;
  data_source?: string;
}

export interface StashItem {
  id: number;
  name: string;
  icon?: string | null;
  category?: string | null;
  current_amount: number;
  target_amount: number;
  current_display: string;
  target_display: string;
  percentage: number;
  remaining: number;
  remaining_display: string;
  target_date?: string | null;
  days_left?: number | null;
  monthly_required?: number | null;
  monthly_required_display?: string | null;
  is_primary?: boolean;
  status?: string;
  experience_category: string;
  experience_label: string;
  accent: string;
  progress_art?: string;
  emoji: string;
  is_funded?: boolean;
}

export interface Stash {
  items: StashItem[];
  count: number;
  total_saved: number;
  total_saved_display: string;
  total_target?: number;
  total_target_display?: string;
  percentage?: number;
  status?: string;
  note?: string | null;
}

export interface ExperienceCategory {
  key: string;
  label: string;
  emoji: string;
  blurb: string;
  art?: string;
  accent: string;
  stash_count: number;
  saved?: number;
  saved_display?: string | null;
  target?: number | null;
  target_display?: string | null;
  percentage?: number | null;
  lead_stash_id?: number | null;
}

export interface MomentAction {
  label: string;
  /** 'stash:{id}' opens the fund sheet; anything else goes to categories. */
  target?: string | null;
}

export interface LiveLifeMoment {
  type: string;
  title: string;
  message: string;
  evidence?: string[];
  action?: MomentAction | null;
  tone?: string;
  /** Identity used to avoid celebrating the same moment twice in a day. */
  cooldown_key: string;
  generated_by?: string;
}

export interface LiveLifeMomentLocked {
  title: string;
  message: string;
  needs?: string[];
}

/** The nearest stash with a date — the countdown card. */
export interface UpcomingAdventure extends StashItem {
  days_to_go?: number | null;
  countdown_phrase?: string | null;
  date_display?: string | null;
  readiness?: string | null;
}

export interface LiveLifeRecommendation {
  amount: number;
  display: string;
  headline: string;
  basis: string;
  calculation?: LiveLifeCalculation | null;
}

export interface LiveLifeResponse {
  user: LiveLifeUser;
  identity: LiveLifeIdentity;
  freedom_balance: FreedomBalance;
  stash: Stash;
  categories: ExperienceCategory[];
  moment?: LiveLifeMoment | null;
  moment_alternatives: LiveLifeMoment[];
  moment_locked?: LiveLifeMomentLocked | null;
  upcoming_adventure?: UpcomingAdventure | null;
  recommendation?: LiveLifeRecommendation | null;
  has_financial_data: boolean;
  generated_at: string;
}

export interface AffordabilityImpact {
  kind: string;
  label: string;
  detail?: string | null;
}

/** POST /live-life/check. */
export interface AffordabilityVerdict {
  amount: number;
  amount_display: string;
  /** 'comfortable' | 'stretch' | 'not_yet' | 'unknown'. */
  verdict: string;
  headline: string;
  detail?: string | null;
  safe_alternative?: number | null;
  safe_alternative_display?: string | null;
  impacts?: AffordabilityImpact[];
  freedom_balance?: number;
  freedom_balance_display?: string;
  missing?: string[];
  calculation?: LiveLifeCalculation | null;
}

/* ------------------------------------------------------- startup overview --
   GET /startup/overview — backend/routers/startup.py. One request drives the
   whole dashboard; there is no second endpoint behind any section.

   Every metric arrives with a `display` string and a `calculation` block, so
   nothing on the screen is computed on the device. */

export interface StartupCalculation {
  formula?: string;
  inputs?: Record<string, unknown>;
  data_source?: string;
  last_updated?: string;
}

/** `status` drives the chip: actual | forecast | estimated | assumption |
 *  insufficient_data. */
export interface StartupMetric {
  id: string;
  label: string;
  value: number | null;
  unit: string;
  display: string;
  status: string;
  calculation: StartupCalculation;
}

export interface StartupCompany {
  company_name?: string | null;
  industry?: string | null;
  business_model?: string | null;
  founded_year?: number | null;
  stage?: string | null;
  location?: string | null;
  website?: string | null;
  headcount?: number | null;
  founder_name?: string | null;
  preferred_language?: string | null;
  gst_number?: string | null;
}

export interface StartupHealthIndicator {
  id: string;
  label: string;
  /** good | warning | serious | critical | insufficient_data */
  status: string;
  display: string;
  detail: string;
}

/** One dated snapshot. The dashboard charts cash and revenue from these. */
export interface StartupHistoryPoint {
  date: string;
  cash?: number | null;
  gross_burn?: number | null;
  net_burn?: number | null;
  revenue?: number | null;
  runway_months?: number | null;
  financial_health_score?: number | null;
}

export interface StartupProjectionPoint {
  month: number;
  projected_cash: number;
  projected_net_burn?: number | null;
}

export interface StartupCashProjection {
  status?: string;
  series?: StartupProjectionPoint[];
  cash_out_month?: number | null;
  assumptions?: string[];
  calculation?: StartupCalculation;
}

export interface StartupBreakdownItem {
  category: string;
  amount: number;
}

export interface StartupBreakdown {
  status?: string;
  items?: StartupBreakdownItem[];
  streams?: string[];
  /** Names where the figures came from — shown, so a founder can tell
   *  founder-entered numbers from logged transactions. */
  data_source?: string | null;
  total?: number | null;
}

export interface StartupHiringCapacity {
  status?: string;
  max_sustainable_hires?: number | null;
  runway_lost_per_hire?: number | null;
  calculation?: StartupCalculation;
}

export interface StartupGoalProgress {
  type: string;
  label: string;
  target_value?: number | null;
  target_unit?: string | null;
  target_date?: string | null;
  current_value?: number | null;
  progress_pct?: number | null;
  status: string;
  note?: string | null;
  expected_completion_date?: string | null;
  projection_note?: string | null;
}

export interface StartupAlert {
  category: string;
  level: string;
  /** critical | high | medium | low */
  severity: string;
  metric?: string | null;
  text: string;
}

export interface StartupDecisionLogItem {
  title: string;
  decision_type?: string | null;
  outcome?: string | null;
  tag: string;
  created_at: string;
  predicted?: Record<string, number | null> | null;
  actual_now?: Record<string, number | null> | null;
  /** on_track | diverged | pending | unknown */
  decision_status?: string | null;
}

export interface StartupOverviewResponse {
  currency: string;
  company: StartupCompany;
  metrics: Record<string, StartupMetric>;
  cash_projection: StartupCashProjection;
  hiring_capacity: StartupHiringCapacity;
  goals: StartupGoalProgress[];
  alerts: StartupAlert[];
  recent_decisions: StartupDecisionLogItem[];
  daily_brief: DailyBrief & { status?: string; as_of?: string };
  health_indicators: StartupHealthIndicator[];
  history: StartupHistoryPoint[];
  expense_breakdown: StartupBreakdown;
  revenue_breakdown: StartupBreakdown;
}
