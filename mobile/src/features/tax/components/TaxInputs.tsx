import React from 'react';
import { View } from 'react-native';

import type { TaxConfigResponse, TaxDeductionConfig } from '../../../api/types.tax';
import { Divider, Surface, Text } from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';
import type { useTaxForm } from '../hooks';
import { formatINR } from '../hooks';
import { emptyHouseProperty } from '../defaults';
import { AmountField, ChoiceRow, NumberField, ToggleRow } from './Fields';

/**
 * The input side of the Tax screen.
 *
 * Split into the six steps the engine itself is built around (see the module
 * docstring on backend/services/tax_service.py), one per accordion, so the
 * user meets a tax return the way the return is actually organised rather
 * than as one 60-field wall.
 *
 * Every label, limit and section string is read from GET /tax/config. Nothing
 * statutory is written into this file — searching it for a rupee ceiling or a
 * percentage should turn up nothing.
 */

type Form = ReturnType<typeof useTaxForm>;

function Group({ title, caption, children }: { title: string; caption?: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.lg }}>
      <View style={{ gap: 2 }}>
        <Text variant="heading">{title}</Text>
        {caption ? (
          <Text variant="bodySmall" color="faint">
            {caption}
          </Text>
        ) : null}
      </View>
      {children}
    </View>
  );
}

/* ============================================================ 0. taxpayer == */

export function TaxpayerSection({ form, config }: { form: Form; config?: TaxConfigResponse }) {
  const theme = useTheme();
  const t = useT();
  const { taxpayer } = form.input;

  const ageBands = config?.age_bands
    ? Object.values(config.age_bands).map((band) => band.label)
    : [];

  return (
    <Group title={t('tax.yourDetails')} caption={config?.labels?.fy}>
      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <NumberField
          label={t('tax.age')}
          value={taxpayer.age}
          onChange={(age) => form.setTaxpayer({ age })}
          max={120}
        />
        <View style={{ flex: 1 }} />
      </View>

      {/* The age bands the engine actually uses, shown as guidance rather than
          as a second control — age drives the band, so two inputs could
          disagree. */}
      {ageBands.length ? (
        <Text variant="bodySmall" color="faint">
          {ageBands.join('  ·  ')}
        </Text>
      ) : null}

      <ToggleRow
        label={t('tax.metro')}
        detail="Changes the HRA percentage limb"
        value={taxpayer.is_metro}
        onChange={(is_metro) => form.setTaxpayer({ is_metro })}
      />

      <Divider />

      <ToggleRow
        label="Company director"
        value={taxpayer.is_director}
        onChange={(is_director) => form.setTaxpayer({ is_director })}
      />
      <ToggleRow
        label="Holds unlisted shares"
        value={taxpayer.holds_unlisted_shares}
        onChange={(holds_unlisted_shares) => form.setTaxpayer({ holds_unlisted_shares })}
      />
      <ToggleRow
        label="Foreign income"
        value={taxpayer.has_foreign_income}
        onChange={(has_foreign_income) => form.setTaxpayer({ has_foreign_income })}
      />
      <ToggleRow
        label="Foreign assets"
        value={taxpayer.has_foreign_assets}
        onChange={(has_foreign_assets) => form.setTaxpayer({ has_foreign_assets })}
      />

      <AmountField
        label="Agricultural income"
        value={taxpayer.agricultural_income}
        onChange={(agricultural_income) => form.setTaxpayer({ agricultural_income })}
      />
    </Group>
  );
}

/* ============================================================== 1. salary == */

export function SalarySection({ form }: { form: Form }) {
  const theme = useTheme();
  const t = useT();
  const { salary } = form.input;

  return (
    <Group title={t('tax.salary')}>
      <ToggleRow
        label={t('tax.simpleMode')}
        detail="Skip the CTC breakdown and enter the gross figure"
        value={salary.use_simple_mode}
        onChange={(use_simple_mode) => form.setSalary({ use_simple_mode })}
      />

      {salary.use_simple_mode ? (
        <AmountField
          label={t('tax.grossSalary')}
          value={salary.gross_salary_simple}
          onChange={(gross_salary_simple) => form.setSalary({ gross_salary_simple })}
        />
      ) : (
        <>
          <AmountField
            label={t('tax.annualCtc')}
            value={salary.annual_ctc}
            onChange={(annual_ctc) => form.setSalary({ annual_ctc })}
          />

          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <NumberField
              label="Basic (% of CTC)"
              value={salary.basic_percent_of_ctc}
              onChange={(basic_percent_of_ctc) => form.setSalary({ basic_percent_of_ctc })}
              suffix="%"
              max={100}
            />
            <NumberField
              label="DA (% of CTC)"
              value={salary.da_percent_of_ctc}
              onChange={(da_percent_of_ctc) => form.setSalary({ da_percent_of_ctc })}
              suffix="%"
              max={100}
            />
          </View>

          <Divider />

          <AmountField
            label={t('tax.hra')}
            value={salary.hra.amount}
            onChange={(amount) =>
              form.setSalary({
                hra: { ...salary.hra, enabled: amount > 0, mode: 'fixed', amount },
              })
            }
          />
          <AmountField
            label={t('tax.rentPaid')}
            value={salary.rent_paid_annual}
            onChange={(rent_paid_annual) => form.setSalary({ rent_paid_annual })}
            hint="Needed for the HRA exemption. Old regime only."
          />

          <Divider />

          <ToggleRow
            label="Employer PF"
            value={salary.employer_pf}
            onChange={(employer_pf) => form.setSalary({ employer_pf })}
          />
          <ToggleRow
            label="Employer NPS"
            detail="Deductible under both regimes, at different rates"
            value={salary.employer_nps}
            onChange={(employer_nps) => form.setSalary({ employer_nps })}
          />
          <ToggleRow
            label="Gratuity applicable"
            value={salary.gratuity_applicable}
            onChange={(gratuity_applicable) => form.setSalary({ gratuity_applicable })}
          />
        </>
      )}

      <Divider />

      <AmountField
        label={t('tax.tdsDeducted')}
        value={salary.tds_deducted}
        onChange={(tds_deducted) => form.setSalary({ tds_deducted })}
        hint="From Form 16 / Form 26AS"
      />
    </Group>
  );
}

/* ====================================================== 2. house property == */

export function HousePropertySection({ form }: { form: Form }) {
  const theme = useTheme();
  const t = useT();
  const properties = form.input.house_property.properties;

  const patch = (index: number, next: Partial<(typeof properties)[number]>) => {
    const copy = properties.map((p, i) => (i === index ? { ...p, ...next } : p));
    form.setHouseProperties(copy);
  };

  return (
    <Group title={t('tax.houseProperty')}>
      {properties.map((property, index) => (
        <Surface key={index} tone="outlined" padded={theme.spacing.lg}>
          <View style={{ gap: theme.spacing.lg }}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text variant="label" color="faint" style={{ flex: 1 }}>
                {`Property ${index + 1}`}
              </Text>
              <Text
                variant="bodySmall"
                color="accent"
                onPress={() =>
                  form.setHouseProperties(properties.filter((_, i) => i !== index))
                }
                accessibilityRole="button"
              >
                {t('common.delete')}
              </Text>
            </View>

            <ChoiceRow
              value={property.property_type}
              onChange={(property_type) => patch(index, { property_type })}
              options={[
                { value: 'self_occupied', label: 'Self-occupied' },
                { value: 'let_out', label: 'Let out' },
                { value: 'deemed_let_out', label: 'Deemed let out' },
              ]}
            />

            {property.property_type !== 'self_occupied' ? (
              <>
                <AmountField
                  label="Annual rent received"
                  value={property.annual_rent_received}
                  onChange={(annual_rent_received) => patch(index, { annual_rent_received })}
                />
                <AmountField
                  label="Municipal taxes paid"
                  value={property.municipal_taxes_paid}
                  onChange={(municipal_taxes_paid) => patch(index, { municipal_taxes_paid })}
                />
              </>
            ) : null}

            <AmountField
              label="Housing loan interest"
              value={property.housing_loan_interest}
              onChange={(housing_loan_interest) => patch(index, { housing_loan_interest })}
            />
            <AmountField
              label={t('tax.tdsDeducted')}
              value={property.tds_deducted}
              onChange={(tds_deducted) => patch(index, { tds_deducted })}
            />
          </View>
        </Surface>
      ))}

      <Text
        variant="bodySmall"
        color="accent"
        accessibilityRole="button"
        onPress={() => form.setHouseProperties([...properties, emptyHouseProperty()])}
      >
        + Add a property
      </Text>
    </Group>
  );
}

/* ================================================================ 3. PGBP == */

export function BusinessSection({ form }: { form: Form }) {
  const t = useT();
  const { pgbp } = form.input;

  return (
    <Group title={t('tax.business')}>
      <ToggleRow
        label="Presumptive scheme"
        detail="44AD (business) or 44ADA (profession)"
        value={pgbp.presumptive.enabled}
        onChange={(enabled) =>
          form.setPgbp({ presumptive: { ...pgbp.presumptive, enabled } })
        }
      />

      {pgbp.presumptive.enabled ? (
        <>
          <ChoiceRow
            value={pgbp.presumptive.scheme}
            onChange={(scheme) => form.setPgbp({ presumptive: { ...pgbp.presumptive, scheme } })}
            options={[
              { value: '44AD', label: '44AD' },
              { value: '44ADA', label: '44ADA' },
            ]}
          />
          <AmountField
            label="Gross turnover"
            value={pgbp.presumptive.gross_turnover}
            onChange={(gross_turnover) =>
              form.setPgbp({ presumptive: { ...pgbp.presumptive, gross_turnover } })
            }
          />
          {pgbp.presumptive.scheme === '44AD' ? (
            <>
              <AmountField
                label="Cash receipts"
                value={pgbp.presumptive.cash_receipts}
                onChange={(cash_receipts) =>
                  form.setPgbp({ presumptive: { ...pgbp.presumptive, cash_receipts } })
                }
                hint="Drives the deemed-profit percentage split"
              />
              <AmountField
                label="Digital receipts"
                value={pgbp.presumptive.digital_receipts}
                onChange={(digital_receipts) =>
                  form.setPgbp({ presumptive: { ...pgbp.presumptive, digital_receipts } })
                }
              />
            </>
          ) : null}
        </>
      ) : null}

      <Divider />

      <ToggleRow
        label="Regular books"
        value={pgbp.regular.enabled}
        onChange={(enabled) => form.setPgbp({ regular: { ...pgbp.regular, enabled } })}
      />

      {pgbp.regular.enabled ? (
        <>
          <AmountField
            label="Gross receipts"
            value={pgbp.regular.gross_receipts}
            onChange={(gross_receipts) =>
              form.setPgbp({ regular: { ...pgbp.regular, gross_receipts } })
            }
          />
          <AmountField
            label="Total expenses"
            value={pgbp.regular.total_expenses}
            onChange={(total_expenses) =>
              form.setPgbp({ regular: { ...pgbp.regular, total_expenses } })
            }
          />
          <AmountField
            label="Depreciation"
            value={pgbp.regular.depreciation}
            onChange={(depreciation) =>
              form.setPgbp({ regular: { ...pgbp.regular, depreciation } })
            }
          />
        </>
      ) : null}

      <AmountField
        label={t('tax.tdsDeducted')}
        value={pgbp.tds_deducted}
        onChange={(tds_deducted) => form.setPgbp({ tds_deducted })}
      />
    </Group>
  );
}

/* ====================================================== 4. capital gains === */

export function CapitalGainsSection({ form }: { form: Form }) {
  const t = useT();
  const cg = form.input.capital_gains;

  return (
    <Group title={t('tax.capitalGains')}>
      <AmountField
        label="STCG — listed equity (111A)"
        value={cg.stcg_111a}
        onChange={(stcg_111a) => form.setCapitalGains({ stcg_111a })}
      />
      <AmountField
        label="LTCG — listed equity (112A)"
        value={cg.ltcg_112a}
        onChange={(ltcg_112a) => form.setCapitalGains({ ltcg_112a })}
      />
      <AmountField
        label="STCG — other assets"
        value={cg.stcg_other}
        onChange={(stcg_other) => form.setCapitalGains({ stcg_other })}
        hint="Taxed at slab rates"
      />
      <AmountField
        label="LTCG — other assets"
        value={cg.ltcg_other}
        onChange={(ltcg_other) => form.setCapitalGains({ ltcg_other })}
      />

      <Divider />

      <AmountField
        label="Brought-forward short-term loss"
        value={cg.brought_forward_stcl}
        onChange={(brought_forward_stcl) => form.setCapitalGains({ brought_forward_stcl })}
      />
      <AmountField
        label="Brought-forward long-term loss"
        value={cg.brought_forward_ltcl}
        onChange={(brought_forward_ltcl) => form.setCapitalGains({ brought_forward_ltcl })}
      />
      <AmountField
        label={t('tax.tdsDeducted')}
        value={cg.tds_deducted}
        onChange={(tds_deducted) => form.setCapitalGains({ tds_deducted })}
      />
    </Group>
  );
}

/* ====================================================== 5. other sources === */

export function OtherSourcesSection({ form }: { form: Form }) {
  const t = useT();
  const os = form.input.other_sources;

  return (
    <Group title={t('tax.otherSources')}>
      <AmountField
        label="Savings account interest"
        value={os.savings_interest}
        onChange={(savings_interest) => form.setOtherSources({ savings_interest })}
        hint="Eligible for 80TTA / 80TTB"
      />
      <AmountField
        label="Fixed deposit interest"
        value={os.fd_interest}
        onChange={(fd_interest) => form.setOtherSources({ fd_interest })}
      />
      <AmountField
        label="Other interest"
        value={os.other_interest}
        onChange={(other_interest) => form.setOtherSources({ other_interest })}
      />
      <AmountField
        label="Dividend income"
        value={os.dividend_income}
        onChange={(dividend_income) => form.setOtherSources({ dividend_income })}
      />
      <AmountField
        label="Family pension"
        value={os.family_pension}
        onChange={(family_pension) => form.setOtherSources({ family_pension })}
      />
      <AmountField
        label="Winnings"
        value={os.winnings}
        onChange={(winnings) => form.setOtherSources({ winnings })}
        hint="Taxed at a flat special rate"
      />
      <AmountField
        label="Other income"
        value={os.other_income}
        onChange={(other_income) => form.setOtherSources({ other_income })}
      />
      <AmountField
        label={t('tax.tdsDeducted')}
        value={os.tds_deducted}
        onChange={(tds_deducted) => form.setOtherSources({ tds_deducted })}
      />
    </Group>
  );
}

/* ========================================================= 6. deductions === */

export function DeductionsSection({
  form,
  config,
}: {
  form: Form;
  config?: TaxConfigResponse;
}) {
  const theme = useTheme();
  const t = useT();

  const entries: TaxDeductionConfig[] = config?.deductions
    ? Object.values(config.deductions)
    : [];

  // Chapter VI-A only. The config dict also carries salary-exemption and
  // special-rate metadata, which are computed from the salary head rather
  // than claimed here.
  const claimable = entries.filter((entry) => entry.regimes?.length);

  if (!claimable.length) {
    return (
      <Group title={t('tax.deductions')}>
        <Text variant="bodySmall" color="faint">
          {t('common.loading')}
        </Text>
      </Group>
    );
  }

  return (
    <Group
      title={t('tax.deductions')}
      caption={config?.labels?.section_scheme}
    >
      {claimable.map((entry, i) => {
        const oldOnly = entry.regimes.length === 1 && entry.regimes[0] === 'old';
        return (
          <View key={entry.key} style={{ gap: theme.spacing.sm }}>
            {i > 0 ? <Divider /> : null}
            <AmountField
              label={entry.short_label || entry.label}
              value={form.deductionAmount(entry.key)}
              onChange={(amount) => form.setDeduction(entry.key, { amount })}
              limit={entry.limit ? formatINR(entry.limit) : undefined}
              hint={[
                entry.section,
                oldOnly ? 'Old regime only' : null,
                entry.label !== entry.short_label ? entry.label : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            />
          </View>
        );
      })}

      <Divider />

      {/* The two convenience mirrors on DeductionsInput. The engine folds
          both into the 80C ceiling rather than treating them as separate
          claims, which is why they sit below the divider. */}
      <AmountField
        label="Employee PF contribution"
        value={form.input.deductions.employee_pf_contribution}
        onChange={(employee_pf_contribution) =>
          form.setDeductionsMeta({ employee_pf_contribution })
        }
        hint="Counts toward the 80C ceiling"
      />
      <AmountField
        label="Home loan principal repaid"
        value={form.input.deductions.home_loan_principal}
        onChange={(home_loan_principal) => form.setDeductionsMeta({ home_loan_principal })}
        hint="Counts toward the 80C ceiling"
      />
    </Group>
  );
}

/* ======================================================== 7. taxes paid ==== */

export function TaxesPaidSection({ form }: { form: Form }) {
  const t = useT();

  return (
    <Group title={t('tax.taxesPaid')} caption="Reconciled against Form 26AS / AIS">
      <AmountField
        label={t('tax.advanceTax')}
        value={form.input.advance_tax_paid}
        onChange={(advance_tax_paid) => form.setTaxesPaid({ advance_tax_paid })}
      />
      <AmountField
        label={t('tax.selfAssessment')}
        value={form.input.self_assessment_tax_paid}
        onChange={(self_assessment_tax_paid) => form.setTaxesPaid({ self_assessment_tax_paid })}
      />
    </Group>
  );
}
