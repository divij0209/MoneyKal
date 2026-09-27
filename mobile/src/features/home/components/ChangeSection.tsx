import React from 'react';
import { Pressable, View } from 'react-native';

import type { HomeResponse, SpendingCategory } from '../../../api/types';
import { BarMeter, Divider, Metric, Surface, Text } from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';

interface Props {
  snapshot: HomeResponse['financial_snapshot'];
  spending: HomeResponse['spending_overview'];
  onGoHisaab: () => void;
}

/**
 * Steps 2 and 3 of the dashboard's hierarchy: WHAT CHANGED, and WHY.
 *
 * These are the two questions the old Home never answered — it showed the
 * position and then went straight to a list of goals. The figures needed were
 * already in the payload (`change_pct` on monthly spending, `change_pct` and
 * `is_new` per category on the spending overview); nothing new is fetched
 * here, it is arranged so the movement is legible.
 *
 * "Why" is the honest version: the categories that moved most, ranked by the
 * size of the move rather than by the size of the spend, because a category
 * that doubled off a small base is more of an explanation than the rent line
 * that is the same every month.
 */
export function ChangeSection({ snapshot, spending, onGoHisaab }: Props) {
  const theme = useTheme();
  const t = useT();

  const spend = snapshot.monthly_spending;
  const changePct = spend.change_pct;
  const hasChange = changePct !== null && changePct !== undefined;

  /* Movers: categories the server flagged as changed or new. Ranked by the
     absolute size of the change, top three — beyond that it stops being an
     explanation and becomes a list. */
  const movers: SpendingCategory[] = (spending.categories ?? [])
    .filter((c) => c.is_new || (c.change_pct !== null && c.change_pct !== undefined))
    .sort((a, b) => Math.abs(b.change_pct ?? 999) - Math.abs(a.change_pct ?? 999))
    .slice(0, 3);

  const maxShare = Math.max(...(spending.categories ?? []).map((c) => c.share_pct || 0), 1);

  // Nothing moved and nothing to explain — say so rather than render an
  // empty heading. The server's own note is used where it has one.
  if (!hasChange && !movers.length) {
    if (!spending.note && spending.status === 'actual') return null;
    return (
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="title">{t('home.whatChanged')}</Text>
        <Text variant="bodySmall" color="faint">
          {spending.note ?? t('common.noData')}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: theme.spacing.xxl }}>
      {/* ------------------------------------------------------ what changed */}
      {hasChange ? (
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="title">{t('home.whatChanged')}</Text>

          <Surface tone="inset" padded={theme.spacing.lg}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg }}>
              <Metric
                value={`${Math.abs(changePct as number)}%`}
                label={
                  (changePct as number) > 0 ? t('home.spendingUp') : t('home.spendingDown')
                }
                size="md"
                tone={(changePct as number) > 0 ? 'ink' : 'accent'}
                direction={(changePct as number) > 0 ? 'up' : 'down'}
                style={{ flex: 1 }}
              />
              <View style={{ width: 1, alignSelf: 'stretch', backgroundColor: theme.colors.line }} />
              <View style={{ flex: 1.2, gap: 2 }}>
                <Text variant="label" color="faint">
                  {spend.month}
                </Text>
                <Text variant="metricSmall" tabular numberOfLines={1} adjustsFontSizeToFit>
                  {spend.display}
                </Text>
                {spending.previous_total_display ? (
                  <Text variant="bodySmall" color="faint">
                    {t('home.was', { amount: spending.previous_total_display })}
                  </Text>
                ) : null}
              </View>
            </View>
          </Surface>
        </View>
      ) : null}

      {/* --------------------------------------------------------- why it did */}
      {movers.length ? (
        <View style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
            <Text variant="title" style={{ flex: 1 }}>
              {t('home.whyItChanged')}
            </Text>
            <Pressable onPress={onGoHisaab} hitSlop={10} accessibilityRole="button">
              <Text variant="bodySmall" color="accent">
                {t('common.seeAll')}
              </Text>
            </Pressable>
          </View>

          <View>
            {movers.map((category, i) => {
              const up = (category.change_pct ?? 0) > 0;
              return (
                <View key={category.category}>
                  {i > 0 ? <Divider /> : null}
                  <View style={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.md }}>
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'baseline',
                        gap: theme.spacing.sm,
                      }}
                    >
                      <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
                        {category.category}
                      </Text>
                      <Text
                        variant="bodySmall"
                        tabular
                        style={{
                          color: category.is_new
                            ? theme.colors.accent
                            : up
                              ? theme.colors.inkMuted
                              : theme.colors.accent,
                          fontFamily: theme.fonts.bodySemiBold,
                        }}
                      >
                        {category.is_new
                          ? t('home.newCategory')
                          : `${up ? '↑' : '↓'} ${Math.abs(category.change_pct as number)}%`}
                      </Text>
                      <Text
                        variant="mono"
                        tabular
                        style={{ minWidth: 78, textAlign: 'right' }}
                        numberOfLines={1}
                      >
                        {category.display}
                      </Text>
                    </View>

                    <BarMeter fraction={(category.share_pct || 0) / maxShare} height={4} />
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}
