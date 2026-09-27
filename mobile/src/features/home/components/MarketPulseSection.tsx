import React from 'react';
import { Linking, Pressable, View } from 'react-native';

import type { MarketPulseResponse } from '../../../api/types';
import { Divider, Glyph, SectionHeader, Skeleton, Text } from '../../../components';
import { useT } from '../../../i18n';
import { useTheme } from '../../../theme';

interface Props {
  data: MarketPulseResponse | undefined;
  loading: boolean;
}

/**
 * Market Pulse.
 *
 * On the web this sits in the Overview's right-hand column; on a phone there
 * is one column, so it takes its place at the end of the scroll — after the
 * user's own money, which is what they opened the app for.
 *
 * The router swallows upstream news failures and returns an empty `signals`
 * list with a `message`, so this never has to handle a rejected request: an
 * outage renders as that message, exactly as the web's renderMarketPulse does.
 */
export function MarketPulseSection({ data, loading }: Props) {
  const theme = useTheme();
  const t = useT();

  const signals = data?.signals ?? [];

  return (
    <View style={{ gap: theme.spacing.md }}>
      <SectionHeader
        title={t('market.title')}
        icon="spark"
        subtitle={signals.length && data?.personalized ? 'Live intelligence' : undefined}
      />

      {loading && !data ? (
        <View style={{ gap: theme.spacing.md }}>
          <Skeleton width="45%" height={11} />
          <Skeleton height={18} />
          <Skeleton width="80%" height={14} />
          <Divider />
          <Skeleton width="40%" height={11} />
          <Skeleton height={18} />
        </View>
      ) : !signals.length ? (
        <Text variant="bodySmall" color="faint">
          {data?.message || 'Market intelligence is temporarily unavailable.'}
        </Text>
      ) : (
        signals.map((s, i) => (
          <React.Fragment key={`${s.headline}-${i}`}>
            {i > 0 ? <Divider /> : null}
            <View style={{ gap: theme.spacing.xs, paddingVertical: theme.spacing.xs }}>
              <Text variant="label" color="accent">
                {s.category || 'Markets'}
              </Text>

              <Text variant="heading">{s.headline}</Text>

              {s.summary ? (
                <Text variant="bodySmall" color="muted">
                  {s.summary}
                </Text>
              ) : null}

              {/* The personalised line — why this story touches this user's
                  money. Set apart because it is the part the backend computed
                  about them, not the headline anyone would see. */}
              {s.why_it_matters ? (
                <View
                  style={{
                    marginTop: theme.spacing.xs,
                    paddingLeft: theme.spacing.md,
                    borderLeftWidth: 2,
                    borderLeftColor: theme.colors.accentBorder,
                    gap: 2,
                  }}
                >
                  <Text variant="label" color="faint">
                    {t('home.whyThisMatters')}
                  </Text>
                  <Text variant="bodySmall" color="muted">
                    {s.why_it_matters}
                  </Text>
                </View>
              ) : null}

              {s.source || s.url ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: theme.spacing.sm,
                    marginTop: theme.spacing.xs,
                  }}
                >
                  <Text variant="bodySmall" color="faint" numberOfLines={1} style={{ flex: 1 }}>
                    {s.source ?? ''}
                  </Text>
                  {s.url ? (
                    <Pressable
                      onPress={() => Linking.openURL(s.url!).catch(() => undefined)}
                      hitSlop={10}
                      accessibilityRole="link"
                      accessibilityLabel={`Read more about ${s.headline}`}
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
          </React.Fragment>
        ))
      )}
    </View>
  );
}
