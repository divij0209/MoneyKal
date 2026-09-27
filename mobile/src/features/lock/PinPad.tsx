import React from 'react';
import { Pressable, View } from 'react-native';

import { Glyph, Text } from '../../components';
import { useTheme } from '../../theme';
import { PASSCODE_LENGTH } from '../../store/passcode';

/**
 * The passcode keypad and its progress dots.
 *
 * A custom pad rather than a `TextInput` for three reasons: the OS keyboard
 * offers autofill and paste on a field that should have neither, a numeric
 * keyboard still varies by device, and the digits never need to exist as
 * editable text. The value is held by the caller and passed down, so nothing
 * about the entered passcode lives in this component.
 */

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Fired once the pad reaches PASSCODE_LENGTH. */
  onComplete: (value: string) => void;
  disabled?: boolean;
  /** Shows the biometric key in the corner, when available and enabled. */
  onBiometric?: () => void;
  biometricLabel?: string;
  /** Turns the dots red — a wrong entry. */
  error?: boolean;
}

const KEYS: (string | 'bio' | 'del')[] = ['1','2','3','4','5','6','7','8','9','bio','0','del'];

export function PinPad({
  value,
  onChange,
  onComplete,
  disabled,
  onBiometric,
  biometricLabel,
  error,
}: Props) {
  const theme = useTheme();

  function press(k: string) {
    if (disabled) return;
    if (k === 'del') {
      onChange(value.slice(0, -1));
      return;
    }
    if (k === 'bio') {
      onBiometric?.();
      return;
    }
    if (value.length >= PASSCODE_LENGTH) return;
    const next = value + k;
    onChange(next);
    if (next.length === PASSCODE_LENGTH) onComplete(next);
  }

  return (
    <View style={{ gap: theme.spacing.xxxl, alignItems: 'center' }}>
      {/* ------------------------------------------------------------ dots */}
      <View
        style={{ flexDirection: 'row', gap: theme.spacing.md }}
        accessibilityRole="progressbar"
        accessibilityLabel={`${value.length} of ${PASSCODE_LENGTH} digits entered`}
      >
        {Array.from({ length: PASSCODE_LENGTH }, (_, i) => {
          const filled = i < value.length;
          const color = error
            ? theme.colors.warn
            : filled
              ? theme.colors.accent
              : theme.colors.line;
          return (
            <View
              key={i}
              style={{
                width: 13,
                height: 13,
                borderRadius: 7,
                borderWidth: filled ? 0 : 1,
                borderColor: color,
                backgroundColor: filled ? color : 'transparent',
              }}
            />
          );
        })}
      </View>

      {/* ------------------------------------------------------------ keys */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          width: 264,
          justifyContent: 'center',
          rowGap: theme.spacing.md,
        }}
      >
        {KEYS.map((k) => {
          const isBio = k === 'bio';
          const isDel = k === 'del';
          const hidden = isBio && !onBiometric;

          return (
            <View key={k} style={{ width: 88, alignItems: 'center' }}>
              {hidden ? (
                <View style={{ width: 72, height: 72 }} />
              ) : (
                <Pressable
                  onPress={() => press(k)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={
                    isBio ? biometricLabel || 'Unlock with biometrics' : isDel ? 'Delete' : k
                  }
                  style={({ pressed }) => ({
                    width: 72,
                    height: 72,
                    borderRadius: 36,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor:
                      pressed && !isBio && !isDel ? theme.colors.surface3 : 'transparent',
                    borderWidth: isBio || isDel ? 0 : 1,
                    borderColor: theme.colors.line,
                    opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
                  })}
                >
                  {isDel ? (
                    <Glyph name="close" color={theme.colors.inkMuted} size={20} strokeWidth={2} />
                  ) : isBio ? (
                    <Glyph name="spark" color={theme.colors.accent} size={22} />
                  ) : (
                    <Text variant="title" tabular>
                      {k}
                    </Text>
                  )}
                </Pressable>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}
