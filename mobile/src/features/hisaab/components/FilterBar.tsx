import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Glyph, Input, Select, Text } from '../../../components';
import { useTheme } from '../../../theme';
import { formatAmount, prettyDate, type TxnType } from '../constants';
import type { HisaabFilters } from '../hooks';

interface Props {
  filters: HisaabFilters;
  totals: { moneyIn: number; moneyOut: number; count: number };
  categories: string[];
  currency: string;
  hasFilters: boolean;
  onSetType: (t: TxnType | 'all') => void;
  onSetCategory: (c: string | null) => void;
  onSetSearch: (s: string) => void;
  onClearDate: () => void;
  onClearAll: () => void;
}

/**
 * Search, direction and category filters, plus the active-filter summary.
 *
 * The web has only the date bar (`renderHisaabFilterBar`), driven by the
 * Overview calendar. The extra controls exist because a phone can't show a
 * long ledger at once the way a desktop list can — but they filter the same
 * rows the API already returned and add no new request.
 *
 * The totals line is the web's own behaviour, generalised: it sums the visible
 * rows so a filtered view still answers "how much is this?". The ledger's
 * headline figures remain the API's.
 */
export function FilterBar({
  filters,
  totals,
  categories,
  currency,
  hasFilters,
  onSetType,
  onSetCategory,
  onSetSearch,
  onClearDate,
  onClearAll,
}: Props) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.md }}>
      <Input
        placeholder="Search category or description"
        value={filters.search}
        onChangeText={onSetSearch}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
      />

      {/* Direction — horizontal so it never wraps on a narrow screen. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: theme.spacing.sm }}
      >
        {(['all', 'in', 'out'] as const).map((t) => {
          const selected = filters.type === t;
          return (
            <Pressable
              key={t}
              onPress={() => onSetType(t)}
              accessibilityRole="radio"
              accessibilityState={{ selected }}
              style={{
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.pill,
                borderWidth: 1,
                borderColor: selected ? theme.colors.accent : theme.colors.line,
                backgroundColor: selected ? theme.colors.accentTint : 'transparent',
              }}
            >
              <Text variant="bodySmall" color={selected ? 'accent' : 'muted'}>
                {t === 'all' ? 'All' : t === 'in' ? 'Money in' : 'Money out'}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <Select
        label="Category"
        value={filters.category ?? ''}
        placeholder="All categories"
        options={[
          { value: '', label: 'All categories' },
          ...categories.map((c) => ({ value: c, label: c })),
        ]}
        onChange={(v) => onSetCategory(v || null)}
      />

      {/* The active-date bar, matching the web's "Showing <date> · N
          transactions · in X · out Y · Clear filter". */}
      {filters.date ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            padding: theme.spacing.md,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.accentTint,
          }}
        >
          <Glyph name="calendar" color={theme.colors.accent} size={16} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="bodySmall" color="accent">
              {prettyDate(filters.date)}
            </Text>
            <Text variant="bodySmall" color="faint">
              {totals.count} transaction{totals.count === 1 ? '' : 's'} · in{' '}
              {formatAmount(totals.moneyIn, currency)} · out{' '}
              {formatAmount(totals.moneyOut, currency)}
            </Text>
          </View>
          <Pressable onPress={onClearDate} hitSlop={12} accessibilityRole="button">
            <Text variant="bodySmall" color="accent">
              Clear
            </Text>
          </Pressable>
        </View>
      ) : hasFilters ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
          }}
        >
          <Text variant="bodySmall" color="faint">
            {totals.count} match{totals.count === 1 ? '' : 'es'} · in{' '}
            {formatAmount(totals.moneyIn, currency)} · out{' '}
            {formatAmount(totals.moneyOut, currency)}
          </Text>
          <Pressable onPress={onClearAll} hitSlop={12} accessibilityRole="button">
            <Text variant="bodySmall" color="accent">
              Clear filters
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}
