import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import type { UpcomingBlock, UpcomingResponse } from '../../../api/types';
import {
  Button,
  CATEGORY_MARKS,
  Divider,
  Glyph,
  SOURCE_LABELS,
  SectionHeader,
  Text,
} from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  upcoming: UpcomingBlock;
  onAdd: () => void;
  /** Opens the row's action sheet — details, mark paid, delete. */
  onOpenItem: (item: UpcomingResponse) => void;
  onMarkPaid: (item: UpcomingResponse) => void;
  onConfirmSuggestion: (item: UpcomingResponse) => void;
  onDismissSuggestion: (item: UpcomingResponse) => void;
  /** Ids with a mutation in flight, so the row can show it. */
  busyIds: Set<number>;
}

/** The urgency stripe. `urgency_level` is the backend's own classification —
 *  critical / soon / later — not re-derived from days_until here. */
function urgencyColor(level: string, theme: ReturnType<typeof useTheme>) {
  if (level === 'critical') return theme.colors.accent;
  if (level === 'soon') return theme.colors.accentBorder;
  return theme.colors.line;
}

function UpcomingRow({
  item,
  onPress,
  onMarkPaid,
  busy,
}: {
  item: UpcomingResponse;
  onPress: () => void;
  onMarkPaid: () => void;
  busy: boolean;
}) {
  const theme = useTheme();
  const mark = (item.category && CATEGORY_MARKS[item.category]) || '💸';
  // A number the user did not type is visibly attributed, never silently mixed
  // in with the ones they did.
  const detected = !!item.source && item.source !== 'manual';

  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={`${item.name}, ${item.amount_display ?? 'no amount'}, ${item.urgency}`}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        opacity: busy ? 0.5 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
      })}
    >
      {/* Urgency stripe — carries the level in form as well as in the words. */}
      <View
        style={{
          width: 3,
          alignSelf: 'stretch',
          borderRadius: 2,
          backgroundColor: urgencyColor(item.urgency_level, theme),
        }}
      />

      <Text variant="body" style={{ fontSize: 18 }}>
        {mark}
      </Text>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" numberOfLines={1}>
          {item.name}
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
            color={item.urgency_level === 'critical' ? 'accent' : 'faint'}
          >
            {item.urgency}
          </Text>
          {item.category ? (
            <Text variant="bodySmall" color="faint">
              · {item.category}
            </Text>
          ) : null}
          {item.is_recurring ? (
            <Text variant="bodySmall" color="faint">
              · {item.recurrence}
            </Text>
          ) : null}
          {detected ? (
            <Text variant="bodySmall" color="accent">
              · {SOURCE_LABELS[item.source] ?? item.source}
            </Text>
          ) : null}
        </View>
      </View>

      <View style={{ alignItems: 'flex-end', gap: 4 }}>
        <Text variant="body" tabular>
          {item.amount_display ?? '—'}
        </Text>
        {busy ? (
          <ActivityIndicator size="small" color={theme.colors.accent} />
        ) : (
          <Pressable
            onPress={onMarkPaid}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={`Mark ${item.name} as paid`}
          >
            <Text variant="bodySmall" color="accent">
              Mark paid
            </Text>
          </Pressable>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Detected obligations awaiting the user's yes/no.
 *
 * Rendered below the real list and visually separated, because these are
 * questions rather than facts: none of them counts toward the total above
 * until the user says yes. That separation is load-bearing, not decorative —
 * the backend deliberately keeps them out of every figure.
 */
function Suggestions({
  suggestions,
  onConfirm,
  onDismiss,
  busyIds,
}: {
  suggestions: UpcomingResponse[];
  onConfirm: (item: UpcomingResponse) => void;
  onDismiss: (item: UpcomingResponse) => void;
  busyIds: Set<number>;
}) {
  const theme = useTheme();
  if (!suggestions.length) return null;

  return (
    <View
      style={{
        marginTop: theme.spacing.lg,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: theme.colors.accentBorder,
        gap: theme.spacing.md,
      }}
    >
      <View style={{ gap: theme.spacing.xxs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Glyph name="spark" color={theme.colors.accent} size={15} />
          <Text variant="label" color="accent">
            Found in your email — {suggestions.length} to check
          </Text>
        </View>
        <Text variant="bodySmall" color="faint">
          Not counted above until you add {suggestions.length === 1 ? 'it' : 'them'}.
        </Text>
      </View>

      {suggestions.map((s) => {
        const busy = busyIds.has(s.id);
        return (
          <View key={s.id} style={{ gap: theme.spacing.sm }}>
            <Divider />
            <View style={{ gap: 2 }}>
              <Text variant="body">
                {s.name}
                {s.amount_display ? ` · ${s.amount_display}` : ''}
              </Text>
              <Text variant="bodySmall" color="faint">
                {s.urgency}
                {s.source_label ? ` · from ${s.source_label}` : ''}
              </Text>
              {s.source_subject ? (
                <Text variant="bodySmall" color="faint" numberOfLines={1}>
                  {s.source_subject}
                </Text>
              ) : null}
            </View>

            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Button
                label="Add"
                size="sm"
                fullWidth={false}
                loading={busy}
                disabled={busy}
                onPress={() => onConfirm(s)}
                style={{ flex: 1 }}
              />
              <Button
                label="Not mine"
                variant="outline"
                size="sm"
                fullWidth={false}
                disabled={busy}
                onPress={() => onDismiss(s)}
                style={{ flex: 1 }}
              />
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function UpcomingSection({
  upcoming,
  onAdd,
  onOpenItem,
  onMarkPaid,
  onConfirmSuggestion,
  onDismissSuggestion,
  busyIds,
}: Props) {
  const theme = useTheme();
  const items = upcoming.items ?? [];

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader
        title="What's coming up"
        icon="calendar"
        actionLabel="Add"
        actionIcon="plus"
        onAction={onAdd}
        subtitle={
          items.length ? `${upcoming.next_30_days_count} due in the next 30 days.` : undefined
        }
      />

      {!items.length ? (
        <View style={{ gap: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
          <Text variant="bodySmall" color="muted">
            No upcoming payments. Add the bills, subscriptions and EMIs you know about and
            MoneyKal will keep them in front of you.
          </Text>
          <Button
            label="Add a payment"
            variant="outline"
            size="sm"
            fullWidth={false}
            onPress={onAdd}
          />
        </View>
      ) : (
        <>
          <View>
            {items.map((item, i) => (
              <React.Fragment key={item.id}>
                {i > 0 ? <Divider /> : null}
                <UpcomingRow
                  item={item}
                  busy={busyIds.has(item.id)}
                  onPress={() => onOpenItem(item)}
                  onMarkPaid={() => onMarkPaid(item)}
                />
              </React.Fragment>
            ))}
          </View>

          <Divider strong />

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <Text variant="bodySmall" color="faint">
              {upcoming.total_count > items.length
                ? `${upcoming.total_count - items.length} more scheduled`
                : 'Next 30 days'}
            </Text>
            <Text variant="body" tabular>
              {upcoming.next_30_days_display}
            </Text>
          </View>
        </>
      )}

      <Suggestions
        suggestions={upcoming.suggestions ?? []}
        onConfirm={onConfirmSuggestion}
        onDismiss={onDismissSuggestion}
        busyIds={busyIds}
      />
    </View>
  );
}
