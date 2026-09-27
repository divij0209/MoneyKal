import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import { ApiError } from '../../api';
import { useTheme } from '../../theme';
import { makeT, useT, type Lang } from '../../i18n';
import { Button } from '../primitives/Button';
import { Text } from '../primitives/Text';

/**
 * Loading, empty and error.
 *
 * These get real design attention because they are what a reviewer sees on a
 * cold account and on a flaky network — which is most first impressions. The
 * mark is a thin line drawing in the accent, sized to sit quietly: an empty
 * state should read as "nothing here yet", not as an illustration.
 */

export type StateMark = 'empty' | 'ledger' | 'search' | 'goal' | 'offline' | 'warning';

function Mark({ name, color, size = 30 }: { name: StateMark; color: string; size?: number }) {
  const sw = 1.3;
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      {name === 'empty' && (
        <>
          <Rect x="5" y="7" width="22" height="18" rx="2.5" stroke={color} strokeWidth={sw} />
          <Line x1="5" y1="13" x2="27" y2="13" stroke={color} strokeWidth={sw} />
        </>
      )}
      {name === 'ledger' && (
        <>
          <Rect x="6" y="4" width="20" height="24" rx="2.5" stroke={color} strokeWidth={sw} />
          <Line x1="10.5" y1="11" x2="21.5" y2="11" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Line x1="10.5" y1="16" x2="21.5" y2="16" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Line x1="10.5" y1="21" x2="17" y2="21" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </>
      )}
      {name === 'search' && (
        <>
          <Circle cx="14.5" cy="14.5" r="8" stroke={color} strokeWidth={sw} />
          <Line x1="20.5" y1="20.5" x2="26" y2="26" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </>
      )}
      {name === 'goal' && (
        <>
          <Circle cx="16" cy="16" r="11" stroke={color} strokeWidth={sw} />
          <Circle cx="16" cy="16" r="5.5" stroke={color} strokeWidth={sw} />
          <Circle cx="16" cy="16" r="1.4" fill={color} />
        </>
      )}
      {name === 'offline' && (
        <>
          <Path d="M4 12.5a17 17 0 0 1 24 0" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Path d="M9 17.5a10 10 0 0 1 14 0" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Circle cx="16" cy="23" r="1.6" fill={color} />
          <Line x1="6" y1="26" x2="26" y2="6" stroke={color} strokeWidth={sw} strokeLinecap="round" />
        </>
      )}
      {name === 'warning' && (
        <>
          <Path d="M16 5 28 26H4L16 5Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <Line x1="16" y1="13" x2="16" y2="19" stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Circle cx="16" cy="22.5" r="1.2" fill={color} />
        </>
      )}
    </Svg>
  );
}

/** Centred spinner for a screen that has nothing to show yet. */
export function LoadingState({ label }: { label?: string }) {
  const theme = useTheme();
  const t = useT();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.md,
        padding: theme.spacing.xl,
        minHeight: 200,
      }}
    >
      <ActivityIndicator color={theme.colors.accent} />
      <Text variant="bodySmall" color="faint" center>
        {label ?? t('common.loading')}
      </Text>
    </View>
  );
}

/** "There's nothing here yet" — and, where it applies, what to do about it. */
export function EmptyState({
  title,
  message,
  actionLabel,
  onAction,
  mark = 'empty',
  compact = false,
}: {
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  mark?: StateMark;
  compact?: boolean;
}) {
  const theme = useTheme();

  return (
    <View
      style={{
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingVertical: compact ? theme.spacing.xl : theme.spacing.huge,
        paddingHorizontal: theme.spacing.xl,
      }}
    >
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 30,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.accentTint,
          marginBottom: theme.spacing.xs,
        }}
      >
        <Mark name={mark} color={theme.colors.accent} />
      </View>

      <Text variant="heading" center>
        {title}
      </Text>

      {message ? (
        <Text
          variant="bodySmall"
          color="muted"
          center
          style={{ maxWidth: 300, lineHeight: 19 }}
        >
          {message}
        </Text>
      ) : null}

      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant="outline"
          fullWidth={false}
          size="sm"
          style={{ marginTop: theme.spacing.md }}
        />
      ) : null}
    </View>
  );
}

/**
 * Something failed. The copy says what went wrong and what to do — an
 * unreachable server and a rejected request need different answers, and the
 * API client already distinguishes them.
 *
 * Translated through `makeT` rather than the hook so `describeError` can also
 * be called from outside a component.
 */
export function describeError(error: unknown, lang: Lang = 'en') {
  const t = makeT(lang);

  let title = t('common.somethingWrong');
  let message = t('common.retry');
  let mark: StateMark = 'warning';

  if (error instanceof ApiError) {
    if (error.isNetworkError) {
      title = t('error.offline');
      message = error.detail;
      mark = 'offline';
    } else if (error.isAuthError) {
      title = t('error.session');
      message = error.detail;
    } else {
      title = t('error.server');
      message = error.detail;
    }
  } else if (error instanceof Error && error.message) {
    message = error.message;
  }

  return { title, message, mark };
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const theme = useTheme();
  const t = useT();
  const { title, message, mark } = describeError(error);

  return (
    <View
      style={{
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.huge,
        paddingHorizontal: theme.spacing.xl,
      }}
    >
      <View
        style={{
          width: 60,
          height: 60,
          borderRadius: 30,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.warnTint,
          marginBottom: theme.spacing.xs,
        }}
      >
        <Mark name={mark} color={theme.colors.warn} />
      </View>

      <Text variant="heading" center>
        {title}
      </Text>
      <Text variant="bodySmall" color="muted" center style={{ maxWidth: 300 }}>
        {message}
      </Text>

      {onRetry ? (
        <Button
          label={t('common.retry')}
          onPress={onRetry}
          variant="outline"
          fullWidth={false}
          size="sm"
          style={{ marginTop: theme.spacing.md }}
        />
      ) : null}
    </View>
  );
}

export { Mark as StateMarkIcon };
