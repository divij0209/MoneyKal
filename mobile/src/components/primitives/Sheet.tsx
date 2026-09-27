import React from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Glyph } from '../icons/MoneyKalIcons';
import { MIN_TOUCH_SIZE, useTheme } from '../../theme';
import { Text } from './Text';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  /** Shown above the content in the warn colour — the sheet's error line,
   *  matching the web modals' `.dh-modal__err`. */
  error?: string | null;
  /** Pinned below the scroll area so the primary action stays reachable with a
   *  keyboard open. */
  footer?: React.ReactNode;
  /** Additive: a handle on the scroll area, for a sheet that needs to open at
   *  a particular point in a long document rather than at the top. Nothing
   *  changes for a sheet that does not pass one. */
  scrollRef?: React.Ref<ScrollView>;
}

/**
 * A bottom sheet.
 *
 * The web opens these as centred `.modal-overlay` dialogs. On a phone a sheet
 * rising from the bottom edge is the native equivalent: it keeps the primary
 * action under the thumb and leaves the context above it visible. The content
 * is the same — same fields, same copy, same validation.
 */
export function Sheet({
  visible,
  onClose,
  title,
  subtitle,
  children,
  error,
  footer,
  scrollRef,
}: SheetProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      statusBarTranslucent
    >
      {/* Tapping the scrim dismisses, matching the web's click-outside-to-close. */}
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close"
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)' }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          maxHeight: '90%',
        }}
      >
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radius.xl,
            borderTopRightRadius: theme.radius.xl,
            borderTopWidth: 1,
            borderColor: theme.colors.line,
            paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
          }}
        >
          {/* Grabber */}
          <View style={{ alignItems: 'center', paddingTop: theme.spacing.md }}>
            <View
              style={{
                width: 36,
                height: 4,
                borderRadius: 2,
                backgroundColor: theme.colors.lineStrong,
              }}
            />
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: theme.spacing.md,
              paddingHorizontal: theme.spacing.xl,
              paddingTop: theme.spacing.md,
              paddingBottom: theme.spacing.md,
            }}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="title">{title}</Text>
              {subtitle ? (
                <Text variant="bodySmall" color="muted">
                  {subtitle}
                </Text>
              ) : null}
            </View>
            <Pressable
              onPress={onClose}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Close"
              style={{
                width: MIN_TOUCH_SIZE - 12,
                height: MIN_TOUCH_SIZE - 12,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Glyph name="close" color={theme.colors.inkMuted} size={20} />
            </Pressable>
          </View>

          {error ? (
            <View
              style={{
                marginHorizontal: theme.spacing.xl,
                marginBottom: theme.spacing.md,
                padding: theme.spacing.md,
                borderRadius: theme.radius.md,
                backgroundColor: theme.colors.warnTint,
                borderWidth: 1,
                borderColor: theme.colors.warn,
              }}
            >
              <Text variant="bodySmall" style={{ color: theme.colors.warn }}>
                {error}
              </Text>
            </View>
          ) : null}

          <ScrollView
            ref={scrollRef}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              paddingHorizontal: theme.spacing.xl,
              paddingBottom: theme.spacing.lg,
            }}
          >
            {children}
          </ScrollView>

          {footer ? (
            <View
              style={{
                paddingHorizontal: theme.spacing.xl,
                paddingTop: theme.spacing.md,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
                gap: theme.spacing.sm,
              }}
            >
              {footer}
            </View>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
