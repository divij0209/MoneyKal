import React, { useCallback, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useNavigation } from '@react-navigation/native';

import { ApiError } from '../../api';
import type { StashItem } from '../../api/types';
import { Glyph, Text } from '../../components';
import { Backdrop } from './components/Backdrop';
import { CheckPanel } from './components/CheckPanel';
import {
  AdventureSection,
  CategoriesSection,
  Hero,
  MomentSection,
  StashSection,
} from './components/Sections';
import { StashSheet, type SheetState } from './components/StashSheet';
import { INK, INK_FAINT, INK_MUTED, LlfButton, LlfCard } from './components/shared';
import { DEFAULT_CATEGORY } from './constants';
import { useAccentCycle, useAffordability, useLiveLife, useSeenMoments } from './hooks';

/**
 * live.life.fully.
 *
 * The counterweight to the rest of MoneyKal: not "what did you spend", but
 * "what can you go and enjoy without breaking anything". Every number on it —
 * the Freedom Balance, the moment, the countdown, the verdict — is computed by
 * the backend from the same profile and the same ledger the Home screen reads.
 * The client renders display strings and asks two questions.
 *
 * It is a full-screen modal rather than a tab, matching the web, where the
 * portal is deliberately not a `.navitem`: this is somewhere you go, not a
 * section you browse.
 *
 * Its ground is its own — one still gradient under a soft cyan glow, ignoring
 * the light/dark toggle exactly as the web's `#llf` overlay does. The video,
 * the particle field and the six-colour accent rotation that used to live here
 * are gone; see the notes on components/Backdrop.tsx and constants.ts. Cyan is
 * now the resting accent and the only one, which is what the current web
 * stylesheet asks for and what keeps this inside the three-colour palette.
 */
export function LiveLifeScreen() {
  const navigation = useNavigation();
  const { localDate, query, createStash, fundStash } = useLiveLife();
  // One accent now, held rather than cycled. See constants.ts.
  const { accent } = useAccentCycle();
  const affordability = useAffordability(localDate);
  const { pick } = useSeenMoments();

  const [sheet, setSheet] = useState<SheetState>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const checkY = useRef(0);
  const stashY = useRef(0);

  const data = query.data;
  const currency = data?.user.currency || '₹';
  const { moment, repeat } = pick(data);

  const scrollTo = useCallback((y: number) => {
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 20), animated: true });
  }, []);

  /* A moment's action targets `stash:{id}` — open that stash's fund sheet;
     anything else sends the user to the categories, as the web does. */
  const handleMomentAction = useCallback(
    (target: string) => {
      if (target.startsWith('stash:')) {
        const id = Number(target.split(':')[1]);
        const item = data?.stash.items.find((s) => s.id === id);
        if (item) {
          setSheetError(null);
          setSheet({ kind: 'fund', item });
          return;
        }
      }
      scrollTo(stashY.current);
    },
    [data, scrollTo],
  );

  const handleAsk = useCallback(
    (amount: number, goalId?: number) => {
      void affordability.ask(amount, goalId ?? null);
      scrollTo(checkY.current);
    },
    [affordability, scrollTo],
  );

  const handleCreate = useCallback(
    async (payload: Parameters<typeof createStash.mutateAsync>[0]) => {
      setSheetError(null);
      try {
        await createStash.mutateAsync(payload);
        setSheet(null);
      } catch (err) {
        setSheetError(
          err instanceof ApiError ? err.detail : 'That did not save. Try again.',
        );
      }
    },
    [createStash],
  );

  const handleFund = useCallback(
    async (item: StashItem, addAmount: number) => {
      setSheetError(null);
      // The goals API refuses a current_amount above the target, so a generous
      // top-up lands the stash on its target rather than being rejected. Same
      // line the web takes, and the only arithmetic on this screen.
      const next = Math.min(item.current_amount + addAmount, item.target_amount);
      try {
        await fundStash.mutateAsync({ id: item.id, nextAmount: next });
        setSheet(null);
      } catch (err) {
        setSheetError(
          err instanceof ApiError ? err.detail : 'That did not save. Try again.',
        );
      }
    },
    [fundStash],
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#05060a' }}>
      <Backdrop />

      <SafeAreaView style={{ flex: 1 }} edges={['top', 'bottom', 'left', 'right']}>
        <StatusBar style="light" />

        {/* Close, as the web's portal has. */}
        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 12 }}>
          <Pressable
            onPress={() => navigation.goBack()}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Close live.life.fully"
            style={({ pressed }) => ({ padding: 10, opacity: pressed ? 0.6 : 1 })}
          >
            <Glyph name="close" color="rgba(244,242,238,0.6)" size={22} strokeWidth={2} />
          </Pressable>
        </View>

        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 48, gap: 30 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={query.isRefetching}
              onRefresh={() => void query.refetch()}
              tintColor={accent}
              colors={[accent]}
            />
          }
        >
          {/* ------------------------------------------------------ identity */}
          <View style={{ gap: 6, paddingTop: 4 }}>
            <Text variant="display" style={{ color: INK, fontSize: 32, lineHeight: 38 }}>
              {data?.identity.tagline ?? 'live.life.fully'}
            </Text>
            {(data?.identity.lines ?? []).map((l, i) => (
              <Text key={i} variant="bodySmall" style={{ color: INK_MUTED }}>
                {l}
              </Text>
            ))}
          </View>

          {query.isLoading ? (
            <Text variant="bodySmall" style={{ color: INK_FAINT }}>
              Loading…
            </Text>
          ) : query.isError ? (
            <LlfCard>
              <Text variant="heading" style={{ color: INK }}>
                Could not load this right now
              </Text>
              <Text variant="bodySmall" style={{ color: INK_MUTED }}>
                {query.error instanceof ApiError
                  ? query.error.detail
                  : 'Please try again.'}
              </Text>
              <View style={{ flexDirection: 'row', marginTop: 6 }}>
                <LlfButton
                  label="Try again"
                  variant="primary"
                  accent={accent}
                  onPress={() => void query.refetch()}
                />
              </View>
            </LlfCard>
          ) : data ? (
            <>
              {/* A brand-new account gets the honest empty state rather than a
                  screen of dashes — the backend flags it explicitly. */}
              {!data.has_financial_data ? (
                <LlfCard>
                  <Text variant="heading" style={{ color: INK }}>
                    Nothing to read yet
                  </Text>
                  <Text variant="bodySmall" style={{ color: INK_MUTED }}>
                    Add your income, your expenses and what you have saved, and MoneyKal can tell
                    you what is genuinely free to enjoy.
                  </Text>
                </LlfCard>
              ) : null}

              <Hero freedom={data.freedom_balance} accent={accent} />

              <MomentSection
                moment={moment}
                repeat={repeat}
                locked={data.moment_locked}
                accent={accent}
                onAction={handleMomentAction}
                onCheckFirst={() => scrollTo(checkY.current)}
              />

              {data.upcoming_adventure ? (
                <AdventureSection adventure={data.upcoming_adventure} />
              ) : null}

              <View onLayout={(e) => (stashY.current = e.nativeEvent.layout.y)}>
                <StashSection
                  stash={data.stash}
                  onFund={(item) => {
                    setSheetError(null);
                    setSheet({ kind: 'fund', item });
                  }}
                  onCreate={(categoryKey) => {
                    setSheetError(null);
                    setSheet({ kind: 'create', categoryKey });
                  }}
                  onAsk={handleAsk}
                />
              </View>

              <CategoriesSection
                categories={data.categories}
                onOpen={() => scrollTo(stashY.current)}
                onCreate={(categoryKey) => {
                  setSheetError(null);
                  setSheet({ kind: 'create', categoryKey: categoryKey || DEFAULT_CATEGORY });
                }}
              />

              <View onLayout={(e) => (checkY.current = e.nativeEvent.layout.y)}>
                <CheckPanel
                  currency={currency}
                  accent={accent}
                  recommendation={data.recommendation}
                  verdict={affordability.verdict}
                  error={affordability.error}
                  pending={affordability.pending}
                  onAsk={(amount) => handleAsk(amount)}
                />
              </View>
            </>
          ) : null}
        </ScrollView>
      </SafeAreaView>

      <StashSheet
        state={sheet}
        currency={currency}
        saving={createStash.isPending || fundStash.isPending}
        error={sheetError}
        onClose={() => setSheet(null)}
        onCreate={handleCreate}
        onFund={handleFund}
      />
    </View>
  );
}
