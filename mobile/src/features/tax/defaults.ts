import type {
  MotorCarPerquisite,
  SalaryComponent,
  TaxProfileInput,
} from '../../api/types.tax';

/**
 * An empty submission.
 *
 * Every value here is the Pydantic default from backend/schemas/tax_models.py.
 * They are restated rather than fetched because the form has to render before
 * the first round trip, and a field that starts `undefined` and becomes `0`
 * causes a controlled-input warning and a cursor jump. If a default changes on
 * the backend, change it here too — the server still validates.
 *
 * Note what is NOT here: no rate, no limit, no slab, no statutory figure of
 * any kind. Those come from GET /tax/config on every render.
 */

export function emptyComponent(): SalaryComponent {
  return { enabled: false, mode: 'fixed', amount: 0, percent_of_basic_da: 0, count: 0 };
}

export function emptyMotorCar(): MotorCarPerquisite {
  return {
    enabled: false,
    car_owner: 'employer',
    expense_bearer: 'employer',
    usage: 'mixed',
    engine_type: 'small',
    chauffeur_provided: false,
    months_available: 12,
    actual_cost_of_car: 0,
    annual_running_expenses: 0,
    driver_salary_annual: 0,
    actual_reimbursement: 0,
    employee_recovery: 0,
    transferred_to_employee: false,
    completed_years: 0,
    amount_paid_on_transfer: 0,
  };
}

export function emptyTaxInput(): TaxProfileInput {
  return {
    taxpayer: {
      name: '',
      age: 30,
      city: '',
      is_metro: false,
      tax_year: null,
      is_director: false,
      holds_unlisted_shares: false,
      has_foreign_income: false,
      has_foreign_assets: false,
      agricultural_income: 0,
    },
    salary: {
      enabled: false,
      annual_ctc: 0,
      basic_percent_of_ctc: 30,
      da_percent_of_ctc: 20,
      gratuity_applicable: false,
      employer_nps: false,
      employer_pf: false,
      hra: emptyComponent(),
      rent_paid_annual: 0,
      conveyance_allowance: emptyComponent(),
      food_coupons: emptyComponent(),
      children_education_allowance: emptyComponent(),
      children_hostel_allowance: emptyComponent(),
      uniform_allowance: emptyComponent(),
      telephone_internet: emptyComponent(),
      employer_medical_premium: emptyComponent(),
      professional_course: emptyComponent(),
      health_club: emptyComponent(),
      gift_vouchers: emptyComponent(),
      leave_travel_concession: emptyComponent(),
      motor_car: emptyMotorCar(),
      use_simple_mode: false,
      gross_salary_simple: 0,
      tds_deducted: 0,
    },
    house_property: { enabled: false, properties: [] },
    pgbp: {
      enabled: false,
      presumptive: {
        enabled: false,
        scheme: '44AD',
        gross_turnover: 0,
        cash_receipts: 0,
        digital_receipts: 0,
        declared_profit_override: null,
      },
      regular: {
        enabled: false,
        gross_receipts: 0,
        total_expenses: 0,
        depreciation: 0,
        net_profit_override: null,
      },
      tds_deducted: 0,
    },
    capital_gains: {
      enabled: false,
      stcg_111a: 0,
      ltcg_112a: 0,
      stcg_other: 0,
      ltcg_other: 0,
      brought_forward_stcl: 0,
      brought_forward_ltcl: 0,
      tds_deducted: 0,
    },
    other_sources: {
      enabled: false,
      savings_interest: 0,
      fd_interest: 0,
      other_interest: 0,
      dividend_income: 0,
      winnings: 0,
      family_pension: 0,
      other_income: 0,
    tds_deducted: 0,
    },
    deductions: { entries: [], employee_pf_contribution: 0, home_loan_principal: 0 },
    advance_tax_paid: 0,
    self_assessment_tax_paid: 0,
  };
}

/**
 * A blank house property, matching the `HouseProperty` defaults.
 */
export function emptyHouseProperty() {
  return {
    label: 'Property',
    property_type: 'self_occupied' as const,
    annual_rent_received: 0,
    municipal_taxes_paid: 0,
    housing_loan_interest: 0,
    tds_deducted: 0,
  };
}

/**
 * Merge a saved payload over the empty shape.
 *
 * GET /tax/profile returns whatever was stored, which for an older save may
 * be missing fields the schema has since gained. Spreading over the defaults
 * means a new field arrives with its default rather than as `undefined`,
 * which would put the form into uncontrolled-input territory.
 */
export function hydrate(saved: Partial<TaxProfileInput> | null | undefined): TaxProfileInput {
  const base = emptyTaxInput();
  if (!saved) return base;

  return {
    taxpayer: { ...base.taxpayer, ...(saved.taxpayer ?? {}) },
    salary: { ...base.salary, ...(saved.salary ?? {}) },
    house_property: { ...base.house_property, ...(saved.house_property ?? {}) },
    pgbp: {
      ...base.pgbp,
      ...(saved.pgbp ?? {}),
      presumptive: { ...base.pgbp.presumptive, ...(saved.pgbp?.presumptive ?? {}) },
      regular: { ...base.pgbp.regular, ...(saved.pgbp?.regular ?? {}) },
    },
    capital_gains: { ...base.capital_gains, ...(saved.capital_gains ?? {}) },
    other_sources: { ...base.other_sources, ...(saved.other_sources ?? {}) },
    deductions: { ...base.deductions, ...(saved.deductions ?? {}) },
    advance_tax_paid: saved.advance_tax_paid ?? base.advance_tax_paid,
    self_assessment_tax_paid: saved.self_assessment_tax_paid ?? base.self_assessment_tax_paid,
  };
}
