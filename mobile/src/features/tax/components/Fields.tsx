import React, { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '../../../components';
import { MIN_TOUCH_SIZE, useTheme } from '../../../theme';
import { formatINR } from '../hooks';

/**
 * The Tax screen's form controls.
 *
 * A tax form is mostly rupee amounts, and a rupee amount has requirements a
 * generic <Input> does not meet: a ₹ affix that is not part of the value, a
 * numeric keypad, grouping shown while the field is at rest but never while
 * it is being typed into (re-grouping under the cursor moves it), and a
 * right-aligned figure so a column of them reads as a ledger.
 */

export interface AmountFieldProps {
  label: string;
  value: number;
  onChange: (next: number) => void;
  hint?: string;
  /** Shown under the field in the accent — a statutory ceiling, usually. */
  limit?: string;
  placeholder?: string;
  editable?: boolean;
}

export function AmountField({
  label,
  value,
  onChange,
  hint,
  limit,
  placeholder = '0',
  editable = true,
}: AmountFieldProps) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  const [draft, setDraft] = useState<string>(value ? String(value) : '');

  // Keep the draft in step when the value changes from outside (a saved
  // profile loading, a reset) — but never while the field has focus, which
  // would fight the user's typing.
  useEffect(() => {
    if (!focused) setDraft(value ? String(value) : '');
  }, [value, focused]);

  const display = focused
    ? draft
    : value
      ? formatINR(value).replace('₹', '')
      : '';

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="bodySmall" color="muted" style={{ flex: 1 }}>
          {label}
        </Text>
        {limit ? (
          <Text variant="label" color="faint">
            {limit}
          </Text>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          minHeight: MIN_TOUCH_SIZE + 2,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: focused ? theme.colors.accent : theme.colors.line,
          backgroundColor: editable ? theme.colors.surface2 : theme.colors.surface3,
        }}
      >
        <Text variant="body" color={value ? 'muted' : 'faint'}>
          ₹
        </Text>
        <TextInput
          value={display}
          onChangeText={(text) => {
            // Digits only. A tax figure has no decimals worth keeping and a
            // stray comma from a paste should not poison the parse.
            const digits = text.replace(/[^0-9]/g, '');
            setDraft(digits);
            onChange(digits ? Number(digits) : 0);
          }}
          onFocus={() => {
            setFocused(true);
            setDraft(value ? String(value) : '');
          }}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder={placeholder}
          placeholderTextColor={theme.colors.inkFaint}
          selectionColor={theme.colors.accent}
          editable={editable}
          style={{
            flex: 1,
            textAlign: 'right',
            color: theme.colors.ink,
            ...theme.type.mono,
            fontFamily: theme.fonts.bodyMedium,
            paddingVertical: theme.spacing.sm,
          }}
        />
      </View>

      {hint ? (
        <Text variant="bodySmall" color="faint" style={{ fontSize: 11.5, lineHeight: 16 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** A plain number field — age, months, count. No ₹, no grouping. */
export function NumberField({
  label,
  value,
  onChange,
  suffix,
  max,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  suffix?: string;
  max?: number;
}) {
  const theme = useTheme();
  const [focused, setFocused] = useState(false);

  return (
    <View style={{ gap: theme.spacing.xs, flex: 1 }}>
      <Text variant="bodySmall" color="muted">
        {label}
      </Text>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          minHeight: MIN_TOUCH_SIZE + 2,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: focused ? theme.colors.accent : theme.colors.line,
          backgroundColor: theme.colors.surface2,
        }}
      >
        <TextInput
          value={value ? String(value) : ''}
          onChangeText={(text) => {
            const digits = text.replace(/[^0-9]/g, '');
            const next = digits ? Number(digits) : 0;
            onChange(max !== undefined ? Math.min(next, max) : next);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          keyboardType="number-pad"
          inputMode="numeric"
          placeholder="0"
          placeholderTextColor={theme.colors.inkFaint}
          selectionColor={theme.colors.accent}
          style={{
            flex: 1,
            color: theme.colors.ink,
            ...theme.type.mono,
            fontFamily: theme.fonts.bodyMedium,
            paddingVertical: theme.spacing.sm,
          }}
        />
        {suffix ? (
          <Text variant="bodySmall" color="faint">
            {suffix}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** A labelled on/off row. Used for the many boolean flags a tax form carries. */
export function ToggleRow({
  label,
  detail,
  value,
  onChange,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const theme = useTheme();

  return (
    <Pressable
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={label}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        minHeight: MIN_TOUCH_SIZE,
        paddingVertical: theme.spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body">{label}</Text>
        {detail ? (
          <Text variant="bodySmall" color="faint">
            {detail}
          </Text>
        ) : null}
      </View>

      {/* A hand-drawn switch: RN's <Switch> takes a platform tint that cannot
          be made to sit inside a three-colour palette on both themes. */}
      <View
        style={{
          width: 44,
          height: 26,
          borderRadius: 13,
          padding: 3,
          justifyContent: 'center',
          backgroundColor: value ? theme.colors.accent : theme.colors.surface3,
          borderWidth: value ? 0 : 1,
          borderColor: theme.colors.line,
        }}
      >
        <View
          style={{
            width: 20,
            height: 20,
            borderRadius: 10,
            backgroundColor: value ? theme.colors.onAccent : theme.colors.inkFaint,
            alignSelf: value ? 'flex-end' : 'flex-start',
          }}
        />
      </View>
    </Pressable>
  );
}

/** A horizontal choice group — regime, scheme, property type. */
export function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.sm }}>
      {label ? (
        <Text variant="bodySmall" color="muted">
          {label}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={option.label}
              style={({ pressed }) => ({
                minHeight: MIN_TOUCH_SIZE - 6,
                justifyContent: 'center',
                paddingHorizontal: theme.spacing.lg,
                paddingVertical: theme.spacing.sm,
                borderRadius: theme.radius.md,
                borderWidth: 1,
                borderColor: active ? theme.colors.accent : theme.colors.line,
                backgroundColor: active ? theme.colors.accentTint : 'transparent',
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text
                variant="bodySmall"
                style={{
                  color: active ? theme.colors.accent : theme.colors.inkMuted,
                  fontFamily: active ? theme.fonts.bodySemiBold : theme.fonts.body,
                }}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * One line of a computation: a label on the left, a figure on the right,
 * optionally with the statutory section that produced it.
 *
 * This is the workhorse of the result view. Dividers between rows, no boxes:
 * a tax computation is a document, and documents are ruled, not tiled.
 */
export function ComputeRow({
  label,
  section,
  value,
  emphasis = false,
  negative = false,
  onPanel = false,
  note,
}: {
  label: string;
  section?: string | null;
  value: string;
  /** Bolder — a subtotal or a total. */
  emphasis?: boolean;
  /** Renders as a subtraction: "− ₹75,000". */
  negative?: boolean;
  onPanel?: boolean;
  note?: string | null;
}) {
  const theme = useTheme();

  const inkColor = onPanel ? theme.colors.panelInk : theme.colors.ink;
  const mutedColor = onPanel ? theme.colors.panelInkMuted : theme.colors.inkMuted;
  const faintColor = onPanel ? theme.colors.panelInkMuted : theme.colors.inkFaint;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.md,
        paddingVertical: emphasis ? theme.spacing.md : theme.spacing.sm + 2,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text
          variant="bodySmall"
          style={{
            color: emphasis ? inkColor : mutedColor,
            fontFamily: emphasis ? theme.fonts.bodySemiBold : theme.fonts.body,
          }}
        >
          {label}
        </Text>
        {section ? (
          <Text variant="label" style={{ color: faintColor, fontSize: 9.5 }}>
            {section}
          </Text>
        ) : null}
        {note ? (
          <Text variant="bodySmall" style={{ color: faintColor, fontSize: 11.5 }}>
            {note}
          </Text>
        ) : null}
      </View>

      <Text
        variant={emphasis ? 'metricSmall' : 'mono'}
        tabular
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.75}
        style={{
          color: emphasis ? inkColor : mutedColor,
          fontFamily: emphasis ? undefined : theme.fonts.bodyMedium,
          minWidth: 96,
          textAlign: 'right',
        }}
      >
        {negative ? `− ${value}` : value}
      </Text>
    </View>
  );
}
