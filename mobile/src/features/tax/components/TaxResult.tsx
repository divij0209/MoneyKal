import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import type {
  IncomeCollectionResponse,
  RegimeComputation,
  TaxRecommendation,
} from '../../../api/types.tax';
import {
  ComparisonBars,
  Divider,
  EmptyState,
  Metric,
  SlabLadder,
  Surface,
  Text,
} from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';
import { formatBand, formatINR, formatRate } from '../hooks';
import { ComputeRow } from './Fields';

/**
 * The computed result.
 *
 * Structured the way an accountant would present it, and in that order:
 *
 *   1. the answer      — what you owe, under which regime, and what it saves
 *   2. the comparison  — old vs new, side by side
 *   3. the derivation  — how the winning regime's number was built, line by
 *                        line, each line carrying its statutory section
 *   4. the slabs       — which band contributed what
 *   5. the form        — which ITR, and why the others were ruled out
 *   6. the advice      — the engine's ranked suggestions
 *
 * Every figure comes from backend/services/tax_service.py. This file computes
 * nothing; the only arithmetic is `Math.abs` on a signed net position and the
 * share-of-total used to size a slab bar.
 */

/* -------------------------------------------------------------------------- */

function Section({
  title,
  caption,
  children,
  action,
}: {
  title: string;
  caption?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="title">{title}</Text>
          {caption ? (
            <Text variant="bodySmall" color="faint">
              {caption}
            </Text>
          ) : null}
        </View>
        {action}
      </View>
      {children}
    </View>
  );
}

/** A collapsible block. Progressive disclosure is what keeps a tax screen
 *  readable: the answer is always visible, the derivation is one tap away. */
function Disclosure({
  title,
  summary,
  children,
  initiallyOpen = false,
}: {
  title: string;
  summary?: string;
  children: React.ReactNode;
  initiallyOpen?: boolean;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(initiallyOpen);

  return (
    <View>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={title}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
          paddingVertical: theme.spacing.md,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="heading">{title}</Text>
          {summary ? (
            <Text variant="bodySmall" color="faint">
              {summary}
            </Text>
          ) : null}
        </View>
        <Text variant="bodySmall" color="accent">
          {open ? '−' : '+'}
        </Text>
      </Pressable>
      {open ? <View style={{ paddingBottom: theme.spacing.md }}>{children}</View> : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

/** The derivation for one regime, line by line. */
function RegimeBreakdown({ regime }: { regime: RegimeComputation }) {
  const t = useT();
  const theme = useTheme();

  const rows: {
    label: string;
    value: number;
    section?: string | null;
    negative?: boolean;
    emphasis?: boolean;
    skipZero?: boolean;
  }[] = [
    { label: t('tax.grossTotalIncome'), value: regime.gross_total_income, emphasis: true },
    { label: t('tax.hraExemption'), value: regime.hra_exemption, negative: true, skipZero: true },
    {
      label: t('tax.allowancesExempt'),
      value: regime.allowances_exempt,
      negative: true,
      skipZero: true,
    },
    {
      label: t('tax.standardDeduction'),
      value: regime.standard_deduction,
      negative: true,
      skipZero: true,
    },
    {
      label: t('tax.professionalTax'),
      value: regime.professional_tax,
      negative: true,
      skipZero: true,
    },
    {
      label: t('tax.chapterViA'),
      value: regime.chapter_via_deductions,
      negative: true,
      skipZero: true,
    },
    { label: t('tax.totalIncome'), value: regime.total_income, emphasis: true },
  ];

  const taxRows: typeof rows = [
    { label: t('tax.taxBeforeRebate'), value: regime.tax_before_rebate },
    {
      label: t('tax.rebate'),
      value: regime.rebate,
      section: regime.rebate_section,
      negative: true,
      skipZero: true,
    },
    {
      label: t('tax.surcharge'),
      value: regime.surcharge,
      section: regime.surcharge_rate ? formatRate(regime.surcharge_rate) : null,
      skipZero: true,
    },
    {
      label: t('tax.cess'),
      value: regime.cess,
      section: regime.cess_rate ? formatRate(regime.cess_rate) : null,
      skipZero: true,
    },
    { label: t('tax.totalLiability'), value: regime.total_tax_liability, emphasis: true },
    { label: t('tax.prepaid'), value: regime.prepaid_tax, negative: true, skipZero: true },
  ];

  const render = (list: typeof rows) =>
    list
      .filter((row) => !(row.skipZero && !row.value))
      .map((row, i) => (
        <View key={`${row.label}-${i}`}>
          {i > 0 ? <Divider /> : null}
          <ComputeRow
            label={row.label}
            section={row.section}
            value={formatINR(row.value)}
            negative={row.negative}
            emphasis={row.emphasis}
          />
        </View>
      ));

  return (
    <View style={{ gap: theme.spacing.lg }}>
      <View>{render(rows)}</View>

      {regime.special_rate_items.length ? (
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="label" color="faint">
            {t('tax.specialRates')}
          </Text>
          {regime.special_rate_items.map((item, i) => (
            <View key={`${item.key}-${i}`}>
              {i > 0 ? <Divider /> : null}
              <ComputeRow
                label={item.label}
                section={
                  item.section
                    ? `${item.section} · ${formatRate(item.rate)}`
                    : formatRate(item.rate)
                }
                value={formatINR(item.tax)}
                note={
                  item.exemption_applied
                    ? `Exemption applied ${formatINR(item.exemption_applied)}`
                    : null
                }
              />
            </View>
          ))}
        </View>
      ) : null}

      <View>{render(taxRows)}</View>

      {regime.notes.length ? (
        <Surface tone="inset" padded={12}>
          <View style={{ gap: theme.spacing.xs }}>
            {regime.notes.map((note, i) => (
              <Text key={i} variant="bodySmall" color="muted">
                {note}
              </Text>
            ))}
          </View>
        </Surface>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

function RecommendationRow({ item }: { item: TaxRecommendation }) {
  const theme = useTheme();
  const t = useT();

  return (
    <View style={{ gap: theme.spacing.xs, paddingVertical: theme.spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing.sm }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="heading" style={{ fontSize: 14.5 }}>
            {item.title}
          </Text>
          {item.section ? (
            <Text variant="label" color="faint">
              {item.section}
            </Text>
          ) : null}
        </View>
        {item.estimated_saving ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Text
              variant="bodySmall"
              tabular
              style={{ color: theme.colors.accent, fontFamily: theme.fonts.bodySemiBold }}
            >
              {formatINR(item.estimated_saving)}
            </Text>
            <Text variant="label" color="faint" style={{ fontSize: 9 }}>
              {t('tax.saving')}
            </Text>
          </View>
        ) : null}
      </View>

      <Text variant="bodySmall" color="muted">
        {item.detail}
      </Text>

      {item.action ? (
        <Text variant="bodySmall" color="accent">
          {item.action}
        </Text>
      ) : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */

export function TaxResult({ result }: { result: IncomeCollectionResponse | null }) {
  const theme = useTheme();
  const t = useT();

  if (!result || !result.comparison) {
    return (
      <EmptyState
        title={t('tax.enterIncome')}
        message={t('tax.enterIncomeHint')}
        mark="ledger"
      />
    );
  }

  const { comparison, itr_form: itrForm, recommendations, deductions, tds } = result;
  const winner: RegimeComputation =
    comparison.recommended_regime === 'old' ? comparison.old : comparison.new;
  const loser: RegimeComputation =
    comparison.recommended_regime === 'old' ? comparison.new : comparison.old;

  const isRefund = winner.is_refund;
  const netAmount = Math.abs(winner.net_payable);

  return (
    <View style={{ gap: theme.spacing.xxxl }}>
      {/* ------------------------------------------------------ 1. the answer
          The one dark panel this screen gets, carrying the net position. */}
      <Surface tone="panel" padded={theme.spacing.xxl}>
        <View style={{ gap: theme.spacing.lg }}>
          <Metric
            label={isRefund ? t('tax.refund') : t('tax.netPayable')}
            value={formatINR(netAmount)}
            size="hero"
            tone="onPanel"
            caption={`${winner.label} · ${result.tax_year_label}`}
          />

          <View style={{ height: 1, backgroundColor: theme.colors.panelLine }} />

          <View style={{ flexDirection: 'row', gap: theme.spacing.xl }}>
            <Metric
              label={t('tax.totalLiability')}
              value={formatINR(winner.total_tax_liability)}
              size="md"
              tone="onPanel"
              style={{ flex: 1 }}
            />
            <Metric
              label={t('tax.effectiveRate')}
              value={formatRate(winner.effective_rate)}
              size="md"
              tone="onPanelAccent"
              style={{ flex: 1 }}
            />
          </View>

          {comparison.saving > 0 ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.sm,
                paddingTop: theme.spacing.xs,
              }}
            >
              <Text variant="bodySmall" color="onPanelAccent">
                {t('tax.youSave')} {formatINR(comparison.saving)}
              </Text>
              <Text variant="bodySmall" color="onPanelMuted">
                vs {loser.label}
              </Text>
            </View>
          ) : null}
        </View>
      </Surface>

      {/* -------------------------------------------------- 2. the comparison */}
      <Section title={t('tax.regimeComparison')} caption={comparison.summary || undefined}>
        <ComparisonBars
          left={{
            label: comparison.old.label,
            value: comparison.old.total_tax_liability,
            display: formatINR(comparison.old.total_tax_liability),
          }}
          right={{
            label: comparison.new.label,
            value: comparison.new.total_tax_liability,
            display: formatINR(comparison.new.total_tax_liability),
          }}
          winner={comparison.recommended_regime === 'old' ? 'left' : 'right'}
        />

        {comparison.breakeven_extra_deductions ? (
          <Surface tone="accent" padded={theme.spacing.lg}>
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="label" color="accent">
                {t('tax.breakeven')}
              </Text>
              <Text variant="metricSmall" tabular>
                {formatINR(comparison.breakeven_extra_deductions)}
              </Text>
              <Text variant="bodySmall" color="muted">
                {t('tax.breakevenBody')}
              </Text>
            </View>
          </Surface>
        ) : null}
      </Section>

      {/* ------------------------------------------------- 3+4. the derivation */}
      <Section title={t('tax.result')} caption={result.governing_act}>
        <View>
          <Disclosure
            title={winner.label}
            summary={`${t('tax.recommended')} · ${formatINR(winner.total_tax_liability)}`}
            initiallyOpen
          >
            <RegimeBreakdown regime={winner} />
          </Disclosure>

          <Divider />

          <Disclosure
            title={loser.label}
            summary={formatINR(loser.total_tax_liability)}
          >
            <RegimeBreakdown regime={loser} />
          </Disclosure>

          {winner.slab_bands.length ? (
            <>
              <Divider />
              <Disclosure
                title={t('tax.slabs')}
                summary={`${winner.label} · ${formatINR(winner.tax_on_normal_income)}`}
              >
                <SlabLadder
                  rows={winner.slab_bands.map((band) => ({
                    band: formatBand(band.from_amount, band.to_amount),
                    rate: formatRate(band.rate),
                    taxable: formatINR(band.taxable_in_band),
                    tax: formatINR(band.tax),
                    share:
                      winner.tax_on_normal_income > 0
                        ? band.tax / winner.tax_on_normal_income
                        : 0,
                    active: band.taxable_in_band > 0,
                  }))}
                />
              </Disclosure>
            </>
          ) : null}

          {deductions && deductions.entries.length ? (
            <>
              <Divider />
              <Disclosure
                title={t('tax.deductions')}
                summary={`${t('tax.oldRegime')} ${formatINR(deductions.total_old_regime)} · ${t('tax.newRegime')} ${formatINR(deductions.total_new_regime)}`}
              >
                <View>
                  {deductions.entries.map((entry, i) => (
                    <View key={entry.key}>
                      {i > 0 ? <Divider /> : null}
                      <ComputeRow
                        label={entry.short_label || entry.label}
                        section={entry.section}
                        value={formatINR(entry.qualifying)}
                        note={
                          entry.is_capped && entry.limit
                            ? `${t('tax.cappedAt', { amount: formatINR(entry.limit) })}${entry.limit_reason ? ` — ${entry.limit_reason}` : ''}`
                            : entry.headroom > 0
                              ? t('tax.headroomLeft', { amount: formatINR(entry.headroom) })
                              : null
                        }
                      />
                    </View>
                  ))}
                </View>
              </Disclosure>
            </>
          ) : null}

          {tds && (tds.total_prepaid > 0 || tds.by_head.length) ? (
            <>
              <Divider />
              <Disclosure
                title={t('tax.taxesPaid')}
                summary={formatINR(tds.total_prepaid)}
              >
                <View>
                  {tds.by_head.map((entry, i) => (
                    <View key={`${entry.head}-${i}`}>
                      {i > 0 ? <Divider /> : null}
                      <ComputeRow
                        label={`${t('tax.tds')} — ${entry.label}`}
                        value={formatINR(entry.amount)}
                      />
                    </View>
                  ))}
                  {tds.advance_tax ? (
                    <>
                      <Divider />
                      <ComputeRow
                        label={t('tax.advanceTax')}
                        value={formatINR(tds.advance_tax)}
                      />
                    </>
                  ) : null}
                  {tds.self_assessment_tax ? (
                    <>
                      <Divider />
                      <ComputeRow
                        label={t('tax.selfAssessment')}
                        value={formatINR(tds.self_assessment_tax)}
                      />
                    </>
                  ) : null}
                  <Divider />
                  <ComputeRow
                    label={t('common.total')}
                    value={formatINR(tds.total_prepaid)}
                    emphasis
                  />
                </View>
              </Disclosure>
            </>
          ) : null}
        </View>
      </Section>

      {/* -------------------------------------------------------- 5. the form */}
      {itrForm ? (
        <Section title={t('tax.itrForm')}>
          <Surface tone="outlined" padded={theme.spacing.lg}>
            <View style={{ gap: theme.spacing.md }}>
              <View style={{ gap: 3 }}>
                <Text variant="metric">{itrForm.form}</Text>
                <Text variant="bodySmall" color="muted">
                  {itrForm.name}
                </Text>
              </View>

              <Text variant="bodySmall" color="muted">
                {itrForm.description}
              </Text>

              {itrForm.reasons.length ? (
                <View style={{ gap: theme.spacing.xs }}>
                  <Text variant="label" color="faint">
                    {t('tax.itrWhy')}
                  </Text>
                  {itrForm.reasons.map((reason, i) => (
                    <View
                      key={i}
                      style={{ flexDirection: 'row', gap: theme.spacing.sm }}
                    >
                      <Text variant="bodySmall" color="accent">
                        ·
                      </Text>
                      <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
                        {reason}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {itrForm.ruled_out.length ? (
                <Disclosure
                  title={t('tax.itrRuledOut')}
                  summary={itrForm.ruled_out.map((r) => r.form).join(' · ')}
                >
                  <View style={{ gap: theme.spacing.sm }}>
                    {itrForm.ruled_out.map((r, i) => (
                      <View key={`${r.form}-${i}`} style={{ gap: 2 }}>
                        <Text variant="bodySmall" style={{ fontFamily: theme.fonts.bodySemiBold }}>
                          {r.form}
                        </Text>
                        <Text variant="bodySmall" color="faint">
                          {r.reason}
                        </Text>
                      </View>
                    ))}
                  </View>
                </Disclosure>
              ) : null}
            </View>
          </Surface>
        </Section>
      ) : null}

      {/* ------------------------------------------------------ 6. the advice */}
      {recommendations.length ? (
        <Section
          title={t('tax.suggestions')}
          caption={`${recommendations.length}`}
        >
          <View>
            {recommendations.map((item, i) => (
              <View key={item.key}>
                {i > 0 ? <Divider /> : null}
                <RecommendationRow item={item} />
              </View>
            ))}
          </View>
        </Section>
      ) : null}

      {/* ------------------------------------------------------- the warnings */}
      {result.warnings.length ? (
        <Section title={t('tax.warnings')}>
          <Surface tone="inset" padded={theme.spacing.lg}>
            <View style={{ gap: theme.spacing.sm }}>
              {result.warnings.map((warning, i) => (
                <View key={i} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                  <Text variant="bodySmall" color="warn">
                    !
                  </Text>
                  <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
                    {warning}
                  </Text>
                </View>
              ))}
            </View>
          </Surface>
        </Section>
      ) : null}

      {result.disclaimer ? (
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="label" color="faint">
            {t('tax.disclaimer')}
          </Text>
          <Text variant="bodySmall" color="faint" style={{ fontSize: 11.5, lineHeight: 17 }}>
            {result.disclaimer}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
