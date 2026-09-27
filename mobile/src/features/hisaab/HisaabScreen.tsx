import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { BottomTabScreenProps } from '@react-navigation/bottom-tabs';

import type { TransactionPayload } from '../../api/endpoints/hisaab';
import type { Transaction } from '../../api/types';
import {
  Button,
  Divider,
  EmptyState,
  ErrorState,
  FlowChart,
  FlowLegend,
  Metric,
  Screen,
  SectionHeader,
  SegmentedControl,
  Skeleton,
  Surface,
  Text,
} from '../../components';
import { useT } from '../../i18n';
import type { IndividualTabParamList } from '../../navigation/types';
import { useTheme } from '../../theme';
import { ActivityCalendar } from './components/ActivityCalendar';
import { FilterBar } from './components/FilterBar';
import { CategoryBreakdown, LedgerHeader } from './components/LedgerHeader';
import { ReceiptScanner } from './components/ReceiptScanner';
import { TransactionList } from './components/TransactionList';
import { TransactionSheet, type TransactionDraft } from './components/TransactionSheet';
import { formatAmount } from './constants';
import {
  useHisaab,
  useHisaabFilters,
  useHisaabMutations,
  useHisaabTrend,
  useHisaabView,
} from './hooks';

type Props = BottomTabScreenProps<IndividualTabParamList, 'Hisaab'>;
type Tab = 'overview' | 'categories' | 'trends';

/**
 * Hisaab — the ledger.
 *
 * A professional ledger rather than an expense tracker: the position first
 * (in, out, net, on the one dark panel), then the transactions as ruled rows,
 * then composition and trend behind a switcher so each view gets the whole
 * width instead of three cramped panels stacked.
 *
 * Everything on this screen is a view over the single GET /startup/hisaab
 * response: the summary figures are the API's own, and the calendar, the day
 * grouping, the monthly rollup and every filter run over the `transactions`
 * array it already returned. That is how the web works too, and it is why
 * paging months or picking a day costs no request.
 *
 * The `date` route param is the hand-off from the Home calendar — the mobile
 * equivalent of the web's `setHisaabDateFilter(dateKey, {navigate: true})` and
 * its `?date=` deep link.
 */
export function HisaabScreen({ route, navigation }: Props) {
  const theme = useTheme();
  const t = useT();
  const query = useHisaab();
  const mutations = useHisaabMutations();

  const routeDate = route.params?.date ?? null;
  const filterState = useHisaabFilters(routeDate);
  const {
    filters,
    setDate,
    shiftMonth,
    goToday,
    setType,
    setCategory,
    setSearch,
    clearAll,
    hasFilters,
  } = filterState;

  const [tab, setTab] = useState<Tab>('overview');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [prefill, setPrefill] = useState<Partial<TransactionDraft> | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  /* Arriving from Home with a date — or arriving again with a different one.
     Consumed once and then cleared from the route, so navigating back to the
     tab later doesn't silently re-apply a stale day. A date hand-off also
     forces the Overview tab, since that is where the ledger rows live. */
  useEffect(() => {
    if (!routeDate) return;
    setDate(routeDate);
    setTab('overview');
    navigation.setParams({ date: undefined });
  }, [routeDate, setDate, navigation]);

  const data = query.data;
  const currency = data?.currency || '₹';
  const view = useHisaabView(data?.transactions ?? [], filters);
  const trend = useHisaabTrend(data?.transactions ?? []);

  const setBusy = useCallback((id: number, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (payload: TransactionPayload, editingId: number | null) => {
      if (editingId) {
        setBusy(editingId, true);
        try {
          await mutations.update.mutateAsync({ id: editingId, payload });
        } finally {
          setBusy(editingId, false);
        }
      } else {
        await mutations.create.mutateAsync(payload);
      }
    },
    [mutations.create, mutations.update, setBusy],
  );

  const handleDelete = useCallback(
    async (txn: Transaction) => {
      setBusy(txn.id, true);
      try {
        await mutations.remove.mutateAsync(txn.id);
      } finally {
        setBusy(txn.id, false);
      }
    },
    [mutations.remove, setBusy],
  );

  const openAdd = useCallback(() => {
    setEditing(null);
    // A day picked on the calendar is the day the new entry most likely
    // belongs to, so it carries into the form.
    setPrefill(filters.date ? { txn_date: filters.date } : null);
    setSheetOpen(true);
  }, [filters.date]);

  const openEdit = useCallback((txn: Transaction) => {
    setEditing(txn);
    setPrefill(null);
    setSheetOpen(true);
  }, []);

  /* --------------------------------------------------------------- states */

  if (query.isLoading && !data) {
    return (
      <Screen scroll>
        <View style={{ gap: theme.spacing.xxl, paddingTop: theme.spacing.lg }}>
          <Skeleton height={190} radius={theme.radius.xl} />
          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Skeleton height={50} radius={theme.radius.md} style={{ flex: 1.3 }} />
            <Skeleton height={50} radius={theme.radius.md} style={{ flex: 1 }} />
          </View>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ gap: theme.spacing.sm }}>
              <Skeleton width="35%" height={11} />
              <Skeleton height={16} />
              <Skeleton height={16} />
            </View>
          ))}
        </View>
      </Screen>
    );
  }

  if (query.isError && !data) {
    return (
      <Screen scroll>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Screen>
    );
  }

  if (!data) return null;

  const hasAny = (data.transactions ?? []).length > 0;

  /* ---------------------------------------------------------------- panes */

  const overviewPane = (
    <View style={{ gap: theme.spacing.xxxl }}>
      <View style={{ gap: theme.spacing.lg }}>
        <SectionHeader title={t('home.calendar')} icon="calendar" />
        <ActivityCalendar
          activity={view.activity}
          month={filters.month}
          selected={filters.date}
          currency={currency}
          onSelect={setDate}
          onShiftMonth={shiftMonth}
          onToday={goToday}
        />
      </View>

      <Divider />

      <View style={{ gap: theme.spacing.lg }}>
        <SectionHeader
          title={t('hisaab.transactions')}
          icon="wallet"
          subtitle={`${data.transactions.length}`}
        />

        <FilterBar
          filters={filters}
          totals={view.filteredTotals}
          categories={view.presentCategories}
          currency={currency}
          hasFilters={hasFilters}
          onSetType={setType}
          onSetCategory={setCategory}
          onSetSearch={setSearch}
          onClearDate={() => setDate(null)}
          onClearAll={clearAll}
        />

        {view.groups.length ? (
          <TransactionList
            groups={view.groups}
            currency={currency}
            onOpen={openEdit}
            busyIds={busyIds}
          />
        ) : (
          <EmptyState
            title={t('hisaab.noMatch')}
            message={t('hisaab.noMatchHint')}
            mark="search"
            actionLabel={t('common.clear')}
            onAction={clearAll}
            compact
          />
        )}
      </View>
    </View>
  );

  const categoriesPane = <CategoryBreakdown data={data} />;

  const trendsPane = trend.length ? (
    <View style={{ gap: theme.spacing.xxl }}>
      <View style={{ gap: theme.spacing.lg }}>
        <Text variant="title">{t('hisaab.trends')}</Text>
        <FlowChart data={trend} height={160} />
        <FlowLegend inLabel={t('hisaab.moneyIn')} outLabel={t('hisaab.moneyOut')} />
      </View>

      <Divider />

      {/* The same periods as ruled rows, because a column chart shows shape
          and a reader still wants the figure. */}
      <View>
        {[...trend].reverse().map((period, i) => (
          <View
            key={period.key}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.md,
              paddingVertical: theme.spacing.md,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Text variant="body" style={{ width: 46 }}>
              {period.label}
            </Text>
            <Text variant="mono" tabular color="muted" style={{ flex: 1, textAlign: 'right' }}>
              {formatAmount(period.income, currency)}
            </Text>
            <Text variant="mono" tabular color="muted" style={{ flex: 1, textAlign: 'right' }}>
              {formatAmount(period.expense, currency)}
            </Text>
            <Text
              variant="mono"
              tabular
              style={{
                flex: 1,
                textAlign: 'right',
                fontFamily: theme.fonts.bodySemiBold,
                color: period.net >= 0 ? theme.colors.accent : theme.colors.ink,
              }}
            >
              {formatAmount(period.net, currency)}
            </Text>
          </View>
        ))}
      </View>
    </View>
  ) : (
    <EmptyState title={t('common.noData')} mark="ledger" compact />
  );

  return (
    <>
      <Screen scroll onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
        <View
          style={{
            gap: theme.spacing.xxxl,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.huge,
          }}
        >
          <LedgerHeader data={data} />

          {/* Primary actions. Add is the common one; scanning sits beside it
              because a receipt is the other way a transaction starts. */}
          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Button
              label={t('hisaab.addTransaction')}
              onPress={openAdd}
              fullWidth={false}
              style={{ flex: 1.3 }}
            />
            <Button
              label={t('hisaab.scanReceipt')}
              variant="outline"
              onPress={() => setScannerOpen(true)}
              fullWidth={false}
              style={{ flex: 1 }}
            />
          </View>

          {hasAny ? (
            <>
              <SegmentedControl<Tab>
                value={tab}
                onChange={setTab}
                scrollable
                segments={[
                  { value: 'overview', label: t('hisaab.overview') },
                  { value: 'categories', label: t('hisaab.categories') },
                  { value: 'trends', label: t('hisaab.trends') },
                ]}
              />

              {tab === 'overview'
                ? overviewPane
                : tab === 'categories'
                  ? categoriesPane
                  : trendsPane}
            </>
          ) : (
            <>
              <Divider />
              <EmptyState
                title={t('hisaab.noTransactions')}
                message={t('hisaab.noTransactionsHint')}
                mark="ledger"
                actionLabel={t('hisaab.addTransaction')}
                onAction={openAdd}
              />
            </>
          )}
        </View>
      </Screen>

      <TransactionSheet
        visible={sheetOpen}
        editing={editing}
        initial={prefill}
        onClose={() => {
          setSheetOpen(false);
          setEditing(null);
          setPrefill(null);
        }}
        onSubmit={handleSubmit}
        onDelete={handleDelete}
      />

      <ReceiptScanner
        visible={scannerOpen}
        currency={currency}
        onClose={() => setScannerOpen(false)}
        onUseResult={(draft) => {
          setEditing(null);
          setPrefill(draft);
          setSheetOpen(true);
        }}
      />
    </>
  );
}
