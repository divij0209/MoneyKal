import React from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Sheet, Text } from '../../../components';
import { useTheme } from '../../../theme';
import type { WeeklySpendReportListItem } from '../../../api/types';
import { formatDateRange, money } from '../constants';

/**
 * Past weekly spend reports.
 *
 * The web puts this in a `<select>` beside the panel heading. A native picker
 * sheet is the phone equivalent: same list, same source, same ordering
 * (newest first, as the endpoint returns them).
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  history: WeeklySpendReportListItem[];
  loading: boolean;
  /** null while the current week's report is on screen. */
  selectedId: number | null;
  /** The id of the report the plain endpoint returned, so "This week" can be
   *  marked as selected when nothing has been picked. */
  currentId: number | null;
  onSelect: (id: number | null) => void;
}

export function HistorySheet({
  visible,
  onClose,
  history,
  loading,
  selectedId,
  currentId,
  onSelect,
}: Props) {
  const theme = useTheme();

  function Row({
    label,
    detail,
    active,
    onPress,
  }: {
    label: string;
    detail?: string;
    active: boolean;
    onPress: () => void;
  }) {
    return (
      <Pressable
        onPress={() => {
          onPress();
          onClose();
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
          paddingVertical: theme.spacing.md,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodySmall" color={active ? 'accent' : 'ink'}>
            {label}
          </Text>
          {detail ? (
            <Text variant="label" color="faint">
              {detail}
            </Text>
          ) : null}
        </View>
        {active ? <Glyph name="spark" color={theme.colors.accent} size={15} /> : null}
      </Pressable>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Weekly spend reports">
      {loading ? (
        <Text variant="bodySmall" color="faint">
          Loading…
        </Text>
      ) : history.length ? (
        <View>
          {history.map((h) => {
            // The newest row is the week the plain endpoint regenerates, so it
            // is the one "This week" refers to.
            const isCurrentWeek = currentId !== null && h.id === currentId;
            const active = selectedId === null ? isCurrentWeek : selectedId === h.id;
            return (
              <Row
                key={h.id}
                label={formatDateRange(h.week_start, h.week_end)}
                detail={
                  h.this_week_total !== null && h.this_week_total !== undefined
                    ? money(h.this_week_total)
                    : isCurrentWeek
                      ? 'This week'
                      : undefined
                }
                active={active}
                onPress={() => onSelect(isCurrentWeek ? null : h.id)}
              />
            );
          })}
        </View>
      ) : (
        <Text variant="bodySmall" color="faint">
          No saved reports yet.
        </Text>
      )}
    </Sheet>
  );
}
