import React, { useState } from 'react';
import { TextInput, View } from 'react-native';

import { Text } from '../../../components';
import type { AffordabilityVerdict, LiveLifeRecommendation } from '../../../api/types';
import { QUICK_AMOUNTS, VERDICT_LABEL, money } from '../constants';
import {
  ACCENT,
  HAIRLINE,
  INK,
  INK_FAINT,
  INK_MUTED,
  LlfButton,
  LlfCard,
  SAND,
  SectionLabel,
} from './shared';

/**
 * "Before you book it" — the affordability check and MoneyKal's suggestion.
 *
 * The verdict comes from POST /live-life/check, which is answered against the
 * same Freedom Balance the hero shows, so the two can never contradict each
 * other. The client sends an amount and renders the reply; it does not decide
 * what is affordable.
 */

/**
 * The verdict's colour.
 *
 * Three states, three colours — but not green/amber/red, which would put two
 * hues into a palette that has one. "Comfortable" is the accent, "not yet" is
 * plain ink, and only "a stretch" is warmed, which is the single state where
 * colour is genuinely carrying information the words do not.
 *
 * The verdict word itself is always shown next to this, so nothing here is
 * conveyed by colour alone.
 */
const VERDICT_COLOR: Record<string, string> = {
  comfortable: ACCENT,
  stretch: SAND,
  not_yet: INK_MUTED,
  unknown: INK_FAINT,
};

interface Props {
  currency: string;
  accent: string;
  recommendation?: LiveLifeRecommendation | null;
  verdict: AffordabilityVerdict | null;
  error: string | null;
  pending: boolean;
  onAsk: (amount: number) => void;
}

export function CheckPanel({
  currency,
  accent,
  recommendation,
  verdict,
  error,
  pending,
  onAsk,
}: Props) {
  const [amount, setAmount] = useState('');

  function submit() {
    const value = Number(amount);
    if (value > 0) onAsk(value);
  }

  return (
    <View style={{ gap: 12 }}>
      <SectionLabel>Before you book it</SectionLabel>

      <LlfCard>
        <Text variant="title" style={{ color: INK }}>
          Can I afford it?
        </Text>
        <Text variant="bodySmall" style={{ color: INK_MUTED }}>
          Ask about any amount. The answer is measured against the same Freedom Balance above —
          your bills, your goals and your buffer all included.
        </Text>

        <View style={{ flexDirection: 'row', gap: 10, marginTop: 8 }}>
          <TextInput
            value={amount}
            onChangeText={setAmount}
            placeholder={`${currency} amount`}
            placeholderTextColor={INK_FAINT}
            selectionColor={accent}
            keyboardType="number-pad"
            inputMode="numeric"
            editable={!pending}
            onSubmitEditing={submit}
            accessibilityLabel="Amount to check"
            style={{
              flex: 1,
              color: INK,
              fontSize: 15,
              paddingHorizontal: 14,
              paddingVertical: 11,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: HAIRLINE,
              backgroundColor: 'rgba(244,242,238,0.05)',
            }}
          />
          <LlfButton
            label={pending ? 'Asking…' : 'Ask'}
            variant="primary"
            accent={accent}
            onPress={submit}
            disabled={pending || !Number(amount)}
          />
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
          {QUICK_AMOUNTS.map((v) => (
            <LlfButton
              key={v}
              label={money(currency, v)}
              onPress={() => onAsk(v)}
              disabled={pending}
            />
          ))}
        </View>

        {error ? (
          <Text variant="bodySmall" style={{ color: SAND, marginTop: 6 }}>
            {error}
          </Text>
        ) : null}

        {verdict ? (
          <View
            accessibilityLiveRegion="polite"
            style={{
              gap: 8,
              marginTop: 10,
              padding: 14,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: `${VERDICT_COLOR[verdict.verdict] ?? HAIRLINE}55`,
              backgroundColor: `${VERDICT_COLOR[verdict.verdict] ?? INK}14`,
            }}
          >
            <Text variant="label" style={{ color: VERDICT_COLOR[verdict.verdict] ?? INK_MUTED }}>
              {VERDICT_LABEL[verdict.verdict] ?? verdict.verdict}
            </Text>
            <Text variant="heading" style={{ color: INK }}>
              {verdict.headline}
            </Text>
            {verdict.detail ? (
              <Text variant="bodySmall" style={{ color: INK_MUTED }}>
                {verdict.detail}
              </Text>
            ) : null}

            {(verdict.impacts ?? []).map((im, i) => (
              <View key={i} style={{ gap: 1, marginTop: 4 }}>
                <Text variant="bodySmall" style={{ color: INK_MUTED }}>
                  · {im.label}
                </Text>
                {im.detail ? (
                  <Text variant="label" style={{ color: INK_FAINT, marginLeft: 12 }}>
                    {im.detail}
                  </Text>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}
      </LlfCard>

      {/* ------------------------------------------------- recommendation */}
      <LlfCard>
        <SectionLabel>MoneyKal suggests</SectionLabel>
        {recommendation ? (
          <>
            <Text variant="display" style={{ color: INK, fontSize: 34, lineHeight: 40 }} tabular>
              {recommendation.display}
            </Text>
            <Text variant="bodySmall" style={{ color: INK }}>
              {recommendation.headline}
            </Text>
            <Text variant="bodySmall" style={{ color: INK_FAINT }}>
              {recommendation.basis}
            </Text>
            <View style={{ flexDirection: 'row', marginTop: 6 }}>
              <LlfButton
                label="Check it against my plans"
                onPress={() => onAsk(recommendation.amount)}
                disabled={pending}
              />
            </View>
          </>
        ) : (
          <>
            <Text variant="bodySmall" style={{ color: INK }}>
              Nothing to suggest yet.
            </Text>
            <Text variant="bodySmall" style={{ color: INK_FAINT }}>
              A recommendation needs your income, your expenses and your current savings. Once
              MoneyKal can see those, it will tell you what size of trip is genuinely comfortable —
              rather than guessing at one.
            </Text>
          </>
        )}
      </LlfCard>
    </View>
  );
}
