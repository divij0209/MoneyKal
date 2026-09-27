import React, { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Chip, Select, Sheet, Text } from '../../components';
import { useTheme } from '../../theme';
import { HISAAB_CATEGORIES, dateKey, formatAmount } from '../hisaab/constants';
import { useHisaabMutations } from '../hisaab/hooks';
import type { DetectedPayment } from './usePaymentDetection';

/** Where an unclassified detection lands until the user says otherwise.
 *  Exported because an "ADD TO MONEYKAL" press on the system notification saves
 *  without opening this sheet, and both paths must categorise identically. */
export const DEFAULT_CATEGORY: Record<'in' | 'out', string> = {
  out: 'Other expense',
  in: 'Other income',
};

interface Props {
  /** The capture being offered, or null when there is nothing to confirm. */
  detected: DetectedPayment | null;
  /** How many more are queued behind this one. */
  remaining: number;
  /** Called with the event id once the user has answered, either way. */
  onResolved: (id: string) => void;
}

/**
 * "Payment detected — add it to MoneyKal?"
 *
 * The only path from a notification into the ledger. Nothing is written until
 * Add is pressed, and Add goes through useHisaabMutations().create — the same
 * mutation the manual Add form and the receipt scanner use, hitting the same
 * POST /startup/hisaab/transactions. There is no second transaction store and
 * no parallel model; the only thing that marks these rows out is
 * `source: 'notification'`.
 */
export function PaymentDetectedSheet({ detected, remaining, onResolved }: Props) {
  const theme = useTheme();
  const { create } = useHisaabMutations();

  const [category, setCategory] = useState<string>(DEFAULT_CATEGORY.out);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const direction = detected?.parsed.direction ?? 'out';

  // Reset per capture, so answering one does not leak state into the next.
  useEffect(() => {
    if (!detected) return;
    setCategory(DEFAULT_CATEGORY[detected.parsed.direction]);
    setError(null);
    setBusy(false);
  }, [detected]);

  if (!detected) return null;

  const { raw, parsed } = detected;
  const isOut = parsed.direction === 'out';

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await create.mutateAsync({
        type: parsed.direction,
        category,
        amount: parsed.amount,
        description: parsed.merchant || raw.title || 'Detected payment',
        // The notification's own timestamp, not "now" — a payment reviewed the
        // next morning still belongs to the day it was made.
        txn_date: dateKey(new Date(raw.postedAt)),
        source: 'notification',
      });
      onResolved(raw.id);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Could not add that transaction. Try again.',
      );
      setBusy(false);
    }
  }

  const options = HISAAB_CATEGORIES[direction].map((c) => ({ value: c, label: c }));

  return (
    <Sheet
      visible
      onClose={() => onResolved(raw.id)}
      title="Payment detected"
      subtitle={
        remaining > 0
          ? `${remaining} more waiting`
          : 'Detected from a notification on this phone'
      }
      error={error}
      footer={
        <>
          <Button
            label="Add to MoneyKal"
            onPress={() => void add()}
            loading={busy}
            disabled={busy}
          />
          <Button
            label="Ignore"
            variant="outline"
            onPress={() => onResolved(raw.id)}
            disabled={busy}
          />
        </>
      }
    >
      <View style={{ gap: theme.spacing.lg }}>
        {/* The headline: amount first, because it is the thing being confirmed. */}
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="metric" color={isOut ? 'neg' : 'pos'} tabular>
            {isOut ? '−' : '+'}
            {formatAmount(parsed.amount)}
          </Text>
          <Text variant="body" color="muted">
            {parsed.merchant
              ? `${isOut ? 'Paid to' : 'Received from'} ${parsed.merchant}`
              : /* Requirement: an amount with no merchant is still confirmable.
                   Saying so plainly beats showing an empty line. */
                `${isOut ? 'Money out' : 'Money in'} — no payee named`}
          </Text>
        </View>

        <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          <Chip label={raw.appLabel} tone="accent" />
          <Chip label={isOut ? 'Money out' : 'Money in'} />
        </View>

        <Select label="Category" value={category} options={options} onChange={setCategory} />

        {/* The words MoneyKal actually read. Shown so a wrong reading is
            visible rather than mysterious — and so "Ignore" is an informed
            choice rather than a guess. */}
        <View
          style={{
            padding: theme.spacing.md,
            borderRadius: theme.radius.md,
            backgroundColor: theme.colors.surface2,
            borderWidth: 1,
            borderColor: theme.colors.line,
            gap: 2,
          }}
        >
          <Text variant="label" color="faint">
            From the notification
          </Text>
          {raw.title ? <Text variant="bodySmall">{raw.title}</Text> : null}
          {raw.text ? (
            <Text variant="bodySmall" color="muted">
              {raw.text}
            </Text>
          ) : null}
        </View>

        <Text variant="bodySmall" color="faint">
          Nothing is saved unless you press Add. MoneyKal reads notifications only —
          it does not read or send SMS.
        </Text>
      </View>
    </Sheet>
  );
}
