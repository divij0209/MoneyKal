import React from 'react';
import { Linking, Pressable, View } from 'react-native';

import type { MarketSignal } from '../../api/types';
import {
  Chip,
  Divider,
  EmptyState,
  ErrorState,
  Glyph,
  Screen,
  Skeleton,
  Surface,
  Text,
} from '../../components';
import { useT } from '../../i18n';
import { useTheme } from '../../theme';
import { useMarketPulse } from '../home/hooks';

/**
 * Market Pulse — the full screen.
 *
 * This was a dev `<Placeholder>` while everything it needed already existed:
 * `GET /market-pulse` was wired, typed, and being rendered in miniature on
 * Home. Two entry points — the Home section's own screen and the More hub —
 * both led here and both showed a stub. That is now the real view.
 *
 * The router swallows upstream news failures and returns an empty `signals`
 * array with a `message` rather than an error, so an outage renders as that
 * message — exactly as the web's `renderMarketPulse()` does. A genuinely
 * failed request (offline, wrong host) is the only thing that reaches
 * ErrorState.
 *
 * `why_it_matters` is the point of the feature: the headline is what anyone
 * would see, that line is what the backend computed about *this* user's
 * position. It gets its own treatment for that reason.
 */
export function MarketPulseScreen() {
  const theme = useTheme();
  const t = useT();
  const query = useMarketPulse();

  const data = query.data;
  const signals = data?.signals ?? [];

  if (query.isLoading && !data) {
    return (
      <Screen scroll>
        <View style={{ gap: theme.spacing.xxl, paddingTop: theme.spacing.xl }}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ gap: theme.spacing.sm }}>
              <Skeleton width="30%" height={11} />
              <Skeleton height={20} />
              <Skeleton width="85%" height={14} />
              <Skeleton width="60%" height={14} />
            </View>
          ))}
        </View>
      </Screen>
    );
  }

  if (query.isError && !data) {
    return (
      <Screen scroll>
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen scroll onRefresh={() => void query.refetch()} refreshing={query.isRefetching}>
      <View
        style={{
          gap: theme.spacing.xxl,
          paddingTop: theme.spacing.xl,
          paddingBottom: theme.spacing.huge,
        }}
      >
        {/* The framing line, plus whether these signals were personalised to
            this profile or are the generic feed. That distinction is the
            product; saying it plainly is better than implying it. */}
        <View style={{ gap: theme.spacing.sm }}>
          <Text variant="display">{t('market.title')}</Text>
          <Text variant="body" color="muted">
            {t('market.subtitle')}
          </Text>
          {signals.length ? (
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              <Chip
                label={data?.personalized ? t('market.personalised') : t('market.general')}
                tone={data?.personalized ? 'accent' : 'neutral'}
              />
              <Chip label={`${signals.length}`} />
            </View>
          ) : null}
        </View>

        {!signals.length ? (
          <EmptyState
            title={t('common.noData')}
            message={data?.message || 'Market intelligence is temporarily unavailable.'}
            mark="offline"
            actionLabel={t('common.retry')}
            onAction={() => void query.refetch()}
          />
        ) : (
          <View>
            {signals.map((signal, i) => (
              <React.Fragment key={`${signal.headline}-${i}`}>
                {i > 0 ? <Divider /> : null}
                <SignalRow signal={signal} />
              </React.Fragment>
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function SignalRow({ signal }: { signal: MarketSignal }) {
  const theme = useTheme();
  const t = useT();

  return (
    <View style={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.lg }}>
      <Text variant="label" color="accent">
        {signal.category || 'Markets'}
      </Text>

      <Text variant="title">{signal.headline}</Text>

      {signal.summary ? (
        <Text variant="bodySmall" color="muted">
          {signal.summary}
        </Text>
      ) : null}

      {/* The personalised line. Enclosed because it is the one part of this
          card the backend wrote about the reader rather than about the
          market. */}
      {signal.why_it_matters ? (
        <Surface tone="accent" padded={theme.spacing.md} style={{ marginTop: theme.spacing.xs }}>
          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="label" color="accent">
              {t('home.whyThisMatters')}
            </Text>
            <Text variant="bodySmall" color="muted">
              {signal.why_it_matters}
            </Text>
          </View>
        </Surface>
      ) : null}

      {signal.relevance ? (
        <Text variant="bodySmall" color="faint">
          {signal.relevance}
        </Text>
      ) : null}

      {signal.source || signal.url ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            marginTop: theme.spacing.xs,
          }}
        >
          <Text variant="bodySmall" color="faint" numberOfLines={1} style={{ flex: 1 }}>
            {signal.source ?? ''}
          </Text>
          {signal.url ? (
            <Pressable
              onPress={() => Linking.openURL(signal.url!).catch(() => undefined)}
              hitSlop={10}
              accessibilityRole="link"
              accessibilityLabel={`Read more about ${signal.headline}`}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 5,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text variant="bodySmall" color="accent">
                {t('market.readMore')}
              </Text>
              <Glyph name="external" color={theme.colors.accent} size={12} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
