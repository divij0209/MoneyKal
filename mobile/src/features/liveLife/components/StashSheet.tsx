import React, { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, DateField, Input, Sheet, Text } from '../../../components';
import type { StashItem } from '../../../api/types';
import { formatStashDate } from '../constants';

/**
 * Starting a stash, and adding money to one.
 *
 * Both write through the Home goals endpoints, because a stash *is* a
 * FinancialGoal — there is no live-life write route, deliberately, so that the
 * same figure is never stored twice. The web's sheet does exactly this.
 */

export type SheetState =
  | { kind: 'create'; categoryKey: string }
  | { kind: 'fund'; item: StashItem }
  | null;

interface Props {
  state: SheetState;
  currency: string;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onCreate: (payload: {
    name: string;
    target_amount: number;
    current_amount: number;
    target_date: string | null;
    category: string;
  }) => void;
  /** The already-capped next `current_amount`, computed by the caller. */
  onFund: (item: StashItem, addAmount: number) => void;
}

export function StashSheet({
  state,
  currency,
  saving,
  error,
  onClose,
  onCreate,
  onFund,
}: Props) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [current, setCurrent] = useState('');
  const [date, setDate] = useState<string | null>(null);
  const [addAmount, setAddAmount] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  // Reset whenever the sheet opens on something new.
  useEffect(() => {
    setLocalError(null);
    if (state?.kind === 'create') {
      setName('');
      setTarget('');
      setCurrent('');
      setDate(null);
    } else if (state?.kind === 'fund') {
      setAddAmount('');
    }
  }, [state]);

  function submitCreate() {
    if (state?.kind !== 'create') return;
    const targetValue = Number(target);
    const currentValue = Number(current) || 0;

    // The web's two guards, word for word.
    if (!targetValue || targetValue <= 0) {
      setLocalError('Give the stash a target amount.');
      return;
    }
    if (currentValue > targetValue) {
      setLocalError('You cannot have saved more than the target.');
      return;
    }
    if (!name.trim()) {
      setLocalError('Give the stash a name.');
      return;
    }

    setLocalError(null);
    onCreate({
      name: name.trim(),
      target_amount: targetValue,
      current_amount: currentValue,
      target_date: date,
      category: state.categoryKey,
    });
  }

  function submitFund() {
    if (state?.kind !== 'fund') return;
    const add = Number(addAmount);
    if (!add || add <= 0) {
      setLocalError('Enter an amount to add.');
      return;
    }
    setLocalError(null);
    onFund(state.item, add);
  }

  if (!state) return null;

  const isCreate = state.kind === 'create';

  return (
    <Sheet
      visible
      onClose={onClose}
      title={isCreate ? 'Start a stash' : `Add to ${state.item.name}`}
      subtitle={
        isCreate
          ? 'It becomes a savings goal — the same one your Home and Calendar show.'
          : `${state.item.current_display} of ${state.item.target_display} so far${
              state.item.target_date ? ` · ${formatStashDate(state.item.target_date)}` : ''
            }`
      }
      error={localError ?? error}
      footer={
        <Button
          label={saving ? 'Saving…' : isCreate ? 'Create stash' : 'Add money'}
          loading={saving}
          disabled={saving}
          onPress={isCreate ? submitCreate : submitFund}
        />
      }
    >
      {isCreate ? (
        <View style={{ gap: 14 }}>
          <Input
            label="What is it for?"
            value={name}
            onChangeText={setName}
            placeholder="Goa Trip"
            editable={!saving}
            required
          />
          <Input
            label={`Target amount (${currency})`}
            value={target}
            onChangeText={setTarget}
            placeholder="80000"
            keyboardType="number-pad"
            editable={!saving}
            required
          />
          <Input
            label={`Already saved (${currency})`}
            value={current}
            onChangeText={setCurrent}
            placeholder="0"
            keyboardType="number-pad"
            editable={!saving}
            hint="Leave blank if you are starting from zero."
          />
          {/* Optional. When set it drives the countdown and the
              "about X a month to land on time" line. */}
          <DateField label="Target date" value={date} onChange={setDate} clearable />
        </View>
      ) : (
        <View style={{ gap: 14 }}>
          <Input
            label={`Amount to add (${currency})`}
            value={addAmount}
            onChangeText={setAddAmount}
            placeholder="5000"
            keyboardType="number-pad"
            editable={!saving}
            required
            autoFocus
          />
          <Text variant="bodySmall" color="faint">
            {state.item.is_funded
              ? 'This stash is already fully funded.'
              : `${state.item.remaining_display} left to reach the target. Adding more than that simply lands it on the target.`}
          </Text>
        </View>
      )}
    </Sheet>
  );
}
