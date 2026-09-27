import React, { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';

import type { GoalResponse } from '../../../api/types';
import { Button, DateField, GOAL_CATEGORIES, Input, Select, Sheet, Text } from '../../../components';
import { useTheme } from '../../../theme';

interface Props {
  visible: boolean;
  /** null = create; a goal = edit that goal. */
  goal: GoalResponse | null;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    target_amount: number;
    current_amount: number;
    target_date: string | null;
    category: string;
  }) => Promise<void>;
  onUpdate: (
    id: number,
    payload: {
      name: string;
      target_amount: number;
      current_amount: number;
      target_date: string | null;
      category: string;
    },
  ) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}

/**
 * Set or edit a financial goal.
 *
 * Fields and validation come from the web's #dhGoalForm: name, target amount,
 * what you have saved, target date, category — with the same two rules, in the
 * same words ("Enter a target amount greater than zero", "What you've saved
 * can't be more than the target").
 *
 * Edit and delete go beyond what the web's Daily Home exposes (it offers only
 * "add"), but they call PUT and DELETE /home/goals/{id}, which already exist
 * and are already used elsewhere in the product — no new backend behaviour.
 */
export function GoalSheet({ visible, goal, onClose, onCreate, onUpdate, onDelete }: Props) {
  const theme = useTheme();
  const isEdit = !!goal;

  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState('0');
  const [date, setDate] = useState<string | null>(null);
  const [category, setCategory] = useState<string>('emergency_fund');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Reset or prefill each time the sheet opens, so a previous edit never leaks
  // into the next one.
  useEffect(() => {
    if (!visible) return;
    setError(null);
    setBusy(false);
    if (goal) {
      setName(goal.name);
      setTarget(String(goal.target_amount ?? ''));
      setCurrent(String(goal.current_amount ?? 0));
      setDate(goal.target_date);
      setCategory(goal.category || 'custom');
    } else {
      setName('');
      setTarget('');
      setCurrent('0');
      setDate(null);
      setCategory('emergency_fund');
    }
  }, [visible, goal]);

  async function submit() {
    const targetNum = parseFloat(target);
    const currentNum = parseFloat(current || '0');

    if (!name.trim()) return setError('Give the goal a name.');
    if (!(targetNum > 0)) return setError('Enter a target amount greater than zero.');
    if (Number.isNaN(currentNum) || currentNum < 0) return setError('Enter a valid saved amount.');
    if (currentNum > targetNum) {
      return setError("What you've saved can't be more than the target.");
    }

    setError(null);
    setBusy(true);
    const payload = {
      name: name.trim(),
      target_amount: targetNum,
      current_amount: currentNum,
      target_date: date,
      category,
    };
    try {
      if (goal) await onUpdate(goal.id, payload);
      else await onCreate(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that goal.');
      setBusy(false);
    }
  }

  function confirmDelete() {
    if (!goal) return;
    Alert.alert(
      'Delete goal',
      `"${goal.name}" and its progress will be removed. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await onDelete(goal.id);
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not delete that goal.');
              setBusy(false);
            }
          },
        },
      ],
    );
  }

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={isEdit ? 'Edit goal' : 'Set a financial goal'}
      subtitle={
        isEdit ? undefined : 'What are you saving towards? MoneyKal will track the pace for you.'
      }
      error={error}
      footer={
        <>
          <Button
            label={isEdit ? 'Save changes' : 'Save goal'}
            onPress={submit}
            loading={busy}
            disabled={busy}
          />
          {isEdit ? (
            <Button
              label="Delete goal"
              variant="danger"
              onPress={confirmDelete}
              disabled={busy}
            />
          ) : null}
        </>
      }
    >
      <View style={{ gap: theme.spacing.lg }}>
        <Input
          label="Goal name"
          required
          placeholder="Emergency fund"
          value={name}
          onChangeText={setName}
          maxLength={120}
          editable={!busy}
        />

        <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
          <Input
            label="Target amount"
            required
            placeholder="100000"
            value={target}
            onChangeText={setTarget}
            keyboardType="numeric"
            editable={!busy}
            containerStyle={{ flex: 1 }}
          />
          <Input
            label="Saved so far"
            placeholder="0"
            value={current}
            onChangeText={setCurrent}
            keyboardType="numeric"
            editable={!busy}
            containerStyle={{ flex: 1 }}
          />
        </View>

        <DateField
          label="Target date"
          value={date}
          onChange={setDate}
          placeholder="Optional"
          clearable
        />

        <Select
          label="Category"
          value={category}
          options={GOAL_CATEGORIES.map((c) => ({ value: c.value, label: c.label }))}
          onChange={setCategory}
        />

        <Text variant="bodySmall" color="faint">
          A goal pot and a bank balance are different things — "saved so far" is what you have
          actually put aside for this goal.
        </Text>
      </View>
    </Sheet>
  );
}
