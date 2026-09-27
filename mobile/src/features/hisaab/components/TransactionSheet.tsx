import React, { useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import type { TransactionPayload } from '../../../api/endpoints/hisaab';
import type { Transaction } from '../../../api/types';
import { Button, DateField, Input, Select, Sheet, Text, confirmDestructive } from '../../../components';
import { useTheme } from '../../../theme';
import { HISAAB_CATEGORIES, cleanTxnDescription, dateKey, type TxnType } from '../constants';

export interface TransactionDraft {
  type: TxnType;
  category: string;
  amount: string;
  description: string;
  txn_date: string | null;
}

interface Props {
  visible: boolean;
  /** null = add; a transaction = edit that row. */
  editing: Transaction | null;
  /** Prefill, e.g. from a receipt scan or the selected calendar day. */
  initial?: Partial<TransactionDraft> | null;
  onClose: () => void;
  onSubmit: (payload: TransactionPayload, editingId: number | null) => Promise<void>;
  onDelete: (txn: Transaction) => Promise<void>;
}

/**
 * Add or edit a transaction.
 *
 * The web puts this form permanently at the top of the Hisaab view and reuses
 * it for editing by scrolling back to it (`startHisaabEdit`). On a phone a
 * persistent form would push the ledger below the fold, so it becomes a sheet
 * — same fields, same order, same validation, and the same "Add" vs "Save
 * changes" distinction.
 *
 * Validation matches the backend rather than guessing at it: type must be
 * in/out and amount must be greater than zero (routers/startup.py), so those
 * are checked here to save a round trip. Anything else the server rejects is
 * surfaced verbatim.
 */
export function TransactionSheet({
  visible,
  editing,
  initial,
  onClose,
  onSubmit,
  onDelete,
}: Props) {
  const theme = useTheme();

  const [type, setType] = useState<TxnType>('out');
  const [category, setCategory] = useState<string>(HISAAB_CATEGORIES.out[0]);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [txnDate, setTxnDate] = useState<string | null>(dateKey());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setBusy(false);

    if (editing) {
      setType(editing.type);
      setCategory(editing.category);
      setAmount(String(editing.amount));
      setDescription(cleanTxnDescription(editing.description));
      setTxnDate(editing.txn_date);
      return;
    }

    const seedType = (initial?.type as TxnType) || 'out';
    setType(seedType);
    setCategory(initial?.category || HISAAB_CATEGORIES[seedType][0]);
    setAmount(initial?.amount ?? '');
    setDescription(initial?.description ?? '');
    setTxnDate(initial?.txn_date ?? dateKey());
  }, [visible, editing, initial]);

  /** Switching direction swaps the category list, as the web's
   *  populateHisaabCategoryOptions does on the type select's change event. */
  function changeType(next: TxnType) {
    setType(next);
    if (!HISAAB_CATEGORIES[next].includes(category as never)) {
      setCategory(HISAAB_CATEGORIES[next][0]);
    }
  }

  async function submit() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      return setError('Enter an amount greater than zero.');
    }
    if (!category) return setError('Pick a category.');

    setError(null);
    setBusy(true);
    try {
      await onSubmit(
        {
          type,
          category,
          amount: value,
          description: description.trim() || null,
          txn_date: txnDate || null,
        },
        editing?.id ?? null,
      );
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that transaction.');
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!editing) return;
    confirmDestructive({
      title: 'Delete this transaction?',
      message: 'This cannot be undone.',
      onConfirm: async () => {
        setBusy(true);
        try {
          await onDelete(editing);
          onClose();
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not delete that transaction.');
          setBusy(false);
        }
      },
    });
  }

  const options = HISAAB_CATEGORIES[type].map((c) => ({ value: c, label: c }));

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={editing ? 'Edit transaction' : 'Add a transaction'}
      error={error}
      footer={
        <>
          <Button
            label={editing ? 'Save changes' : 'Add'}
            onPress={submit}
            loading={busy}
            disabled={busy}
          />
          {editing ? (
            <Button label="Delete" variant="danger" onPress={confirmDelete} disabled={busy} />
          ) : null}
        </>
      }
    >
      <View style={{ gap: theme.spacing.lg }}>
        {/* Direction — a segmented control rather than a dropdown; there are
            two options and the choice reshapes the rest of the form. */}
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="label" color="faint">
            Direction
          </Text>
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            {(['in', 'out'] as const).map((t) => {
              const selected = type === t;
              return (
                <Pressable
                  key={t}
                  onPress={() => changeType(t)}
                  disabled={busy}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    paddingVertical: theme.spacing.md,
                    borderRadius: theme.radius.md,
                    borderWidth: 1,
                    borderColor: selected ? theme.colors.accent : theme.colors.line,
                    backgroundColor: selected ? theme.colors.accentTint : 'transparent',
                  }}
                >
                  <Text variant="body" color={selected ? 'accent' : 'muted'}>
                    {t === 'in' ? 'Money in' : 'Money out'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        <Input
          label="Amount (₹)"
          required
          placeholder="0"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          editable={!busy}
        />

        <Select label="Category" value={category} options={options} onChange={setCategory} />

        <DateField label="Date" value={txnDate} onChange={setTxnDate} required />

        <Input
          label="Description"
          placeholder="Optional"
          value={description}
          onChangeText={setDescription}
          editable={!busy}
        />
      </View>
    </Sheet>
  );
}
