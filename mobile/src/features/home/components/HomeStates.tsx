import React from 'react';
import { View } from 'react-native';

import { ApiError } from '../../../api';
import type { Insight } from '../../../api/types';
import { Button, Divider, Skeleton, Text } from '../../../components';
import { useTheme } from '../../../theme';

/**
 * The loading skeleton.
 *
 * Mirrors the shape the loaded screen takes — a hero figure, a pair, an
 * insight block, then list sections — so the layout does not jump when the
 * data lands.
 */
export function HomeSkeleton() {
  const theme = useTheme();
  const gap = theme.spacing.xl;

  return (
    <View style={{ gap, paddingTop: theme.spacing.lg }}>
      <View style={{ gap: theme.spacing.sm }}>
        <Skeleton width="40%" height={11} />
        <Skeleton width="65%" height={30} />
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Skeleton width="35%" height={11} />
        <Skeleton width="60%" height={40} />
        <Skeleton width="55%" height={13} />
      </View>

      <Divider />

      <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
        <View style={{ flex: 1, gap: theme.spacing.sm }}>
          <Skeleton width="70%" height={11} />
          <Skeleton width="80%" height={22} />
          <Skeleton width="90%" height={12} />
        </View>
        <View style={{ flex: 1, gap: theme.spacing.sm }}>
          <Skeleton width="70%" height={11} />
          <Skeleton width="80%" height={22} />
          <Skeleton width="90%" height={12} />
        </View>
      </View>

      <Skeleton height={104} radius={theme.radius.lg} />

      {[0, 1].map((i) => (
        <View key={i} style={{ gap: theme.spacing.md }}>
          <Skeleton width="45%" height={16} />
          <Skeleton height={14} />
          <Skeleton height={14} />
          <Skeleton width="70%" height={14} />
        </View>
      ))}
    </View>
  );
}

/**
 * A brand-new account: no stated figures, no transactions, nothing to show.
 *
 * Showing a grid of dashes here would look broken and showing zeroes would be
 * a lie, so the whole screen becomes one honest call to action — the same
 * decision the web makes in `renderOnboarding`. The title and message are the
 * backend's onboarding insight.
 */
export function HomeOnboarding({
  insight,
  greeting,
  name,
  onEditProfile,
  onGoHisaab,
}: {
  insight: Insight | null | undefined;
  greeting: string;
  name: string;
  onEditProfile: () => void;
  onGoHisaab: () => void;
}) {
  const theme = useTheme();

  return (
    <View style={{ gap: theme.spacing.lg, paddingTop: theme.spacing.xxxl }}>
      <Text variant="display">
        {greeting}, {name}
      </Text>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="title">{insight?.title || "Let's get your twin started"}</Text>
        <Text variant="body" color="muted">
          {insight?.message ||
            'Add your income, savings and expenses and MoneyKal will start reading your money for you.'}
        </Text>
      </View>

      <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.sm }}>
        <Button label="Add your financial details" onPress={onEditProfile} />
        <Button label="Log a transaction" variant="outline" onPress={onGoHisaab} />
      </View>
    </View>
  );
}

/** Something failed. Distinguishes an unreachable server from a rejected
 *  request, because those need different answers from the user. */
export function HomeError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const theme = useTheme();

  let title = "Couldn't load your dashboard";
  let message = 'Please try again.';

  if (error instanceof ApiError) {
    if (error.isNetworkError) {
      title = "Can't reach MoneyKal";
      message = `${error.detail} You can check the address under More → Settings.`;
    } else {
      message = error.detail;
    }
  } else if (error instanceof Error && error.message) {
    message = error.message;
  }

  return (
    <View style={{ gap: theme.spacing.md, paddingTop: theme.spacing.huge }}>
      <Text variant="title">{title}</Text>
      <Text variant="bodySmall" color="muted">
        {message}
      </Text>
      <Button
        label="Try again"
        variant="outline"
        fullWidth={false}
        onPress={onRetry}
        style={{ marginTop: theme.spacing.sm }}
      />
    </View>
  );
}
