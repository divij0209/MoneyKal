import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glyph } from '../icons/MoneyKalIcons';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { Text } from './Text';

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label?: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * A picker.
 *
 * The web uses a native `<select>`; React Native has no equivalent that looks
 * right on both platforms, so this is a field that opens a list of options.
 * Rows are full-width and 44pt tall, which a dropdown menu ported literally
 * would not be.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = 'Select…',
  disabled = false,
}: SelectProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  const selected = options.find((o) => o.value === value);

  return (
    <View style={{ gap: theme.spacing.xs }}>
      {label ? (
        <Text variant="label" color="faint">
          {label}
        </Text>
      ) : null}

      <Pressable
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label ? `${label}: ${selected?.label ?? placeholder}` : undefined}
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
          opacity: disabled ? 0.5 : 1,
        })}
      >
        <Text variant="body" color={selected ? 'ink' : 'faint'} numberOfLines={1}>
          {selected?.label ?? placeholder}
        </Text>
        <Glyph name="chevronRight" color={theme.colors.inkFaint} size={16} />
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        transparent
        onRequestClose={() => setOpen(false)}
        statusBarTranslucent
      >
        <Pressable
          onPress={() => setOpen(false)}
          accessibilityLabel="Close"
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}
        />
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            maxHeight: '70%',
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            borderTopWidth: 1,
            borderColor: theme.colors.line,
            paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
          }}
        >
          <View style={{ alignItems: 'center', paddingVertical: theme.spacing.md }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.lineStrong,
              }}
            />
          </View>

          {label ? (
            <Text
              variant="label"
              color="faint"
              style={{ paddingHorizontal: theme.spacing.xl, paddingBottom: theme.spacing.sm }}
            >
              {label}
            </Text>
          ) : null}

          <ScrollView showsVerticalScrollIndicator={false}>
            {options.map((opt) => {
              const isSelected = opt.value === value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    minHeight: MIN_TOUCH_SIZE + 4,
                    paddingHorizontal: theme.spacing.xl,
                    paddingVertical: theme.spacing.md,
                    backgroundColor: pressed ? theme.colors.surface2 : 'transparent',
                  })}
                >
                  <Text variant="body" color={isSelected ? 'accent' : 'ink'}>
                    {opt.label}
                  </Text>
                  {isSelected ? (
                    <Glyph name="arrowRight" color={theme.colors.accent} size={15} />
                  ) : null}
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
