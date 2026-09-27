import React, { useState } from 'react';
import { Platform, Pressable, View } from 'react-native';
import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';

import { Glyph } from '../icons/MoneyKalIcons';
import { useTheme } from '../../theme';
import { Text } from './Text';

export interface DateFieldProps {
  label?: string;
  /** ISO YYYY-MM-DD, the format every /home date field uses. */
  value: string | null;
  onChange: (iso: string | null) => void;
  placeholder?: string;
  minimumDate?: Date;
  required?: boolean;
  clearable?: boolean;
}

/** Local ISO date. Built from local parts, never toISOString(), which converts
 *  to UTC and can land a day early. */
function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function fromIso(iso: string | null): Date {
  if (!iso) return new Date();
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return new Date();
  return new Date(y, m - 1, d);
}

/** "26 Mar 2027" — the same en-IN formatting the web's formatDate() produces. */
export function formatIsoDate(iso: string | null): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * A date field backed by the OS date picker.
 *
 * The web uses `<input type="date">`, which the browser renders as a native
 * picker. This is the same idea on a phone: tapping the field opens the
 * platform picker rather than asking anyone to type YYYY-MM-DD on a keyboard.
 */
export function DateField({
  label,
  value,
  onChange,
  placeholder = 'Pick a date',
  minimumDate,
  required,
  clearable,
}: DateFieldProps) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  function handleChange(event: DateTimePickerEvent, picked?: Date) {
    // Android fires 'dismissed' on cancel and closes itself; iOS keeps the
    // spinner mounted, so it is dismissed explicitly below.
    if (Platform.OS === 'android') setOpen(false);
    if (event.type === 'dismissed') return;
    if (picked) onChange(toIso(picked));
  }

  return (
    <View style={{ gap: theme.spacing.xs }}>
      {label ? (
        <Text variant="label" color="faint">
          {label}
          {required ? (
            <Text variant="label" color="accent">
              {' *'}
            </Text>
          ) : null}
        </Text>
      ) : null}

      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${label ?? 'Date'}: ${value ? formatIsoDate(value) : placeholder}`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          height: 48,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.md,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: pressed ? theme.colors.surface3 : theme.colors.surface2,
        })}
      >
        <Text variant="body" color={value ? 'ink' : 'faint'}>
          {value ? formatIsoDate(value) : placeholder}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          {clearable && value ? (
            <Pressable
              onPress={() => onChange(null)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Clear date"
            >
              <Glyph name="close" color={theme.colors.inkFaint} size={15} />
            </Pressable>
          ) : null}
          <Glyph name="calendar" color={theme.colors.inkFaint} size={16} />
        </View>
      </Pressable>

      {open ? (
        <>
          <DateTimePicker
            value={fromIso(value)}
            mode="date"
            display={Platform.OS === 'ios' ? 'inline' : 'default'}
            minimumDate={minimumDate}
            onChange={handleChange}
            themeVariant={theme.name}
          />
          {Platform.OS === 'ios' ? (
            <Pressable
              onPress={() => setOpen(false)}
              style={{ alignSelf: 'flex-end', paddingVertical: theme.spacing.sm }}
              accessibilityRole="button"
            >
              <Text variant="bodySmall" color="accent">
                Done
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : null}
    </View>
  );
}
