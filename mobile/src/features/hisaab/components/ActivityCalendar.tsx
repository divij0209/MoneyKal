import React, { useMemo } from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Text } from '../../../components';
import { useLanguage, type Lang } from '../../../i18n';
import { MIN_TOUCH_SIZE, useTheme } from '../../../theme';

/**
 * "October 2024" / "अक्टूबर 2024".
 *
 * Hermes ships a trimmed ICU on some Android builds, where an unsupported
 * locale throws rather than falling back — so English is the catch, and the
 * header degrades to a readable month rather than to a crashed calendar.
 */
function monthLabel(year: number, month: number, lang: Lang): string {
  const date = new Date(year, month - 1, 1);
  try {
    return date.toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', {
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }
}
import { activityLevel, dateKey, formatAmount, type DayActivity } from '../constants';

interface Props {
  /** Day -> activity, built from the transactions already loaded. */
  activity: Map<string, DayActivity>;
  month: { year: number; month: number };
  selected: string | null;
  currency: string;
  onSelect: (dateKey: string | null) => void;
  onShiftMonth: (delta: number) => void;
  onToday: () => void;
}

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/**
 * The Hisaab activity calendar.
 *
 * On the web this grid lives on the Overview and deep-links *into* Hisaab
 * (`openHisaabForDate` -> `setHisaabDateFilter`), while the Hisaab view itself
 * only shows the resulting filter bar. On a phone that split costs a tab
 * round-trip for something as ordinary as "what did I spend on the 12th", so
 * the grid sits with the ledger it filters.
 *
 * Nothing about the data changes: every cell is computed from the transactions
 * GET /startup/hisaab already returned, so paging months issues no requests —
 * the same property the web's version has.
 *
 * Density follows the web's activityLevel() buckets (1, 2-3, 4+) rather than
 * amounts, so a day with one large payment doesn't look busier than a day with
 * five small ones.
 */
export function ActivityCalendar({
  activity,
  month,
  selected,
  currency,
  onSelect,
  onShiftMonth,
  onToday,
}: Props) {
  const theme = useTheme();
  const { lang } = useLanguage();
  const todayKey = dateKey();

  const { cells, label, monthTotals } = useMemo(() => {
    const { year, month: m } = month;
    const daysInMonth = new Date(year, m, 0).getDate();
    const firstWeekday = new Date(year, m - 1, 1).getDay(); // 0 = Sunday

    const out: { day: number | null; key: string }[] = [];
    for (let i = 0; i < firstWeekday; i++) out.push({ day: null, key: `blank-${i}` });

    let moneyIn = 0;
    let moneyOut = 0;
    let count = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ day: d, key });
      const act = activity.get(key);
      if (act) {
        moneyIn += act.in;
        moneyOut += act.out;
        count += act.count;
      }
    }

    return {
      cells: out,
      label: monthLabel(year, m, lang),
      monthTotals: { moneyIn, moneyOut, count },
    };
  }, [month, activity, lang]);

  const rows = useMemo(() => {
    const chunks: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) chunks.push(cells.slice(i, i + 7));
    return chunks;
  }, [cells]);

  function levelStyle(level: 0 | 1 | 2 | 3) {
    if (level === 0) return { bg: 'transparent', dot: 'transparent' };
    if (level === 1) return { bg: theme.colors.accentTint, dot: theme.colors.accentBorder };
    if (level === 2) return { bg: theme.colors.accentTint, dot: theme.colors.accent };
    return { bg: theme.colors.accentHover, dot: theme.colors.accent };
  }

  return (
    <View style={{ gap: theme.spacing.md }}>
      {/* Month navigation */}
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
          <Pressable
            onPress={() => onShiftMonth(-1)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Previous month"
            style={{
              width: MIN_TOUCH_SIZE - 10,
              height: MIN_TOUCH_SIZE - 10,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Glyph name="chevronLeft" color={theme.colors.inkMuted} size={18} />
          </Pressable>

          {/* Flexes rather than reserving a fixed 116pt: "अक्टूबर 2024" is
              materially wider than "October 2024", and a fixed box would clip
              it on a small screen. */}
          <Text
            variant="heading"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            style={{ flex: 1, textAlign: 'center' }}
          >
            {label}
          </Text>

          <Pressable
            onPress={() => onShiftMonth(1)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel="Next month"
            style={{
              width: MIN_TOUCH_SIZE - 10,
              height: MIN_TOUCH_SIZE - 10,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Glyph name="chevronRight" color={theme.colors.inkMuted} size={18} />
          </Pressable>
        </View>

        <Pressable onPress={onToday} hitSlop={12} accessibilityRole="button">
          <Text variant="bodySmall" color="accent">
            Today
          </Text>
        </Pressable>
      </View>

      {/* This month's activity, summed from the rows on screen */}
      {monthTotals.count ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing.lg, flexWrap: 'wrap' }}>
          <Text variant="bodySmall" color="faint">
            {monthTotals.count} entr{monthTotals.count === 1 ? 'y' : 'ies'}
          </Text>
          {monthTotals.moneyIn > 0 ? (
            <Text variant="bodySmall" color="faint">
              in{' '}
              <Text variant="bodySmall" color="pos" tabular>
                {formatAmount(monthTotals.moneyIn, currency)}
              </Text>
            </Text>
          ) : null}
          {monthTotals.moneyOut > 0 ? (
            <Text variant="bodySmall" color="faint">
              out{' '}
              <Text variant="bodySmall" color="ink" tabular>
                {formatAmount(monthTotals.moneyOut, currency)}
              </Text>
            </Text>
          ) : null}
        </View>
      ) : (
        <Text variant="bodySmall" color="faint">
          Nothing logged this month.
        </Text>
      )}

      {/* Grid */}
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row' }}>
          {DOW.map((d, i) => (
            <View key={i} style={{ flex: 1, alignItems: 'center', paddingBottom: 2 }}>
              <Text variant="label" color="faint">
                {d}
              </Text>
            </View>
          ))}
        </View>

        {rows.map((row, ri) => (
          <View key={ri} style={{ flexDirection: 'row', gap: 2 }}>
            {row.map((cell) => {
              if (cell.day === null) {
                return <View key={cell.key} style={{ flex: 1, aspectRatio: 1 }} />;
              }
              const act = activity.get(cell.key);
              const level = activityLevel(act?.count ?? 0);
              const { bg, dot } = levelStyle(level);
              const isToday = cell.key === todayKey;
              const isSelected = cell.key === selected;
              const hasActivity = !!act;

              return (
                <Pressable
                  key={cell.key}
                  onPress={() => onSelect(isSelected ? null : cell.key)}
                  disabled={!hasActivity}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected, disabled: !hasActivity }}
                  accessibilityLabel={
                    act
                      ? `${cell.key}, ${act.count} transaction${act.count === 1 ? '' : 's'}, in ${formatAmount(act.in, currency)}, out ${formatAmount(act.out, currency)}`
                      : `${cell.key}, no transactions`
                  }
                  style={({ pressed }) => ({
                    flex: 1,
                    aspectRatio: 1,
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 3,
                    borderRadius: theme.radius.sm,
                    backgroundColor: isSelected
                      ? theme.colors.accent
                      : pressed && hasActivity
                        ? theme.colors.accentHover
                        : bg,
                    borderWidth: isToday && !isSelected ? 1 : 0,
                    borderColor: theme.colors.accentBorder,
                  })}
                >
                  <Text
                    variant="bodySmall"
                    tabular
                    style={{
                      color: isSelected
                        ? theme.colors.onAccent
                        : hasActivity
                          ? theme.colors.ink
                          : theme.colors.inkFaint,
                    }}
                  >
                    {cell.day}
                  </Text>
                  <View
                    style={{
                      width: 4,
                      height: 4,
                      borderRadius: 2,
                      backgroundColor: isSelected
                        ? theme.colors.onAccent
                        : hasActivity
                          ? dot
                          : 'transparent',
                    }}
                  />
                </Pressable>
              );
            })}
            {row.length < 7
              ? Array.from({ length: 7 - row.length }).map((_, i) => (
                  <View key={`pad-${i}`} style={{ flex: 1, aspectRatio: 1 }} />
                ))
              : null}
          </View>
        ))}
      </View>
    </View>
  );
}
