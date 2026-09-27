import React from 'react';
import { Alert, View } from 'react-native';

import type { CalendarEvent, UpcomingResponse } from '../../../api/types';
import { Button, Divider, Sheet, Text, formatIsoDate } from '../../../components';
import { useTheme } from '../../../theme';

/** One label/value line. */
function DetailRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: theme.spacing.lg,
        paddingVertical: theme.spacing.sm,
      }}
    >
      <Text variant="bodySmall" color="faint">
        {label}
      </Text>
      <Text variant="bodySmall" style={{ flex: 1, textAlign: 'right' }} tabular>
        {value}
      </Text>
    </View>
  );
}

/**
 * An upcoming payment's details and actions.
 *
 * The web puts "Mark paid" inline on the row and offers no delete from the
 * Daily Home. On a phone the row is a tap target in its own right, so tapping
 * it opens this: the facts, then the two actions at a comfortable size. The
 * inline "Mark paid" affordance is kept on the row as well, so the common case
 * still takes one tap.
 */
export function UpcomingDetailSheet({
  item,
  onClose,
  onMarkPaid,
  onDelete,
  busy,
}: {
  item: UpcomingResponse | null;
  onClose: () => void;
  onMarkPaid: (item: UpcomingResponse) => void;
  onDelete: (item: UpcomingResponse) => void;
  busy: boolean;
}) {
  const theme = useTheme();
  if (!item) return null;

  function confirmDelete() {
    if (!item) return;
    Alert.alert('Delete payment', `Remove "${item.name}" from your upcoming payments?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete(item) },
    ]);
  }

  return (
    <Sheet
      visible={!!item}
      onClose={onClose}
      title={item.name}
      subtitle={item.amount_display ?? undefined}
      footer={
        <>
          <Button
            label="Mark as paid"
            onPress={() => onMarkPaid(item)}
            loading={busy}
            disabled={busy}
          />
          <Button label="Delete" variant="danger" onPress={confirmDelete} disabled={busy} />
        </>
      }
    >
      <View>
        <DetailRow label="Due" value={`${item.urgency} · ${formatIsoDate(item.due_date)}`} />
        <Divider />
        {item.category ? (
          <>
            <DetailRow label="Category" value={item.category} />
            <Divider />
          </>
        ) : null}
        <DetailRow label="Repeats" value={item.is_recurring ? item.recurrence : 'One-off'} />
        <Divider />
        <DetailRow label="Source" value={item.source === 'manual' ? 'Added by you' : item.source} />
        {item.source_label ? (
          <>
            <Divider />
            <DetailRow label="From" value={item.source_label} />
          </>
        ) : null}
        {item.source_subject ? (
          <>
            <Divider />
            <DetailRow label="Subject" value={item.source_subject} />
          </>
        ) : null}
        {item.notes ? (
          <>
            <Divider />
            <DetailRow label="Notes" value={item.notes} />
          </>
        ) : null}
      </View>

      <Text variant="bodySmall" color="faint" style={{ paddingTop: theme.spacing.md }}>
        {item.is_recurring
          ? 'Marking it paid rolls this forward to its next occurrence.'
          : 'Marking it paid records today as the last payment date.'}
      </Text>
    </Sheet>
  );
}

/**
 * A calendar event's details.
 *
 * Same fields the web's `showEventDetail()` lists, in the same order. Where the
 * event came from the Hisaab ledger it offers to open that day in Hisaab —
 * which is the existing flow for "what actually happened on this date".
 */
export function EventDetailSheet({
  event,
  onClose,
  onOpenInHisaab,
}: {
  event: CalendarEvent | null;
  onClose: () => void;
  onOpenInHisaab: (dateKey: string) => void;
}) {
  const theme = useTheme();
  if (!event) return null;

  const sign = event.direction === 'in' ? '+' : event.direction === 'out' ? '−' : '';
  const recurrence = event.meta?.recurrence as string | undefined;
  const senderDomain = event.meta?.sender_domain as string | undefined;

  // A ledger event is a day's logged activity — Hisaab is where that lives.
  const isLedger = event.source === 'ledger';

  return (
    <Sheet
      visible={!!event}
      onClose={onClose}
      title={`${event.icon}  ${event.title}`}
      subtitle={event.type_label}
      footer={
        isLedger ? (
          <Button
            label="Open this day in Hisaab"
            variant="outline"
            onPress={() => onOpenInHisaab(event.date)}
          />
        ) : undefined
      }
    >
      <View>
        {event.amount_display ? (
          <>
            <DetailRow label="Amount" value={`${sign}${event.amount_display}`} />
            <Divider />
          </>
        ) : null}
        <DetailRow label="Date" value={formatIsoDate(event.date)} />
        <Divider />
        <DetailRow label="Type" value={event.type_label} />
        {event.detail ? (
          <>
            <Divider />
            <DetailRow label="Detail" value={event.detail} />
          </>
        ) : null}
        {recurrence && recurrence !== 'none' ? (
          <>
            <Divider />
            <DetailRow label="Repeats" value={recurrence} />
          </>
        ) : null}
        {senderDomain ? (
          <>
            <Divider />
            <DetailRow label="Source" value={senderDomain} />
          </>
        ) : event.origin && event.origin !== 'manual' ? (
          <>
            <Divider />
            <DetailRow label="Source" value={event.origin} />
          </>
        ) : null}
        {event.tentative ? (
          <>
            <Divider />
            <DetailRow label="Status" value="Awaiting your confirmation" />
          </>
        ) : null}
      </View>

      {event.tentative ? (
        <Text variant="bodySmall" color="faint" style={{ paddingTop: theme.spacing.md }}>
          Detected but not yet confirmed — it is not counted in any total. Confirm it under
          "What's coming up".
        </Text>
      ) : null}
    </Sheet>
  );
}
