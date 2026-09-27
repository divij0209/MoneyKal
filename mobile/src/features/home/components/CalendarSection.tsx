import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import type { CalendarEvent, CalendarResponse, TimelineBlock } from '../../../api/types';
import { Divider, Glyph, SectionHeader, Text } from '../../../components';
import { MIN_TOUCH_SIZE, useTheme } from '../../../theme';

interface Props {
  calendar: CalendarResponse | undefined;
  timeline: TimelineBlock;
  loading: boolean;
  onShiftMonth: (delta: number) => void;
  onToday: () => void;
  onAddEvent: () => void;
  onOpenEvent: (event: CalendarEvent) => void;
}

const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** "Mon, 4 Aug" — the web's prettyDate(). */
function prettyDate(key: string): string {
  const [y, m, d] = (key || '').split('-').map(Number);
  if (!y) return key || '';
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/**
 * "Today" / "Tomorrow" / "In 5 days" / "12 Sep" — the same vocabulary the
 * upcoming list uses, so one event reads the same in both places.
 */
function relativeWhen(ev: CalendarEvent): string {
  const n = ev.days_until;
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n <= 13) return `In ${n} days`;
  if (n < -1 && n >= -13) return `${Math.abs(n)} days ago`;
  return prettyDate(ev.date);
}

function EventRow({ ev, onPress }: { ev: CalendarEvent; onPress: () => void }) {
  const theme = useTheme();
  const sign = ev.direction === 'in' ? '+' : ev.direction === 'out' ? '−' : '';

  const tags: string[] = [];
  if (ev.tentative) tags.push('Needs review');
  else if (ev.origin === 'gmail') tags.push('From email');
  else if (ev.origin === 'detected') tags.push('Detected');
  const recurrence = ev.meta?.recurrence as string | undefined;
  if (recurrence && recurrence !== 'none') tags.push(recurrence);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${ev.title}, ${ev.amount_display ?? ''} ${relativeWhen(ev)}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: ev.tentative ? 0.75 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
      })}
    >
      <Text variant="body" style={{ fontSize: 17 }}>
        {ev.icon}
      </Text>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" numberOfLines={1}>
          {ev.title}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.xs,
            flexWrap: 'wrap',
          }}
        >
          <Text
            variant="bodySmall"
            color={!ev.is_past && ev.days_until <= 3 ? 'accent' : 'faint'}
          >
            {relativeWhen(ev)}
          </Text>
          <Text variant="bodySmall" color="faint">
            · {ev.type_label}
          </Text>
          {tags.map((t) => (
            <Text key={t} variant="bodySmall" color={ev.tentative ? 'accent' : 'faint'}>
              · {t}
            </Text>
          ))}
        </View>
      </View>

      {ev.amount_display ? (
        <Text variant="body" tabular color={ev.direction === 'in' ? 'pos' : 'ink'}>
          {sign}
          {ev.amount_display}
        </Text>
      ) : null}
    </Pressable>
  );
}

function DayCell({
  day,
  dateKey,
  events,
  isToday,
  isSelected,
  onPress,
}: {
  day: number | null;
  dateKey: string;
  events: CalendarEvent[];
  isToday: boolean;
  isSelected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();

  if (day === null) {
    return <View style={{ flex: 1, aspectRatio: 1 }} />;
  }

  const hasEvents = events.length > 0;

  const dotColor = (ev: CalendarEvent) => {
    if (ev.tentative) return theme.colors.inkFaint;
    if (ev.direction === 'in') return theme.colors.pos;
    if (ev.direction === 'none') return theme.colors.accentBorder;
    return theme.colors.accent;
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={!hasEvents}
      accessibilityRole="button"
      accessibilityLabel={
        hasEvents ? `${dateKey}, ${events.length} event${events.length === 1 ? '' : 's'}` : dateKey
      }
      accessibilityState={{ selected: isSelected }}
      style={({ pressed }) => ({
        flex: 1,
        aspectRatio: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        borderRadius: theme.radius.sm,
        backgroundColor: isSelected
          ? theme.colors.accentTint
          : pressed && hasEvents
            ? theme.colors.surface2
            : 'transparent',
        borderWidth: isToday ? 1 : 0,
        borderColor: theme.colors.accentBorder,
      })}
    >
      <Text
        variant="bodySmall"
        tabular
        color={isSelected ? 'accent' : isToday ? 'ink' : hasEvents ? 'ink' : 'faint'}
      >
        {day}
      </Text>

      <View style={{ flexDirection: 'row', gap: 2, height: 4, alignItems: 'center' }}>
        {events.slice(0, 3).map((ev, i) => (
          <View
            key={i}
            style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: dotColor(ev) }}
          />
        ))}
      </View>
    </Pressable>
  );
}

/**
 * The financial calendar.
 *
 * One dated view of everything the money is about to do. The grid and the list
 * below it are two readings of the same event set: GET /home ships the current
 * month, and paging fetches only the month asked for.
 *
 * The panel below the grid is either the selected day or the rolling window —
 * one place, two modes, so the section never shows two competing lists. That
 * is the web's arrangement too; on a phone the two stack instead of sitting
 * side by side.
 */
export function CalendarSection({
  calendar,
  timeline,
  loading,
  onShiftMonth,
  onToday,
  onAddEvent,
  onOpenEvent,
}: Props) {
  const theme = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const [range, setRange] = useState<7 | 30>(30);

  // Paging to another month clears a selection that belonged to the old one.
  const monthKey = calendar ? `${calendar.year}-${calendar.month}` : '';
  const lastMonthKey = React.useRef(monthKey);
  React.useEffect(() => {
    if (lastMonthKey.current !== monthKey) {
      lastMonthKey.current = monthKey;
      setSelected(null);
    }
  }, [monthKey]);

  const cells = useMemo(() => {
    if (!calendar) return [];
    const out: { day: number | null; key: string }[] = [];
    for (let i = 0; i < calendar.first_weekday; i++) out.push({ day: null, key: `blank-${i}` });
    for (let d = 1; d <= calendar.days_in_month; d++) {
      const key = `${calendar.year}-${String(calendar.month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ day: d, key });
    }
    return out;
  }, [calendar]);

  const rows = useMemo(() => {
    const chunked: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) chunked.push(cells.slice(i, i + 7));
    return chunked;
  }, [cells]);

  if (!calendar) {
    return (
      <View style={{ gap: theme.spacing.md }}>
        <SectionHeader title="Financial calendar" icon="calendar" />
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  const totals = calendar.totals;
  const panelEvents = selected ? (calendar.days[selected] ?? []) : [];
  const windowItems = (timeline.items ?? []).filter(
    (i) => range === 30 || i.days_until <= 7,
  );
  const windowSum =
    range === 7 ? timeline.next_7_days_out_display : timeline.money_out_display;

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader
        title="Financial calendar"
        icon="calendar"
        actionLabel="Add event"
        actionIcon="plus"
        onAction={onAddEvent}
      />

      {/* Month navigation */}
      <View
        style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
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

          {/* Flexes rather than reserving a fixed 118pt — see the same note
              on ActivityCalendar. The label is the server's, which may itself
              be longer than the English month name. */}
          <Text
            variant="heading"
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
            style={{ flex: 1, textAlign: 'center' }}
          >
            {calendar.label}
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

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          {loading ? <ActivityIndicator size="small" color={theme.colors.accent} /> : null}
          <Pressable onPress={onToday} hitSlop={12} accessibilityRole="button">
            <Text variant="bodySmall" color="accent">
              Today
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Month totals */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: theme.spacing.md,
          alignItems: 'center',
        }}
      >
        <Text variant="bodySmall" color="faint">
          Out this month{' '}
          <Text variant="bodySmall" color="ink" tabular>
            {totals.money_out_display || '—'}
          </Text>
        </Text>
        {totals.money_in ? (
          <Text variant="bodySmall" color="faint">
            In{' '}
            <Text variant="bodySmall" color="pos" tabular>
              {totals.money_in_display}
            </Text>
          </Text>
        ) : null}
        <Text variant="bodySmall" color="faint">
          {totals.event_count} event{totals.event_count === 1 ? '' : 's'}
        </Text>
        {totals.tentative_count ? (
          <Text variant="bodySmall" color="accent">
            {totals.tentative_count} awaiting review
          </Text>
        ) : null}
      </View>

      {/* Grid */}
      <View style={{ gap: 4 }}>
        <View style={{ flexDirection: 'row' }}>
          {DOW.map((d, i) => (
            <View key={i} style={{ flex: 1, alignItems: 'center', paddingBottom: 4 }}>
              <Text variant="label" color="faint">
                {d}
              </Text>
            </View>
          ))}
        </View>

        {rows.map((row, ri) => (
          <View key={ri} style={{ flexDirection: 'row', gap: 2 }}>
            {row.map((cell) => (
              <DayCell
                key={cell.key}
                day={cell.day}
                dateKey={cell.key}
                events={calendar.days[cell.key] ?? []}
                isToday={cell.key === calendar.today}
                isSelected={cell.key === selected}
                // Tapping the selected day again returns to the rolling window,
                // matching the web.
                onPress={() => setSelected((s) => (s === cell.key ? null : cell.key))}
              />
            ))}
            {/* Pad the final row so the last week keeps the same cell width. */}
            {row.length < 7
              ? Array.from({ length: 7 - row.length }).map((_, i) => (
                  <View key={`pad-${i}`} style={{ flex: 1, aspectRatio: 1 }} />
                ))
              : null}
          </View>
        ))}
      </View>

      <Divider />

      {/* Panel: the selected day, or the rolling window */}
      {selected ? (
        <View style={{ gap: theme.spacing.xs }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text variant="label" color="faint">
              {prettyDate(selected)}
            </Text>
            <Pressable onPress={() => setSelected(null)} hitSlop={12} accessibilityRole="button">
              <Text variant="bodySmall" color="accent">
                Show upcoming →
              </Text>
            </Pressable>
          </View>

          {panelEvents.length ? (
            panelEvents.map((ev, i) => (
              <React.Fragment key={`${ev.date}-${ev.title}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <EventRow ev={ev} onPress={() => onOpenEvent(ev)} />
              </React.Fragment>
            ))
          ) : (
            <Text variant="bodySmall" color="faint" style={{ paddingVertical: theme.spacing.md }}>
              Nothing scheduled on this day.
            </Text>
          )}
        </View>
      ) : (
        <View style={{ gap: theme.spacing.xs }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.sm,
            }}
          >
            <Text variant="label" color="faint" style={{ flex: 1 }}>
              {range === 7 ? 'Next 7 days' : 'Next 30 days'} · {windowSum || '—'} out
            </Text>
            <View style={{ flexDirection: 'row', gap: theme.spacing.xs }}>
              {([7, 30] as const).map((r) => (
                <Pressable
                  key={r}
                  onPress={() => setRange(r)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityState={{ selected: range === r }}
                  style={{
                    paddingHorizontal: theme.spacing.sm,
                    paddingVertical: 5,
                    borderRadius: theme.radius.sm,
                    backgroundColor: range === r ? theme.colors.accentTint : 'transparent',
                  }}
                >
                  <Text variant="bodySmall" color={range === r ? 'accent' : 'faint'}>
                    {r}d
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {windowItems.length ? (
            windowItems.map((ev, i) => (
              <React.Fragment key={`${ev.date}-${ev.title}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <EventRow ev={ev} onPress={() => onOpenEvent(ev)} />
              </React.Fragment>
            ))
          ) : (
            <Text variant="bodySmall" color="faint" style={{ paddingVertical: theme.spacing.md }}>
              Nothing scheduled in this window.
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

export { prettyDate, relativeWhen };
