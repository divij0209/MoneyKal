/**
 * Individual Tax Calculator — the wire contract.
 *
 * Transcribed field-for-field from backend/schemas/tax_models.py. Nothing
 * here is invented: if a field is not in that file it is not in this one, and
 * the names match exactly so a payload can be handed straight to the API.
 *
 * All amounts are ANNUAL rupees unless the field name says otherwise. No
 * statutory figure — no rate, no limit, no slab — is hardcoded on this side;
 * every one of them comes from GET /tax/config, which is the whole reason
 * that endpoint exists (see the docstring on backend/routers/tax.py).
 */

/* ========================================================================== *
 * Inputs
 * ========================================================================== */

export interface TaxpayerProfile {
  name?: string;
  age: number;
  city?: string;
  is_metro: boolean;
  tax_year?: string | null;
  is_director: boolean;
  holds_unlisted_shares: boolean;
  has_foreign_income: boolean;
  has_foreign_assets: boolean;
  agricultural_income: number;
}

export type ComponentMode = 'fixed' | 'percent' | 'count';

export interface SalaryComponent {
  enabled: boolean;
  mode: ComponentMode;
  amount: number;
  percent_of_basic_da: number;
  count: number;
}

export interface MotorCarPerquisite {
  enabled: boolean;
  car_owner: 'employer' | 'employee';
  expense_bearer: 'employer' | 'employee';
  usage: 'official' | 'personal' | 'mixed';
  engine_type: 'small' | 'large';
  chauffeur_provided: boolean;
  months_available: number;
  actual_cost_of_car: number;
  annual_running_expenses: number;
  driver_salary_annual: number;
  actual_reimbursement: number;
  employee_recovery: number;
  transferred_to_employee: boolean;
  completed_years: number;
  amount_paid_on_transfer: number;
}

/** The structured allowance lines, in the order the workbook lists them. */
export type SalaryComponentKey =
  | 'hra'
  | 'conveyance_allowance'
  | 'food_coupons'
  | 'children_education_allowance'
  | 'children_hostel_allowance'
  | 'uniform_allowance'
  | 'telephone_internet'
  | 'employer_medical_premium'
  | 'professional_course'
  | 'health_club'
  | 'gift_vouchers'
  | 'leave_travel_concession';

export interface SalaryIncome {
  enabled: boolean;
  annual_ctc: number;
  basic_percent_of_ctc: number;
  da_percent_of_ctc: number;
  gratuity_applicable: boolean;
  employer_nps: boolean;
  employer_pf: boolean;
  hra: SalaryComponent;
  rent_paid_annual: number;
  conveyance_allowance: SalaryComponent;
  food_coupons: SalaryComponent;
  children_education_allowance: SalaryComponent;
  children_hostel_allowance: SalaryComponent;
  uniform_allowance: SalaryComponent;
  telephone_internet: SalaryComponent;
  employer_medical_premium: SalaryComponent;
  professional_course: SalaryComponent;
  health_club: SalaryComponent;
  gift_vouchers: SalaryComponent;
  leave_travel_concession: SalaryComponent;
  motor_car: MotorCarPerquisite;
  use_simple_mode: boolean;
  gross_salary_simple: number;
  tds_deducted: number;
}

export interface HouseProperty {
  label?: string;
  property_type: 'self_occupied' | 'let_out' | 'deemed_let_out';
  annual_rent_received: number;
  municipal_taxes_paid: number;
  housing_loan_interest: number;
  tds_deducted: number;
}

export interface HousePropertyIncome {
  enabled: boolean;
  properties: HouseProperty[];
}

export interface PresumptiveBusiness {
  enabled: boolean;
  scheme: '44AD' | '44ADA';
  gross_turnover: number;
  cash_receipts: number;
  digital_receipts: number;
  declared_profit_override?: number | null;
}

export interface RegularBusiness {
  enabled: boolean;
  gross_receipts: number;
  total_expenses: number;
  depreciation: number;
  net_profit_override?: number | null;
}

export interface PGBPIncome {
  enabled: boolean;
  presumptive: PresumptiveBusiness;
  regular: RegularBusiness;
  tds_deducted: number;
}

export interface CapitalGainsIncome {
  enabled: boolean;
  stcg_111a: number;
  ltcg_112a: number;
  stcg_other: number;
  ltcg_other: number;
  brought_forward_stcl: number;
  brought_forward_ltcl: number;
  tds_deducted: number;
}

export interface OtherSourcesIncome {
  enabled: boolean;
  savings_interest: number;
  fd_interest: number;
  other_interest: number;
  dividend_income: number;
  winnings: number;
  family_pension: number;
  other_income: number;
  tds_deducted: number;
}

export interface DeductionEntry {
  key: string;
  amount: number;
  is_senior_citizen_claim: boolean;
  is_severe_disability: boolean;
}

export interface DeductionsInput {
  entries: DeductionEntry[];
  employee_pf_contribution: number;
  home_loan_principal: number;
}

export interface TaxProfileInput {
  taxpayer: TaxpayerProfile;
  salary: SalaryIncome;
  house_property: HousePropertyIncome;
  pgbp: PGBPIncome;
  capital_gains: CapitalGainsIncome;
  other_sources: OtherSourcesIncome;
  deductions: DeductionsInput;
  advance_tax_paid: number;
  self_assessment_tax_paid: number;
}

/* ========================================================================== *
 * Results
 * ========================================================================== */

export interface TaxLineItem {
  label: string;
  amount: number;
  section?: string | null;
  note?: string | null;
}

export interface HRALimb {
  key: string;
  label: string;
  amount: number;
  formula: string;
  is_binding: boolean;
}

export interface HRAExemptionDetail {
  applicable: boolean;
  exempt_amount: number;
  taxable_hra: number;
  limbs: HRALimb[];
  binding_limb?: string | null;
  basic_da: number;
  rent_paid: number;
  is_metro: boolean;
  metro_percent_applied: number;
  allowed_in_new_regime: boolean;
  notes: string[];
}

export interface HeadSummary {
  head: string;
  label: string;
  gross: number;
  exempt: number;
  deductions: number;
  net: number;
  tds: number;
  line_items: TaxLineItem[];
  warnings: string[];
  hra_exemption?: HRAExemptionDetail | null;
  exempt_both_regimes: number;
  exempt_old_regime_only: number;
}

export interface DeductionResult {
  key: string;
  section: string;
  label: string;
  short_label: string;
  claimed: number;
  qualifying: number;
  qualifying_old: number;
  qualifying_new: number;
  limit?: number | null;
  limit_reason?: string | null;
  regimes: string[];
  is_capped: boolean;
  headroom: number;
  notes: string[];
}

export interface DeductionsSummary {
  entries: DeductionResult[];
  total_old_regime: number;
  total_new_regime: number;
  total_claimed: number;
  restricted_to_gti: boolean;
  warnings: string[];
}

export interface TDSEntry {
  head: string;
  label: string;
  amount: number;
}

export interface TDSSummary {
  by_head: TDSEntry[];
  total_tds: number;
  advance_tax: number;
  self_assessment_tax: number;
  total_prepaid: number;
  notes: string[];
}

export interface SlabBand {
  from_amount: number;
  to_amount?: number | null;
  rate: number;
  taxable_in_band: number;
  tax: number;
}

export interface SpecialRateItem {
  key: string;
  label: string;
  section?: string | null;
  gross: number;
  exemption_applied: number;
  basic_exemption_setoff: number;
  taxable: number;
  rate: number;
  tax: number;
}

export interface RegimeComputation {
  regime: string;
  label: string;
  salary_net: number;
  house_property_net: number;
  pgbp_net: number;
  other_sources_net: number;
  capital_gains_net: number;
  gross_total_income: number;
  hra_exemption: number;
  allowances_exempt: number;
  standard_deduction: number;
  professional_tax: number;
  chapter_via_deductions: number;
  total_income: number;
  normal_income: number;
  special_rate_items: SpecialRateItem[];
  slab_bands: SlabBand[];
  tax_on_normal_income: number;
  tax_on_special_income: number;
  tax_before_rebate: number;
  rebate: number;
  rebate_section?: string | null;
  rebate_marginal_relief: number;
  tax_after_rebate: number;
  surcharge_rate: number;
  surcharge_before_relief: number;
  surcharge_marginal_relief: number;
  surcharge: number;
  cess_rate: number;
  cess: number;
  total_tax_liability: number;
  prepaid_tax: number;
  /** Positive = pay, negative = refund. */
  net_payable: number;
  is_refund: boolean;
  effective_rate: number;
  notes: string[];
}

export interface RegimeComparison {
  old: RegimeComputation;
  new: RegimeComputation;
  recommended_regime: string;
  saving: number;
  /** Extra old-regime deductions needed to draw level, when new wins. */
  breakeven_extra_deductions?: number | null;
  default_regime: string;
  summary: string;
}

export interface TaxRecommendation {
  key: string;
  category: string;
  priority: string;
  title: string;
  detail: string;
  estimated_saving?: number | null;
  action?: string | null;
  section?: string | null;
}

export interface ITRRuledOut {
  form: string;
  reason: string;
}

export interface ITRFormRecommendation {
  form: string;
  name: string;
  description: string;
  reasons: string[];
  ruled_out: ITRRuledOut[];
  warnings: string[];
}

export interface IncomeCollectionResponse {
  tax_year: string;
  tax_year_label: string;
  governing_act: string;
  heads: HeadSummary[];
  gross_total_income: number;
  total_tds: number;
  active_heads: string[];
  warnings: string[];
  disclaimer: string;
  deductions?: DeductionsSummary | null;
  tds?: TDSSummary | null;
  comparison?: RegimeComparison | null;
  recommendations: TaxRecommendation[];
  itr_form?: ITRFormRecommendation | null;
}

/* ========================================================================== *
 * Config — GET /tax/config
 * ========================================================================== */

export interface TaxDeductionConfig {
  key: string;
  label: string;
  short_label: string;
  section: string;
  limit?: number | null;
  limit_senior?: number | null;
  limit_severe?: number | null;
  regimes: string[];
}

export interface TaxAgeBand {
  label: string;
  min: number;
  max: number;
}

export interface TaxRegimeConfig {
  label: string;
  standard_deduction: unknown;
  professional_tax: unknown;
  allows_chapter_via: boolean;
  allows_hra: boolean;
  is_default_regime: boolean;
  rebate: unknown;
  surcharge: unknown;
  slabs: unknown;
}

export interface TaxConfigResponse {
  tax_year: string;
  available_years: string[];
  labels: { fy: string; ay: string; act: string; section_scheme: string; [k: string]: string };
  section_scheme: string;
  age_bands: Record<string, TaxAgeBand>;
  regimes: Record<string, TaxRegimeConfig>;
  cess_rate: number;
  cess_label: string;
  hra_rules: unknown;
  salary_exemptions: unknown;
  employer_contributions: unknown;
  motor_car: unknown;
  house_property: unknown;
  capital_gains: unknown;
  presumptive: unknown;
  deductions: Record<string, TaxDeductionConfig>;
  itr_forms: unknown;
  labour_code_basic_da_floor: unknown;
  /** Help text, already rendered for this year by the backend. */
  field_guidance: Record<string, string> | Record<string, unknown>;
  filing_guides: unknown;
  disclaimer: string;
}

/* ========================================================================== *
 * Saved profile — GET/PUT /tax/profile
 * ========================================================================== */

export interface TaxProfileResponse {
  tax_year: string;
  inputs: TaxProfileInput;
  last_result?: IncomeCollectionResponse | null;
  exists: boolean;
  updated_at?: string | null;
}

export interface SaveTaxProfileResponse {
  status: string;
  tax_year: string;
  result: IncomeCollectionResponse;
}
