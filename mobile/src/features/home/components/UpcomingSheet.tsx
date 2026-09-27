import React, { useEffect, useState } from 'react';
import { View } from 'react-native';

import type { Recurrence } from '../../../api/types';
import {
  Button,
  DateField,
  Input,
  RECURRENCE_OPTIONS,
  Select,
  Sheet,
  UPCOMING_CATEGORIES,
} from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    amount: number;
    due_date: string;
    category: string;
    recurrence: Recurrence;
  }) => Promise<void>;
}

/** A week out, in local parts — the web defaults the due date the same way,
 *  and it saves a date-picker trip for a bill the user already knows about. */
function defaultDueDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 7);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * Add an upcoming payment.
 *
 * Same fields, defaults and validation as the web's #dhUpcomingForm — name,
 * amount, due date, category, recurrence, with recurrence defaulting to
 * monthly and the two error messages worded identically.
 */
export function UpcomingSheet({ visible, onClose, onCreate }: Props) {
  const theme = useTheme();

  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [due, setDue] = useState<string | null>(defaultDueDate());
  const [category, setCategory] = useState<string>(UPCOMING_CATEGORIES[0]);
  const [recurrence, setRecurrence] = useState<Recurrence>('monthly');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setName('');
    setAmount('');
    setDue(defaultDueDate());
    setCategory(UPCOMING_CATEGORIES[0]);
    setRecurrence('monthly');
    setError(null);
    setBusy(false);
  }, [visible]);

  async function submit() {
    const amountNum = parseFloat(amount);

    if (!name.trim()) return setError('Give the payment a name.');
    if (!(amountNum > 0)) return setError('Enter an amount greater than zero.');
    if (!due) return setError('Pick a due date.');

    setError(null);
    setBusy(true);
    try {
      await onCreate({
        name: name.trim(),
        amount: amountNum,
        due_date: due,
        category,
        recurrence,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that payment.');
      setBusy(false);
    }
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Add an upcoming payment"
      subtitle="A bill, subscription, EMI or one-off you know is coming."
      error={error}
      footer={<Button label="Add payment" onPress={submit} loading={busy} disabled={busy} />}
    >
      <View style={{ gap: theme.spacing.lg }}>
        <Input
          label="Name"
          required
          placeholder="Electricity bill"
          value={name}
          onChangeText={setName}
          maxLength={120}
          editable={!busy}
        />

        <Input
          label="Amount"
          required
          placeholder="2400"
          value={amount}
          onChangeText={setAmount}
          keyboardType="numeric"
          editable={!busy}
        />

        <DateField label="Due date" required value={due} onChange={setDue} />

        <Select
          label="Category"
          value={category}
          options={UPCOMING_CATEGORIES.map((c) => ({ value: c, label: c }))}
          onChange={setCategory}
        />

        <Select
          label="Repeats"
          value={recurrence}
          options={RECURRENCE_OPTIONS.map((r) => ({ value: r.value, label: r.label }))}
          onChange={(v) => setRecurrence(v as Recurrence)}
        />
      </View>
    </Sheet>
  );
}
