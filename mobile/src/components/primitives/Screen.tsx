import React from 'react';
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type ScrollViewProps,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import { useTheme } from '../../theme';

export interface ScreenProps {
  children: React.ReactNode;
  /** Wrap content in a ScrollView. Off for screens that manage their own
   *  scrolling — a chat list, a full-bleed experience. */
  scroll?: boolean;
  /** Pull-to-refresh. Only meaningful with `scroll`. */
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Horizontal padding. Off for edge-to-edge layouts. */
  padded?: boolean;
  edges?: readonly Edge[];
  style?: ViewStyle;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  testID?: string;
}

/**
 * The frame every screen sits in: themed background, safe-area insets, a
 * status bar that matches the theme, and optional pull-to-refresh.
 *
 * The explicit background matters — an unpainted root shows the OS window
 * colour, which is the wrong theme half the time.
 */
export function Screen({
  children,
  scroll = false,
  onRefresh,
  refreshing = false,
  padded = true,
  edges = ['top', 'left', 'right'],
  style,
  contentContainerStyle,
  testID,
}: ScreenProps) {
  const theme = useTheme();

  const body = (
    <View style={[padded ? { paddingHorizontal: theme.spacing.lg } : null, styles.flex, style]}>
      {children}
    </View>
  );

  return (
    <SafeAreaView
      edges={edges}
      style={[styles.flex, { backgroundColor: theme.colors.bg }]}
      testID={testID}
    >
      <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />
      {scroll ? (
        <ScrollView
          style={styles.flex}
          contentContainerStyle={[
            padded ? { paddingHorizontal: theme.spacing.lg } : null,
            { paddingBottom: theme.spacing.huge },
            contentContainerStyle,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.accent}
                colors={[theme.colors.accent]}
                progressBackgroundColor={theme.colors.surface}
              />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        body
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
