import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import type {
  CalendarEvent,
  GoalResponse,
  Recurrence,
  UpcomingResponse,
} from '../../api/types';
import { Divider, Screen, Text } from '../../components';
import { useT } from '../../i18n';
import type { AppStackParamList } from '../../navigation/types';
import { useProfile } from '../../store';
import { useTheme } from '../../theme';
import { ActionRow, type QuickAction } from './components/ActionRow';
import { CalendarSection } from './components/CalendarSection';
import { ChangeSection } from './components/ChangeSection';
import { EventDetailSheet, UpcomingDetailSheet } from './components/DetailSheets';
import { GoalSection } from './components/GoalSection';
import { GoalSheet } from './components/GoalSheet';
import { GreetingHeader } from './components/GreetingHeader';
import { HomeError, HomeOnboarding, HomeSkeleton } from './components/HomeStates';
import { InsightCard } from './components/InsightCard';
import { MarketPulseSection } from './components/MarketPulseSection';
import { PortalRow } from './components/PortalRow';
import { PositionPanel } from './components/PositionPanel';
import { SpendingSection } from './components/SpendingSection';
import { UpcomingSection } from './components/UpcomingSection';
import { UpcomingSheet } from './components/UpcomingSheet';
import { useCalendarMonth, useHome, useHomeMutations, useMarketPulse } from './hooks';

/**
 * The Individual's Home.
 *
 * Ordered to answer, in this sequence and no other:
 *
 *   1. What is my position?        PositionPanel  — the one dark surface
 *   2. What changed?               ChangeSection
 *   3. Why did it change?          ChangeSection
 *   4. What does MoneyKal say?     InsightCard    — the one tinted surface
 *   5. What can I do about it?     ActionRow
 *   … then the working detail: upcoming, goals, spending, calendar, market.
 *
 * Two enclosed blocks on the whole screen. Everything else is separated by
 * headings, whitespace and hairlines, because a dashboard where every section
 * is a card reads as a settings list — the figures have to carry the
 * hierarchy, not the boxes around them.
 *
 * One consolidated GET /home drives everything above Market Pulse. No figure
 * on this screen is computed here: the backend returns display-ready strings
 * (`display`, `amount_display`, `current_display`, the insight copy, the
 * urgency labels) and this renders them. That is the same rule the web's
 * home.js follows, and it is what keeps the two clients from ever disagreeing.
 */
export function HomeScreen() {
  const theme = useTheme();
  const t = useT();
  const navigation = useNavigation<NativeStackNavigationProp<AppStackParamList>>();
  const { persona } = useProfile();

  const home = useHome();
  const marketPulse = useMarketPulse();
  const mutations = useHomeMutations();

  const calendar = useCalendarMonth(home.data?.calendar);

  const [goalSheet, setGoalSheet] = useState<{ open: boolean; goal: GoalResponse | null }>({
    open: false,
    goal: null,
  });
  const [upcomingSheetOpen, setUpcomingSheetOpen] = useState(false);
  const [detailItem, setDetailItem] = useState<UpcomingResponse | null>(null);
  const [detailEvent, setDetailEvent] = useState<CalendarEvent | null>(null);
  const [busyIds, setBusyIds] = useState<Set<number>>(new Set());

  const setBusy = useCallback((id: number, on: boolean) => {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /* ------------------------------------------------------------ navigation */

  const goHisaab = useCallback(
    (date?: string) => {
      navigation.navigate('Tabs', { screen: 'Hisaab', params: date ? { date } : undefined } as never);
    },
    [navigation],
  );

  /** An insight's action names a web view. 'overview' means "look just below",
   *  so it stays on this screen rather than navigating to where you already
   *  are — the same branch the web takes. */
  const handleInsightAction = useCallback(
    (view: string) => {
      if (view === 'overview' || view === 'home') return;
      if (view === 'hisaab') return goHisaab();
      if (view === 'tax') return navigation.navigate('Tax');
      if (view === 'simulate') return navigation.navigate('Tabs', { screen: 'Simulate' } as never);
      if (view === 'ask') return navigation.navigate('Tabs', { screen: 'Ask' } as never);
      if (view === 'reports') return navigation.navigate('Reports');
    },
    [goHisaab, navigation],
  );

  /* The four verbs under the recommendation. Tax is Individual-only on the
     web (`navTax` is gated on the profile key in tax.js) and the backend
     refuses it for other personas, so it is swapped for Reports on Startup
     rather than offered and then rejected. */
  const actions: QuickAction[] = useMemo(
    () => [
      { key: 'hisaab', label: t('nav.hisaab'), glyph: 'ledger', onPress: () => goHisaab() },
      persona === 'startup'
        ? {
            key: 'reports',
            label: t('nav.reports'),
            glyph: 'report' as const,
            onPress: () => navigation.navigate('Reports'),
          }
        : {
            key: 'tax',
            label: t('nav.taxShort'),
            glyph: 'receipt' as const,
            onPress: () => navigation.navigate('Tax'),
          },
      {
        key: 'simulate',
        label: t('nav.simulate'),
        glyph: 'simulate',
        onPress: () => navigation.navigate('Tabs', { screen: 'Simulate' } as never),
      },
      {
        key: 'ask',
        label: t('nav.ask'),
        glyph: 'chat',
        onPress: () => navigation.navigate('Tabs', { screen: 'Ask' } as never),
      },
    ],
    [goHisaab, navigation, persona, t],
  );

  /* ------------------------------------------------------------- mutations */

  const runOn = useCallback(
    async (id: number, fn: () => Promise<unknown>) => {
      setBusy(id, true);
      try {
        await fn();
      } catch {
        // The list is refetched on success; on failure the row simply returns
        // to its previous state rather than showing a half-applied change.
      } finally {
        setBusy(id, false);
      }
    },
    [setBusy],
  );

  const handleMarkPaid = useCallback(
    (item: UpcomingResponse) => {
      setDetailItem(null);
      void runOn(item.id, () => mutations.markPaid.mutateAsync(item.id));
    },
    [mutations.markPaid, runOn],
  );

  const handleDeleteUpcoming = useCallback(
    (item: UpcomingResponse) => {
      setDetailItem(null);
      void runOn(item.id, () => mutations.deleteUpcoming.mutateAsync(item.id));
    },
    [mutations.deleteUpcoming, runOn],
  );

  const handleConfirm = useCallback(
    (item: UpcomingResponse) =>
      runOn(item.id, () => mutations.confirmSuggestion.mutateAsync(item.id)),
    [mutations.confirmSuggestion, runOn],
  );

  const handleDismiss = useCallback(
    (item: UpcomingResponse) =>
      runOn(item.id, () => mutations.dismissSuggestion.mutateAsync(item.id)),
    [mutations.dismissSuggestion, runOn],
  );

  const handleRefresh = useCallback(() => {
    void home.refetch();
    void marketPulse.refetch();
  }, [home, marketPulse]);

  /* ---------------------------------------------------------------- states */

  if (home.isLoading && !home.data) {
    return (
      <Screen scroll>
        <HomeSkeleton />
      </Screen>
    );
  }

  if (home.isError && !home.data) {
    return (
      <Screen scroll>
        <HomeError error={home.error} onRetry={() => void home.refetch()} />
      </Screen>
    );
  }

  const data = home.data;
  if (!data) return null;

  if (!data.has_financial_data) {
    return (
      <Screen scroll onRefresh={handleRefresh} refreshing={home.isRefetching}>
        <HomeOnboarding
          insight={data.insight}
          greeting={data.user.greeting}
          name={data.user.name}
          onEditProfile={() => navigation.navigate('Profile')}
          onGoHisaab={() => goHisaab()}
        />
      </Screen>
    );
  }

  /** The rhythm rule: `xxxl` between groups, `lg` within one. */
  const sectionGap = theme.spacing.xxxl;

  return (
    <>
      <Screen scroll onRefresh={handleRefresh} refreshing={home.isRefetching}>
        <View style={{ gap: sectionGap, paddingBottom: theme.spacing.xl }}>
          {/* 1 — position */}
          <View style={{ gap: theme.spacing.xl }}>
            <GreetingHeader user={data.user} />
            <PositionPanel
              snapshot={data.financial_snapshot}
              spending={data.spending_overview}
              onEditProfile={() => navigation.navigate('Profile')}
              onGoHisaab={() => goHisaab()}
            />
          </View>

          {/* 2 + 3 — what changed, and why */}
          <ChangeSection
            snapshot={data.financial_snapshot}
            spending={data.spending_overview}
            onGoHisaab={() => goHisaab()}
          />

          {/* 4 — what MoneyKal recommends */}
          <InsightCard insight={data.insight} onAction={handleInsightAction} />

          {/* 5 — what the user can do */}
          <ActionRow actions={actions} />

          <Divider />

          <UpcomingSection
            upcoming={data.upcoming}
            busyIds={busyIds}
            onAdd={() => setUpcomingSheetOpen(true)}
            onOpenItem={setDetailItem}
            onMarkPaid={handleMarkPaid}
            onConfirmSuggestion={handleConfirm}
            onDismissSuggestion={handleDismiss}
          />

          <Divider />

          <GoalSection
            primary={data.primary_goal}
            goals={data.goals}
            onAdd={() => setGoalSheet({ open: true, goal: null })}
            onOpenGoal={(goal) => setGoalSheet({ open: true, goal })}
          />

          <Divider />

          <SpendingSection spending={data.spending_overview} onGoHisaab={() => goHisaab()} />

          <Divider />

          <CalendarSection
            calendar={calendar.calendar}
            timeline={data.timeline}
            loading={calendar.isLoading}
            onShiftMonth={calendar.shift}
            onToday={calendar.goToday}
            onAddEvent={() => setUpcomingSheetOpen(true)}
            onOpenEvent={setDetailEvent}
          />

          <Divider />

          <MarketPulseSection data={marketPulse.data} loading={marketPulse.isLoading} />

          {/* The two full-screen experiences. Neither is a tab, matching the
              web, where the live.life.fully portal is explicitly not a
              `.navitem` and VARTA is opened from inside Ask Twin. */}
          <View>
            <PortalRow
              first
              title={t('nav.varta')}
              subtitle={t('home.vartaTagline')}
              glyph="mic"
              onPress={() => navigation.navigate('Voice')}
            />
            <PortalRow
              title={t('nav.liveLife')}
              subtitle={t('home.liveLifeTagline')}
              glyph="spark"
              onPress={() => navigation.navigate('LiveLife')}
            />
          </View>
        </View>
      </Screen>

      {/* ------------------------------------------------------------ sheets */}

      <GoalSheet
        visible={goalSheet.open}
        goal={goalSheet.goal}
        onClose={() => setGoalSheet({ open: false, goal: null })}
        onCreate={async (payload) => {
          await mutations.createGoal.mutateAsync(payload);
        }}
        onUpdate={async (id, payload) => {
          await mutations.updateGoal.mutateAsync({ id, payload });
        }}
        onDelete={async (id) => {
          await mutations.deleteGoal.mutateAsync(id);
        }}
      />

      <UpcomingSheet
        visible={upcomingSheetOpen}
        onClose={() => setUpcomingSheetOpen(false)}
        onCreate={async (payload) => {
          await mutations.createUpcoming.mutateAsync({
            ...payload,
            recurrence: payload.recurrence as Recurrence,
          });
        }}
      />

      <UpcomingDetailSheet
        item={detailItem}
        busy={detailItem ? busyIds.has(detailItem.id) : false}
        onClose={() => setDetailItem(null)}
        onMarkPaid={handleMarkPaid}
        onDelete={handleDeleteUpcoming}
      />

      <EventDetailSheet
        event={detailEvent}
        onClose={() => setDetailEvent(null)}
        onOpenInHisaab={(dateKey) => {
          setDetailEvent(null);
          goHisaab(dateKey);
        }}
      />
    </>
  );
}
