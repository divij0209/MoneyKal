import React, { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, View } from 'react-native';

import {
  Button,
  Divider,
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  SegmentedControl,
  Surface,
  Text,
} from '../../components';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { TaxResult } from './components/TaxResult';
import {
  BusinessSection,
  CapitalGainsSection,
  DeductionsSection,
  HousePropertySection,
  OtherSourcesSection,
  SalarySection,
  TaxesPaidSection,
  TaxpayerSection,
} from './components/TaxInputs';
import { formatINR, useTaxConfig, useTaxForm } from './hooks';

/**
 * The Individual Tax Calculator.
 *
 * Two panes behind one switcher — Income and Result — because a tax form and
 * a tax computation want opposite layouts, and cramming both into one scroll
 * makes each worse.
 *
 * The Income pane carries a running position above the switcher, so a figure
 * typed into the form is answered without leaving it. The Result pane does
 * not: its own hero states the same number, and two dark panels stating one
 * answer is worse than one.
 *
 * The feature is complete on the backend: POST /tax/collect returns the heads,
 * the Chapter VI-A deductions, TDS, both regimes with slabs and surcharge, the
 * old-vs-new comparison including the break-even, the ranked recommendations
 * and the ITR form selection. This screen renders all of it and computes none
 * of it.
 *
 * Individual-only, enforced by the backend (see `_individual_profile` in
 * backend/routers/tax.py). A 403 renders as a state, not as an error.
 */

type Pane = 'enter' | 'result';

export function TaxScreen() {
  const theme = useTheme();
  const t = useT();

  const config = useTaxConfig();
  const form = useTaxForm();

  const [pane, setPane] = useState<Pane>('enter');

  /* ---------------------------------------------------------------- states */

  if (form.loading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (form.forbidden) {
    return (
      <Screen scroll>
        <EmptyState
          title={t('tax.title')}
          message={t('tax.individualOnly')}
          mark="warning"
        />
      </Screen>
    );
  }

  const result = form.result;
  const comparison = result?.comparison ?? null;
  const winner =
    comparison?.recommended_regime === 'old' ? comparison?.old : comparison?.new;

  /* ------------------------------------------------------------- the header
     The running position, shown ONLY on the Enter pane.

     It exists so the form answers itself: change a number and the figure
     above it moves. On the Result pane it would be the second dark panel
     stating the same number as the hero directly below it — two answers to
     one question, and a screen with two feature panels has none. */

  const header = (
    <Surface tone="panel" padded={theme.spacing.xl} style={{ marginBottom: theme.spacing.xl }}>
      <View style={{ gap: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="label" color="onPanelMuted" style={{ flex: 1 }}>
            {result?.tax_year_label ?? config.data?.labels?.fy ?? t('tax.taxYear')}
          </Text>
          {form.computing ? <ActivityIndicator size="small" color={theme.colors.panelAccent} /> : null}
        </View>

        {winner ? (
          <>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.lg }}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="label" color="onPanelMuted">
                  {winner.is_refund ? t('tax.refund') : t('tax.netPayable')}
                </Text>
                <Text
                  variant="metric"
                  tabular
                  color="onPanel"
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.6}
                >
                  {formatINR(Math.abs(winner.net_payable))}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 2 }}>
                <Text variant="label" color="onPanelMuted">
                  {t('tax.recommended')}
                </Text>
                <Text variant="heading" color="onPanelAccent" numberOfLines={1}>
                  {winner.label}
                </Text>
              </View>
            </View>

            {comparison && comparison.saving > 0 ? (
              <Text variant="bodySmall" color="onPanelMuted">
                {t('tax.youSave')} {formatINR(comparison.saving)}
              </Text>
            ) : null}
          </>
        ) : (
          <View style={{ gap: 2 }}>
            <Text variant="metric" color="onPanel">
              —
            </Text>
            <Text variant="bodySmall" color="onPanelMuted">
              {form.computing ? t('tax.computing') : t('tax.enterIncomeHint')}
            </Text>
          </View>
        )}
      </View>
    </Surface>
  );

  const switcher = (
    <SegmentedControl<Pane>
      value={pane}
      onChange={setPane}
      segments={[
        { value: 'enter', label: t('tax.incomeHeads') },
        { value: 'result', label: t('tax.result') },
      ]}
      style={{ marginBottom: theme.spacing.xl }}
    />
  );

  /* ----------------------------------------------------------------- panes */

  const enterPane = (
    <View style={{ gap: theme.spacing.xxxl }}>
      <TaxpayerSection form={form} config={config.data} />
      <Divider />
      <SalarySection form={form} />
      <Divider />
      <HousePropertySection form={form} />
      <Divider />
      <BusinessSection form={form} />
      <Divider />
      <CapitalGainsSection form={form} />
      <Divider />
      <OtherSourcesSection form={form} />
      <Divider />
      <DeductionsSection form={form} config={config.data} />
      <Divider />
      <TaxesPaidSection form={form} />

      <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.sm }}>
        <Button
          label={form.save.isPending ? t('common.saving') : t('tax.saveProfile')}
          onPress={() => form.save.mutate()}
          loading={form.save.isPending}
        />
        {form.save.isSuccess ? (
          <Text variant="bodySmall" color="accent" center>
            {t('tax.savedProfile')}
          </Text>
        ) : null}
        {form.save.isError ? (
          <Text variant="bodySmall" color="warn" center>
            {t('common.somethingWrong')}
          </Text>
        ) : null}
      </View>
    </View>
  );

  const resultPane = form.computeError ? (
    <ErrorState error={form.computeError} onRetry={form.recomputeNow} />
  ) : (
    <TaxResult result={result} />
  );

  return (
    <Screen scroll>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ paddingTop: theme.spacing.lg }}>
          {pane === 'enter' ? header : null}
          {switcher}
          {pane === 'enter' ? enterPane : resultPane}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
